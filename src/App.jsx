import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { QRCodeSVG } from 'qrcode.react'
import { isSupabaseConfigured, supabase } from './supabase'
import { decodeVapidKey, studentInitialPassword, studentLoginEmail } from './student-auth'

const statusNames = { pending: 'ยังไม่ส่ง', submitted: 'ส่งแล้ว', checking: 'รอตรวจ', checked: 'ตรวจแล้ว', returned: 'ส่งกลับแก้ไข', late: 'ส่งช้า' }
const nav = [['dashboard', '▦', 'ภาพรวม'], ['students', '♙', 'นักเรียน'], ['courses', '▧', 'รายวิชา'], ['assignments', '▤', 'งานและ QR'], ['scanner', '▣', 'สแกนรับงาน'], ['reports', '▥', 'รายงานและตรวจ']]
const emptyStudent = { student_code: '', student_name: '', class_name: '', student_number: '', status: 'active' }
const emptyAssignment = { assignment_code: '', assignment_name: '', subject: '', description: '', due_date: '', status: 'active' }
const msg = error => error?.message || 'เกิดข้อผิดพลาด'
const niceDate = value => value ? new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
async function fetchPages(queryForRange) {
  const pageSize = 1000; const rows = []
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await queryForRange(start, start + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) return rows
  }
}

const studentHeaderAliases = {
  student_code: ['studentcode', 'code', 'studentid', 'id', 'รหัสนักเรียน', 'รหัสประจำตัว', 'รหัส'],
  student_name: ['studentname', 'fullname', 'name', 'ชื่อนามสกุล', 'ชื่อสกุล', 'ชื่อ'],
  class_name: ['classname', 'class', 'room', 'grade', 'ชั้นห้อง', 'ชั้น', 'ห้อง'],
  student_number: ['studentnumber', 'number', 'no', 'เลขที่', 'ลำดับ'],
}
const normalizeStudentHeader = value => String(value ?? '').toLowerCase().replace(/[\s_./()\-]+/g, '')
function parseStudentMatrix(matrix, existingStudents) {
  const rows = (matrix || []).filter(row => row.some(value => String(value ?? '').trim() !== ''))
  if (!rows.length) return { valid: [], errors: [], total: 0 }
  const normalizedHeaders = rows[0].map(normalizeStudentHeader)
  const columns = Object.fromEntries(Object.entries(studentHeaderAliases).map(([field, aliases]) => [field, normalizedHeaders.findIndex(header => aliases.includes(header))]))
  const hasHeader = columns.student_code >= 0 && columns.student_name >= 0
  const dataRows = hasHeader ? rows.slice(1) : rows
  const existingCodes = new Set(existingStudents.map(row => String(row.student_code).trim().toLowerCase()))
  const seenCodes = new Set()
  const valid = [], errors = []
  dataRows.forEach((cells, index) => {
    const get = (field, fallback) => String(cells[hasHeader ? columns[field] : fallback] ?? '').trim()
    const student_code = get('student_code', 1)
    const student_name = get('student_name', 2)
    const class_name = get('class_name', 3)
    const numberValue = get('student_number', 0)
    const line = index + (hasHeader ? 2 : 1)
    const problems = []
    if (!student_code) problems.push('ไม่มีรหัสนักเรียน')
    if (!student_name) problems.push('ไม่มีชื่อ-นามสกุล')
    const normalizedCode = student_code.toLowerCase()
    if (student_code && existingCodes.has(normalizedCode)) problems.push('รหัสนี้มีอยู่ในระบบแล้ว')
    if (student_code && seenCodes.has(normalizedCode)) problems.push('รหัสซ้ำในไฟล์')
    const student_number = numberValue ? Number(numberValue) : null
    if (numberValue && (!Number.isInteger(student_number) || student_number < 1)) problems.push('เลขที่ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป')
    if (problems.length) errors.push({ line, code: student_code, message: problems.join(' · ') })
    else {
      seenCodes.add(normalizedCode)
      valid.push({ student_code, student_name, class_name: class_name || null, student_number, status: 'active' })
    }
  })
  return { valid, errors, total: dataRows.length }
}

function parsePastedStudentData(text) {
  const input = text.trim()
  if (!input) return []
  const delimiter = input.includes('\t') ? '\t' : ','
  const matrix = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i += 1 }
      else quoted = !quoted
    } else if (!quoted && char === delimiter) { row.push(cell); cell = '' }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(cell); matrix.push(row); row = []; cell = ''
    } else cell += char
  }
  row.push(cell)
  if (row.some(value => value.trim())) matrix.push(row)
  return matrix
}

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [page, setPage] = useState('dashboard')
  const [students, setStudents] = useState([])
  const [courses, setCourses] = useState([])
  const [assignments, setAssignments] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [search, setSearch] = useState('')
  const [assignmentFilter, setAssignmentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [modal, setModal] = useState(null)
  const [record, setRecord] = useState(null)
  const [passwordStudent, setPasswordStudent] = useState(null)
  const [mode, setMode] = useState('assignment-first')
  const [activeAssignment, setActiveAssignment] = useState('')
  const [scanStudent, setScanStudent] = useState(null)
  const [scanAssignment, setScanAssignment] = useState(null)
  const [duplicate, setDuplicate] = useState(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [studentImportOpen, setStudentImportOpen] = useState(false)
  const readerRef = useRef(null)
  const cameraRef = useRef(null)
  const scanLock = useRef(false)
  const latest = useRef({})
  latest.current = { mode, activeAssignment, scanStudent, assignments, session }

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let alive = true
    if (!session?.user) { setProfile(null); return }
    if (session.user.app_metadata?.account_type === 'student') {
      supabase.from('students').select('id,auth_user_id,student_code,student_name,class_name,student_number,qr_token,status')
        .eq('auth_user_id', session.user.id).maybeSingle()
        .then(({ data, error }) => { if (alive) setProfile(error ? { error: error.message } : data ? { ...data, role: 'student', display_name: data.student_name, active: data.status === 'active', must_change_password: session.user.app_metadata?.must_change_password === true } : { error: 'ไม่พบบัญชีนักเรียนที่เชื่อมโยงกับผู้ใช้นี้' }) })
    } else {
      supabase.from('app_users').select('display_name,role,active').eq('user_id', session.user.id).maybeSingle()
        .then(({ data, error }) => { if (alive) setProfile(error ? { error: error.message } : data) })
    }
    return () => { alive = false }
  }, [session])

  const notify = useCallback(text => { setToast(text); window.setTimeout(() => setToast(''), 3000) }, [])

  const loadAll = useCallback(async () => {
    if (!session?.user || !profile || profile.role === 'student' || profile.error || !profile.active) return
    setBusy(true)
    try {
      const [studentRows, assignmentRows, submissionRows, courseRows] = await Promise.all([
        fetchPages((from, to) => supabase.from('students').select('*').order('class_name').order('student_number').order('id').range(from, to)),
        fetchPages((from, to) => supabase.from('assignments').select('*').order('created_at', { ascending: false }).order('id').range(from, to)),
        fetchPages((from, to) => supabase.from('submissions').select('*,students(id,student_code,student_name,class_name,student_number,status),assignments(id,assignment_code,assignment_name,subject,due_date,status)').order('id').range(from, to)),
        fetchPages((from, to) => supabase.from('courses').select('*').order('course_name').range(from, to)),
      ])
      setStudents(studentRows); setAssignments(assignmentRows); setSubmissions(submissionRows); setCourses(courseRows)
    } catch (error) { notify(msg(error)) }
    finally { setBusy(false) }
  }, [session, profile, notify])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { if (page !== 'scanner') stopCamera() }, [page])
  useEffect(() => { if (page === 'scanner' && activeAssignment === '' && assignments.some(a => a.status === 'active')) setActiveAssignment(String(assignments.find(a => a.status === 'active').id)) }, [page, assignments, activeAssignment])
  useEffect(() => () => { stopCamera() }, [])

  async function signIn(event) {
    event.preventDefault(); setLoginBusy(true); setLoginError('')
    const form = new FormData(event.currentTarget)
    const identifier = String(form.get('identifier') || '').trim()
    const isStudent = !identifier.includes('@')
    const email = isStudent ? studentLoginEmail(identifier) : identifier
    const suppliedPassword = String(form.get('password') || '')
    const password = isStudent && suppliedPassword === identifier ? studentInitialPassword(identifier) : suppliedPassword
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setLoginError(error.message)
    setLoginBusy(false)
  }

  async function provisionStudentAccounts() {
    const ids = students.filter(student => student.status === 'active' && !student.auth_user_id).map(student => student.id)
    if (!ids.length) return notify('นักเรียนที่เปิดใช้งานมีบัญชีครบแล้ว')
    setBusy(true)
    let created = 0, skipped = 0
    const errors = []
    try {
      for (let start = 0; start < ids.length; start += 100) {
        const { data, error } = await supabase.functions.invoke('provision-student-accounts', { body: { student_ids: ids.slice(start, start + 100) } })
        if (error) throw error
        created += data.created || 0; skipped += data.skipped || 0; errors.push(...(data.errors || []))
      }
      await loadAll()
      const details = errors.slice(0, 2).map(item => `${item.student_code}: ${item.message}`).join(' / ')
      notify(`สร้างบัญชีแล้ว ${created} คน${skipped ? ` · ข้าม ${skipped}` : ''}${errors.length ? ` · ผิดพลาด ${errors.length}: ${details}` : ''} · รหัสผ่านเริ่มต้นคือรหัสนักเรียน`)
    } catch (error) { notify(`สร้างบัญชีไม่สำเร็จ: ${msg(error)}`) }
    finally { setBusy(false) }
  }

  async function resetStudentPassword(student, mode, password) {
    const { error } = await supabase.functions.invoke('reset-student-password', {
      body: { student_id: student.id, mode, ...(mode === 'custom' ? { password } : {}) },
    })
    if (error) throw error
    setPasswordStudent(null)
    notify(`ตั้งรหัสชั่วคราวให้ ${student.student_name} แล้ว · นักเรียนต้องเปลี่ยนรหัสหลังเข้าสู่ระบบ`)
  }

  async function changeStudentPassword(password) {
    const { error } = await supabase.functions.invoke('change-student-password', { body: { password } })
    if (error) throw error
    await signOut()
  }

  async function signOut() { stopCamera(); await supabase.auth.signOut(); setSession(null); setProfile(null) }
  function changePage(next) { setPage(next); setMenuOpen(false); setSearch('') }

  const dashboard = useMemo(() => {
    const activeStudents = students.filter(s => s.status === 'active')
    const activeAssignments = assignments.filter(a => a.status === 'active')
    const activePairs = submissions.filter(s => s.students?.status !== 'inactive' && s.assignments?.status !== 'inactive')
    return {
      students: activeStudents.length, assignments: activeAssignments.length,
      total: activePairs.length, received: activePairs.filter(s => s.status !== 'pending').length,
      pending: activePairs.filter(s => s.status === 'pending').length,
      checking: activePairs.filter(s => s.status === 'checking').length,
      checked: activePairs.filter(s => s.status === 'checked').length,
    }
  }, [students, assignments, submissions])

  const filteredStudents = students.filter(s => !search || [s.student_code, s.student_name, s.class_name].some(v => v?.toLowerCase().includes(search.toLowerCase())))
  const filteredAssignments = assignments.filter(a => !search || [a.assignment_code, a.assignment_name, a.subject, courses.find(c => c.id === a.course_id)?.course_name].some(v => v?.toLowerCase().includes(search.toLowerCase())))
  const filteredSubmissions = submissions.filter(s => {
    const text = [s.students?.student_code, s.students?.student_name, s.assignments?.assignment_code, s.assignments?.assignment_name].some(v => v?.toLowerCase().includes(search.toLowerCase()))
    return text && (!assignmentFilter || String(s.assignment_id) === assignmentFilter) && (!statusFilter || s.status === statusFilter)
  })

  async function saveStudent(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const row = { student_code: values.student_code.trim(), student_name: values.student_name.trim(), class_name: values.class_name.trim() || null, student_number: values.student_number ? Number(values.student_number) : null, course_id: Number(values.course_id), status: values.status }
    const request = record?.id ? supabase.from('students').update(row).eq('id', record.id) : supabase.from('students').insert(row)
    const { error } = await request; if (error) return notify(msg(error)); setModal(null); await loadAll(); notify('บันทึกข้อมูลนักเรียนแล้ว')
  }

  async function importStudents(rows, courseId) {
    rows = rows.map(row => ({ ...row, course_id: Number(courseId) }))
    let inserted = 0
    for (let start = 0; start < rows.length; start += 200) {
      const { error } = await supabase.from('students').insert(rows.slice(start, start + 200))
      if (error) {
        await loadAll()
        return { inserted, error: error.message }
      }
      inserted += Math.min(200, rows.length - start)
    }
    await loadAll()
    return { inserted }
  }

  async function saveAssignment(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const row = { assignment_code: values.assignment_code.trim(), assignment_name: values.assignment_name.trim(), course_id: Number(values.course_id), subject: values.subject.trim() || null, description: values.description.trim() || null, due_date: values.due_date ? new Date(values.due_date).toISOString() : null, status: values.status, ...(record?.id ? {} : { created_by: session.user.id }) }
    const request = record?.id ? supabase.from('assignments').update(row).eq('id', record.id) : supabase.from('assignments').insert(row)
    const { error } = await request; if (error) return notify(msg(error)); setModal(null); await loadAll(); notify('บันทึกงานแล้ว')
  }

  async function saveCourse(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget))
    const { error } = await supabase.from('courses').insert({ course_name: values.course_name.trim(), course_code: values.course_code.trim() || null })
    if (error) return notify(msg(error)); await loadAll(); notify('เพิ่มรายวิชาแล้ว')
  }

  async function removeCourse(course) {
    if (!window.confirm(`ยืนยันลบรายวิชา “${course.course_name}”?`)) return
    const { error } = await supabase.from('courses').delete().eq('id', course.id)
    if (error) notify(error.code === '23503' ? 'ลบไม่ได้ เพราะยังมีนักเรียนหรืองานใช้รายวิชานี้อยู่' : msg(error)); else { await loadAll(); notify('ลบรายวิชาแล้ว') }
  }

  async function removeRow(table, row) {
    if (!window.confirm('ยืนยันลบรายการนี้? รายการส่งงานที่เกี่ยวข้องจะถูกลบด้วย')) return
    const { error } = await supabase.from(table).delete().eq('id', row.id)
    if (error) notify(msg(error)); else { await loadAll(); notify('ลบรายการแล้ว') }
  }

  async function onQrDecoded(value) {
    if (scanLock.current) return
    scanLock.current = true
    try {
      const match = /^(STU|ASSIGN):([a-f\d-]{32,36})$/i.exec(value.trim())
      if (!match) throw new Error('QR ไม่ถูกต้องหรือไม่รู้จักประเภท')
      const type = match[1].toUpperCase(); const token = match[2]
      const current = latest.current
      if (current.mode === 'assignment-first' && type !== 'STU') throw new Error('โหมดนี้ต้องสแกน QR นักเรียน')
      if (current.mode === 'student-first' && ((current.scanStudent && type !== 'ASSIGN') || (!current.scanStudent && type !== 'STU'))) throw new Error(current.scanStudent ? 'กรุณาสแกน QR งาน' : 'กรุณาสแกน QR นักเรียน')
      const table = type === 'STU' ? 'students' : 'assignments'
      const { data, error } = await supabase.from(table).select('*').eq('qr_token', token).eq('status', 'active').maybeSingle()
      if (error) throw error
      if (!data) throw new Error(type === 'STU' ? 'ไม่พบนักเรียนหรือบัญชีถูกปิดใช้งาน' : 'ไม่พบงานหรือถูกปิดใช้งาน')
      if (type === 'STU') {
        setScanStudent(data)
        if (current.mode === 'assignment-first') {
          const chosen = current.assignments.find(a => String(a.id) === current.activeAssignment && a.status === 'active')
          if (!chosen) throw new Error('เลือกงานก่อนสแกนนักเรียน')
          setScanAssignment(chosen); await checkDuplicate(data, chosen)
        } else { setScanAssignment(null); setDuplicate(null) }
      } else {
        setScanAssignment(data)
        if (current.scanStudent) await checkDuplicate(current.scanStudent, data)
      }
      beep(false)
    } catch (error) { notify(msg(error)); beep(true) }
    finally { window.setTimeout(() => { scanLock.current = false }, 900) }
  }

  async function checkDuplicate(student, assignment) {
    const { data, error } = await supabase.from('submissions').select('*').eq('student_id', student.id).eq('assignment_id', assignment.id).maybeSingle()
    if (error) throw error
    const alreadyReceived = data && data.status !== 'pending'
    setDuplicate(alreadyReceived ? data : null)
    if (alreadyReceived) { notify(`งานนี้ถูกส่งแล้ว · ${statusNames[data.status]}`); beep(true) }
  }

  async function receiveSubmission() {
    if (!scanStudent || !scanAssignment || duplicate) return
    const late = scanAssignment.due_date && new Date() > new Date(scanAssignment.due_date)
    const { data: changed, error } = await supabase.from('submissions').update({ status: late ? 'late' : 'submitted', submitted_at: new Date().toISOString(), received_by: session.user.id }).eq('student_id', scanStudent.id).eq('assignment_id', scanAssignment.id).eq('status', 'pending').select('id').maybeSingle()
    if (error) return notify(msg(error))
    if (!changed) { const { data } = await supabase.from('submissions').select('*').eq('student_id', scanStudent.id).eq('assignment_id', scanAssignment.id).maybeSingle(); setDuplicate(data); return notify('งานนี้ถูกส่งแล้ว') }
    const { data: updated, error: updateError } = await supabase.from('submissions').select('*').eq('student_id', scanStudent.id).eq('assignment_id', scanAssignment.id).maybeSingle()
    if (updateError) return notify(msg(updateError))
    if (!updated || updated.status === 'pending') { setDuplicate(updated); return notify('รายการนี้ไม่มีสถานะ pending หรือส่งไปแล้ว') }
    setDuplicate(updated); beep(false); notify('รับงานและบันทึกเวลาแล้ว'); loadAll()
  }

  async function saveGrade(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const score = values.score === '' ? null : Number(values.score); const max = values.max_score === '' ? null : Number(values.max_score)
    if (score !== null && (score < 0 || (max !== null && score > max))) return notify('คะแนนไม่ถูกต้อง')
    const row = { status: values.status, score, max_score: max, remark: values.remark.trim() || null, checked_at: values.status === 'checked' ? new Date().toISOString() : record.checked_at, checked_by: values.status === 'checked' ? session.user.id : record.checked_by }
    const { error } = await supabase.from('submissions').update(row).eq('id', record.id)
    if (error) return notify(msg(error))
    let pushError = null
    if (values.status === 'checked') {
      const { error } = await supabase.functions.invoke('send-student-push', { body: { submission_id: record.id } })
      pushError = error
    }
    setModal(null); await loadAll(); notify(pushError ? `บันทึกผลแล้ว แต่ส่ง Push ไม่สำเร็จ: ${msg(pushError)}` : 'บันทึกผลตรวจแล้ว')
  }

  async function startCamera() {
    setCameraError('')
    if (!readerRef.current) return
    try {
      const scanner = new Html5Qrcode(readerRef.current.id)
      cameraRef.current = scanner
      await scanner.start({ facingMode: 'environment' }, { fps: 12, qrbox: { width: 230, height: 230 } }, onQrDecoded, () => {})
      setCameraOn(true)
    } catch (error) { setCameraError(`เปิดกล้องไม่ได้: ${msg(error)} (ต้องใช้ HTTPS และอนุญาต Camera)`); cameraRef.current = null }
  }

  async function stopCamera() {
    const scanner = cameraRef.current
    if (!scanner) return
    cameraRef.current = null
    try { if (scanner.isScanning) await scanner.stop(); scanner.clear() } catch { /* Scanner may already have stopped. */ }
    setCameraOn(false)
  }

  function resetPair() { setScanStudent(null); setScanAssignment(null); setDuplicate(null) }
  function beep(warn) { if (navigator.vibrate) navigator.vibrate(warn ? [100, 55, 100] : 60); try { const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = warn ? 220 : 740; g.gain.value = .04; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + .12) } catch { /* Audio can be unavailable or blocked. */ } }

  if (authLoading) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">กำลังตรวจสอบบัญชี…</div>
  if (!isSupabaseConfigured) return <ConfigHelp />
  if (!session) return <Login onSubmit={signIn} busy={loginBusy} error={loginError} />
  if (!profile) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">กำลังโหลดข้อมูลบัญชี…</div>
  if (profile.error || !profile.active) return <div className="grid min-h-screen place-items-center p-6"><div className="panel max-w-lg p-7 text-center"><h1 className="mb-2 text-xl font-bold">บัญชียังไม่ได้รับสิทธิ์ใช้งาน</h1><p className="muted mb-5">{session.user.app_metadata?.account_type === 'student' ? 'บัญชีนักเรียนนี้ถูกปิดใช้งานหรือยังไม่ได้เชื่อมกับรายชื่อ' : <>เพิ่ม UUID บัญชีนี้ในตาราง <code>public.app_users</code> ผ่าน SQL Editor ของ Supabase</>}</p><button className="primary" onClick={signOut}>ออกจากระบบ</button></div></div>
  if (profile.role === 'student' && profile.must_change_password) return <ChangeStudentPassword onSave={changeStudentPassword} />
  if (profile.role === 'student') return <StudentPortal profile={profile} userId={session.user.id} onSignOut={signOut} notify={notify} />

  return <div className="min-h-screen">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <a className="brand" href="#dashboard" onClick={e => { e.preventDefault(); changePage('dashboard') }}><span className="brand-mark">S</span><span>StudentSend<small>CLASSROOM WORKFLOW</small></span></a>
      <nav className="grid gap-1">{nav.map(([key, icon, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => changePage(key)}><span>{icon}</span><span>{label}</span></button>)}</nav>
      <div className="mt-auto flex items-center gap-2 border-t border-slate-100 px-1 pt-4"><span className="grid h-9 w-9 place-items-center rounded-full bg-orange-100 font-bold text-orange-700">{(profile.display_name || 'T')[0]}</span><span className="min-w-0 flex-1 truncate text-xs font-semibold">{profile.display_name}<small className="block text-[10px] font-normal text-slate-400">{profile.role === 'admin' ? 'Administrator' : 'Teacher'}</small></span><button className="p-2 text-slate-500" title="ออกจากระบบ" onClick={signOut}>↗</button></div>
    </aside>
    {menuOpen && <button className="fixed inset-0 z-[8] bg-slate-900/20 md:hidden" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} />}
    <main className="main">
      <header className="topbar"><button className="mr-3 rounded p-2 md:hidden" onClick={() => setMenuOpen(true)}>☰</button><div><span className="eyebrow">CLASSROOM MANAGEMENT</span><strong>{{ dashboard: 'ภาพรวม', students: 'นักเรียน', courses: 'รายวิชา', assignments: 'งานและ QR', scanner: 'สแกนรับงาน', reports: 'รายงานและตรวจ' }[page]}</strong></div><span className="text-xs text-slate-500">{new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></header>
      <div className="content">
        {page === 'dashboard' && <Dashboard stats={dashboard} assignments={assignments.filter(a => a.status === 'active')} submissions={submissions} busy={busy} go={changePage} />}
        {page === 'students' && <Students rows={filteredStudents} courses={courses} search={search} setSearch={setSearch} add={() => { setRecord(null); setModal('student') }} bulkImport={() => setStudentImportOpen(true)} provision={provisionStudentAccounts} busy={busy} edit={s => { setRecord(s); setModal('student') }} resetPassword={setPasswordStudent} remove={s => removeRow('students', s)} />}
        {page === 'courses' && <Courses rows={courses} add={saveCourse} remove={removeCourse} />}
        {page === 'assignments' && <Assignments rows={filteredAssignments} courses={courses} search={search} setSearch={setSearch} add={() => { setRecord(null); setModal('assignment') }} edit={a => { setRecord(a); setModal('assignment') }} remove={a => removeRow('assignments', a)} />}
        {page === 'scanner' && <Scanner mode={mode} setMode={m => { setMode(m); resetPair() }} assignments={assignments.filter(a => a.status === 'active')} selected={activeAssignment} setSelected={setActiveAssignment} student={scanStudent} assignment={scanAssignment} duplicate={duplicate} receive={receiveSubmission} reset={resetPair} readerRef={readerRef} cameraOn={cameraOn} start={startCamera} stop={stopCamera} error={cameraError} />}
        {page === 'reports' && <Reports rows={filteredSubmissions} search={search} setSearch={setSearch} assignmentFilter={assignmentFilter} setAssignmentFilter={setAssignmentFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} assignments={assignments} edit={s => { setRecord(s); setModal('grade') }} />}
      </div>
    </main>
    {modal && <Editor type={modal} record={record} courses={courses} close={() => setModal(null)} save={modal === 'student' ? saveStudent : modal === 'assignment' ? saveAssignment : saveGrade} />}
    {studentImportOpen && <BulkStudentImport existingStudents={students} courses={courses} close={() => setStudentImportOpen(false)} onImport={importStudents} />}
    {passwordStudent && <StudentPasswordReset student={passwordStudent} close={() => setPasswordStudent(null)} onSubmit={resetStudentPassword} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>
}

function ConfigHelp() { return <div className="login-shell"><div className="login-card"><span className="brand-mark mb-5">S</span><p className="eyebrow">SUPABASE SETUP</p><h1 className="mb-2 text-2xl font-bold">ตั้งค่าการเชื่อมต่อ</h1><p className="muted mb-5">คัดลอก <code>.env.example</code> เป็น <code>.env.local</code> แล้วใส่ Supabase Project URL และ Publishable Key จากหน้า Connect ของโปรเจกต์</p><code className="block rounded-lg bg-slate-50 p-3 text-xs">VITE_SUPABASE_URL=…<br/>VITE_SUPABASE_PUBLISHABLE_KEY=…</code></div></div> }
function Login({ onSubmit, busy, error }) { return <div className="login-shell"><form className="login-card" onSubmit={onSubmit}><span className="brand-mark mb-5">S</span><p className="eyebrow">SCHOOLS · SIMPLE · SECURE</p><h1 className="mb-1 text-3xl font-bold">StudentSend</h1><p className="muted mb-6">เข้าสู่ระบบสำหรับครูและนักเรียน</p><label className="mb-3 grid gap-2 text-xs font-semibold">อีเมลครู หรือรหัสนักเรียน<input className="field" type="text" name="identifier" required autoComplete="username" placeholder="อีเมลครู / รหัสนักเรียน" /></label><label className="mb-4 grid gap-2 text-xs font-semibold">รหัสผ่าน<input className="field" type="password" name="password" required autoComplete="current-password" /></label><p className="muted mb-3">ครูใช้บัญชีอีเมล · นักเรียนใช้รหัสนักเรียน (เข้าครั้งแรกใช้รหัสเดียวกันเป็นรหัสผ่าน)</p>{error && <p className="mb-3 text-xs text-red-600">{error}</p>}<button className="primary w-full" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button></form></div> }

function ChangeStudentPassword({ onSave }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setError('')
    const values = new FormData(event.currentTarget)
    const password = String(values.get('password') || '')
    if (password.length < 8) return setError('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร')
    if (password !== values.get('confirm')) return setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
    setBusy(true)
    try { await onSave(password) } catch (cause) { setError(msg(cause)) }
    finally { setBusy(false) }
  }
  return <div className="login-shell"><form className="login-card" onSubmit={submit}><span className="brand-mark mb-5">S</span><p className="eyebrow">FIRST SIGN-IN</p><h1 className="mb-2 text-2xl font-bold">ตั้งรหัสผ่านใหม่</h1><p className="muted mb-5">เพื่อความปลอดภัย กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน</p><label className="mb-3 grid gap-2 text-xs font-semibold">รหัสผ่านใหม่<input className="field" type="password" name="password" minLength="8" required autoComplete="new-password" /></label><label className="mb-4 grid gap-2 text-xs font-semibold">ยืนยันรหัสผ่าน<input className="field" type="password" name="confirm" minLength="8" required autoComplete="new-password" /></label>{error && <p className="mb-3 text-xs text-red-600">{error}</p>}<button className="primary w-full" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'ตั้งรหัสผ่านและออกจากระบบ'}</button></form></div>
}

function StudentPortal({ profile, userId, onSignOut, notify }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [banner, setBanner] = useState('')
  const [showQr, setShowQr] = useState(false)
  const [sound, setSound] = useState(() => localStorage.getItem(`studentsend-sound-${userId}`) || 'chime')
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(`studentsend-volume-${userId}`) || 65))
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState('')
  const [initialLoaded, setInitialLoaded] = useState(false)
  const seenCheckedAt = useRef(new Map())

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('submissions')
      .select('id,status,submitted_at,checked_at,score,max_score,remark,attachment_path,attachment_name,submission_note,assignment_id,assignments(assignment_code,assignment_name,subject,due_date,status)')
      .eq('student_id', profile.id).order('assignment_id', { ascending: false })
    if (error) { notify(msg(error)); setRows([]) }
    else {
      setRows(data || [])
      seenCheckedAt.current = new Map((data || []).filter(row => row.status === 'checked' && row.checked_at).map(row => [row.id, row.checked_at]))
    }
    setInitialLoaded(true)
    setLoading(false)
  }, [profile.id, notify])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    localStorage.setItem(`studentsend-sound-${userId}`, sound)
    localStorage.setItem(`studentsend-volume-${userId}`, String(volume))
  }, [sound, volume, userId])
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription()).then(subscription => setPushEnabled(!!subscription)).catch(() => {})
  }, [])
  useEffect(() => {
    if (!initialLoaded) return
    const channel = supabase.channel(`student-submissions-${profile.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'submissions', filter: `student_id=eq.${profile.id}` }, payload => {
        const row = payload.new
        if (row.status === 'checked' && row.checked_at && seenCheckedAt.current.get(row.id) !== row.checked_at) {
          seenCheckedAt.current.set(row.id, row.checked_at)
          setBanner('ครูตรวจงานของคุณเรียบร้อยแล้ว')
          playStudentAlert(sound, volume)
          if ('Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then(registration => registration.showNotification('ตรวจงานเรียบร้อยแล้ว', { body: 'เปิด StudentSend เพื่อดูคะแนนและความคิดเห็น', icon: '/icon.svg', tag: `submission-${row.id}` })).catch(() => {})
          reload()
        }
      }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile.id, reload, sound, volume, initialLoaded])

  async function togglePush() {
    setPushBusy(true); setPushError('')
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Push')
      const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
      if (!publicKey) throw new Error('ยังไม่ได้ตั้ง VITE_VAPID_PUBLIC_KEY ใน Cloudflare Build Variables')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('กรุณาอนุญาตการแจ้งเตือนในเบราว์เซอร์')
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        const keys = subscription.toJSON().keys
        const { error } = await supabase.from('student_push_subscriptions').upsert({ endpoint: subscription.endpoint, user_id: userId, p256dh: keys.p256dh, auth_secret: keys.auth }, { onConflict: 'endpoint' })
        if (error) throw error
      } else {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(publicKey) })
        const keys = subscription.toJSON().keys
        const { error } = await supabase.from('student_push_subscriptions').upsert({ endpoint: subscription.endpoint, user_id: userId, p256dh: keys.p256dh, auth_secret: keys.auth }, { onConflict: 'endpoint' })
        if (error) { await subscription.unsubscribe(); throw error }
      }
      setPushEnabled(true)
      notify('เปิดรับการแจ้งเตือนแล้ว')
    } catch (error) { setPushError(msg(error)) }
    finally { setPushBusy(false) }
  }

  async function disablePush() {
    setPushBusy(true); setPushError('')
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        const { error } = await supabase.from('student_push_subscriptions').delete().eq('endpoint', subscription.endpoint)
        if (error) throw error
        await subscription.unsubscribe()
      }
      setPushEnabled(false)
    } catch (error) { setPushError(msg(error)) }
    finally { setPushBusy(false) }
  }

  const pending = rows.filter(row => ['pending', 'returned'].includes(row.status)).length
  const checked = rows.filter(row => row.status === 'checked')
  const totalScore = checked.reduce((sum, row) => sum + Number(row.score || 0), 0)
  const totalMax = checked.reduce((sum, row) => sum + Number(row.max_score || 0), 0)
  const filtered = rows.filter(row => filter === 'all' || (filter === 'pending' ? ['pending', 'returned'].includes(row.status) : filter === 'checked' ? row.status === 'checked' : ['submitted', 'checking', 'late'].includes(row.status)))

  return <div className="min-h-screen"><header className="topbar !ml-0"><div><span className="eyebrow">STUDENT PORTAL</span><strong>สวัสดี {profile.student_name}</strong></div><button className="secondary" onClick={onSignOut}>ออกจากระบบ</button></header><main className="mx-auto grid max-w-5xl gap-4 p-4 sm:p-6">
    {banner && <div className="flex items-center justify-between rounded-xl bg-teal-700 p-4 text-sm font-semibold text-white shadow-lg" role="status"><span>🔔 {banner}</span><button onClick={() => setBanner('')} aria-label="ปิดแบนเนอร์">×</button></div>}
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4"><StudentStat label="งานที่ได้รับ" value={rows.length} /><StudentStat label="ค้างส่ง" value={pending} /><StudentStat label="ตรวจแล้ว" value={checked.length} /><StudentStat label="คะแนนรวม" value={`${totalScore} / ${totalMax}`} /></section>
    <section className="panel p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="m-0 text-base font-bold">ส่งงานด้วย QR</h2><p className="muted mt-1">แสดง QR นี้ให้ครูสแกนเมื่อนำงานมาส่ง</p></div><button className="secondary" onClick={() => setShowQr(!showQr)}>{showQr ? 'ซ่อน QR' : 'แสดง QR ของฉัน'}</button></div>{showQr && <div className="mt-4 grid justify-items-center gap-2 rounded-lg bg-slate-50 p-4"><QRCodeSVG value={`STU:${profile.qr_token}`} size={190} /><b>{profile.student_code} · {profile.student_name}</b></div>}</section>
    <section className="panel p-4 sm:p-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="m-0 text-base font-bold">แจ้งเตือน</h2><p className="muted mt-1">รับแจ้งเมื่อครูตรวจงานเสร็จ</p></div><button className="secondary" disabled={pushBusy} onClick={pushEnabled ? disablePush : togglePush}>{pushBusy ? 'กำลังตั้งค่า…' : pushEnabled ? 'ปิด Push Notification' : 'เปิด Push Notification'}</button></div><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="grid gap-1 text-xs font-semibold">เสียงแจ้งเตือน<select className="field" value={sound} onChange={event => setSound(event.target.value)}><option value="chime">กระดิ่ง</option><option value="bell">เสียงเตือน</option><option value="pop">ป๊อป</option><option value="none">ปิดเสียง</option></select></label><label className="grid gap-1 text-xs font-semibold">ระดับเสียง {volume}%<input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} /></label><button className="secondary" onClick={() => playStudentAlert(sound, volume)}>ทดลองเสียง</button></div>{pushError && <p className="mt-3 text-xs text-red-600">{pushError}</p>}<p className="mt-3 text-[10px] leading-5 text-slate-500">เสียงที่เลือกและระดับเสียงใช้เมื่อเปิด StudentSend อยู่ ส่วนเสียง Push ขณะปิดแอปจะขึ้นกับการตั้งค่าของอุปกรณ์</p></section>
    <section className="panel"><div className="toolbar flex-wrap">{[['all', 'ทั้งหมด'], ['pending', 'ค้างส่ง'], ['waiting', 'ส่งแล้ว / รอตรวจ'], ['checked', 'ตรวจแล้ว']].map(([key, label]) => <button key={key} className={`secondary ${filter === key ? '!border-teal-500 !text-teal-800' : ''}`} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="grid gap-3 p-3 sm:p-4">{loading ? <p className="empty">กำลังโหลดงาน…</p> : filtered.length ? filtered.map(row => <StudentSubmission key={row.id} row={row} onDone={reload} />) : <p className="empty">ไม่มีรายการในหมวดนี้</p>}</div></section>
  </main></div>
}

function StudentStat({ label, value }) { return <article className="stat !min-h-0 !p-3 sm:!p-4"><span className="text-xs font-semibold text-slate-500">{label}</span><strong className="!my-2 !text-xl sm:!text-2xl">{value}</strong></article> }

function StudentSubmission({ row, onDone }) {
  const [file, setFile] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canSubmit = ['pending', 'returned'].includes(row.status)

  function chooseFile(event) {
    setFile(event.target.files?.[0] || null)
    event.target.value = ''
  }

  async function submit(event) {
    event.preventDefault(); setError('')
    if (!file && !note.trim()) return setError('เลือกไฟล์หรือเขียนข้อความก่อนส่ง')
    if (file && file.size > 25 * 1024 * 1024) return setError('ไฟล์ต้องมีขนาดไม่เกิน 25 MB')
    setBusy(true)
    let path = null
    try {
      if (file) {
        const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin'
        path = `${(await supabase.auth.getUser()).data.user.id}/${row.id}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage.from('student-submissions').upload(path, file, { contentType: file.type || undefined, upsert: false })
        if (uploadError) throw uploadError
      }
      const { error: submitError } = await supabase.rpc('submit_student_work', { p_submission_id: row.id, p_attachment_path: path, p_attachment_name: file?.name || null, p_submission_note: note })
      if (submitError) {
        if (path) await supabase.storage.from('student-submissions').remove([path])
        throw submitError
      }
      setFile(null); setNote(''); await onDone()
    } catch (cause) { setError(msg(cause)) }
    finally { setBusy(false) }
  }

  return <article className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><span className="eyebrow">{row.assignments?.subject || 'งานที่ได้รับ'}</span><h3 className="m-0 text-sm font-bold">{row.assignments?.assignment_name || 'งาน'}</h3><p className="muted mt-1">{row.assignments?.assignment_code} · กำหนดส่ง {niceDate(row.assignments?.due_date)}</p></div><Pill value={row.status} /></div>
    {row.status === 'checked' && <div className="mt-3 rounded-lg bg-green-50 p-3 text-sm"><b>คะแนน {row.score ?? '—'} / {row.max_score ?? '—'}</b>{row.remark && <p className="mt-1 text-xs text-slate-700">{row.remark}</p>}</div>}
    {row.submission_note && <p className="mt-3 text-xs text-slate-600">ข้อความส่งงาน: {row.submission_note}</p>}
    {row.attachment_path && <div className="mt-3"><StudentWorkLink path={row.attachment_path} name={row.attachment_name || 'ไฟล์งาน'} /></div>}
    {canSubmit && <form className="mt-4 grid gap-3 border-t border-slate-100 pt-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold">ถ่ายภาพงานด้วยกล้อง<input className="field" type="file" accept="image/*" capture="environment" onChange={chooseFile} /></label>
        <label className="grid gap-1 text-xs font-semibold">เลือกไฟล์จากอุปกรณ์<input className="field" type="file" accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt" onChange={chooseFile} /></label>
      </div>
      {file && <p className="muted">ไฟล์ที่เลือก: {file.name} · {(file.size / 1048576).toFixed(1)} MB</p>}
      <label className="grid gap-1 text-xs font-semibold">ข้อความถึงครู<textarea className="field" rows="2" value={note} onChange={event => setNote(event.target.value)} placeholder="หมายเหตุหรือส่งคำตอบเป็นข้อความ" /></label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button className="primary justify-self-start" disabled={busy}>{busy ? 'กำลังส่ง…' : row.status === 'returned' ? 'ส่งแก้ไขให้ครู' : 'ส่งงานให้ครูตรวจ'}</button>
    </form>}
    {!canSubmit && row.submitted_at && <p className="muted mt-3">ส่งเมื่อ {niceDate(row.submitted_at)}{row.checked_at ? ` · ตรวจเมื่อ ${niceDate(row.checked_at)}` : ''}</p>}
  </article>
}

function StudentWorkLink({ path, name }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { supabase.storage.from('student-submissions').createSignedUrl(path, 300).then(({ data, error: linkError }) => { if (linkError) setError(linkError.message); else setUrl(data.signedUrl) }) }, [path])
  return error ? <span className="text-xs text-red-600">เปิดไฟล์ไม่ได้: {error}</span> : url ? <a className="text-xs font-semibold text-teal-700 underline" href={url} target="_blank" rel="noreferrer">เปิดไฟล์: {name}</a> : <span className="text-xs text-slate-500">กำลังเตรียมไฟล์…</span>
}

function playStudentAlert(sound, volume) {
  if (sound === 'none' || volume <= 0) return
  try {
    const context = new AudioContext()
    const gain = context.createGain(); gain.connect(context.destination)
    gain.gain.setValueAtTime(Math.max(0.001, volume / 100 * 0.22), context.currentTime)
    const tones = sound === 'bell' ? [880, 660, 880] : sound === 'pop' ? [740] : [523, 659, 784]
    tones.forEach((frequency, index) => {
      const oscillator = context.createOscillator(); oscillator.type = sound === 'pop' ? 'sine' : 'triangle'; oscillator.frequency.value = frequency
      const start = context.currentTime + index * 0.13
      oscillator.connect(gain); oscillator.start(start); oscillator.stop(start + 0.1)
    })
    window.setTimeout(() => context.close(), tones.length * 150 + 200)
  } catch { /* Browser audio may require an earlier user gesture. */ }
}

function Heading({ eyebrow, title, subtitle, action }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>{action}</div> }
function Dashboard({ stats, assignments, submissions, busy, go }) {
  const cards = [['นักเรียนทั้งหมด', stats.students, 'รายชื่อที่เปิดใช้งาน', '♙'], ['งานทั้งหมด', stats.assignments, 'งานที่กำลังใช้งาน', '▤'], ['ส่งแล้ว', stats.received, `จาก ${stats.total} รายการ`, '✓'], ['ยังไม่ส่ง', stats.pending, 'ติดตามได้จากรายงาน', '◷'], ['รอตรวจ', stats.checking, 'รายการที่ต้องตรวจ', '⌕'], ['ตรวจแล้ว', stats.checked, 'บันทึกผลแล้ว', '★']]
  return <><Heading eyebrow="YOUR CLASS AT A GLANCE" title="ภาพรวมการส่งงาน" subtitle="ติดตามความคืบหน้าของนักเรียนและงานทั้งหมด" action={<button className="primary" onClick={() => go('scanner')}>＋ รับงานด้วย QR</button>} /><div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">{cards.map(([label, number, note, icon], i) => <article className="stat" key={label}><span className={`mb-3 grid h-9 w-9 place-items-center rounded-xl text-lg ${['bg-teal-50 text-teal-700', 'bg-orange-50 text-orange-600', 'bg-sky-50 text-sky-700', 'bg-rose-50 text-rose-600', 'bg-violet-50 text-violet-600', 'bg-green-50 text-green-700'][i]}`}>{icon}</span><span className="text-xs font-semibold text-slate-500">{label}</span><strong>{Number(number || 0).toLocaleString()}</strong><small>{note}</small></article>)}</div><section className="panel"><div className="panel-head"><div><h2>ความคืบหน้ารายงาน</h2><p className="muted">สถานะการส่งของนักเรียนในแต่ละงาน</p></div><button className="text-button" onClick={() => go('reports')}>ดูรายงานทั้งหมด →</button></div><div className="table-wrap"><table><thead><tr><th>งาน</th><th>วิชา</th><th>กำหนดส่ง</th><th>ส่งแล้ว</th><th>ยังไม่ส่ง</th><th>ความคืบหน้า</th></tr></thead><tbody>{assignments.length ? assignments.map(a => { const list = submissions.filter(s => s.assignment_id === a.id), done = list.filter(s => s.status !== 'pending').length, pending = list.length - done, pct = list.length ? Math.round(done / list.length * 100) : 0; return <tr key={a.id}><td><b>{a.assignment_name}</b><small>{a.assignment_code}</small></td><td>{a.subject || '—'}</td><td>{niceDate(a.due_date)}</td><td>{done}</td><td>{pending}</td><td><div className="inline-flex items-center gap-2"><span className="h-1.5 w-24 overflow-hidden rounded bg-slate-100"><i className="block h-full rounded bg-teal-700" style={{ width: `${pct}%` }} /></span><small>{pct}%</small></div></td></tr> }) : <tr><td className="empty" colSpan="6">{busy ? 'กำลังโหลด…' : 'ยังไม่มีงาน ลองสร้างงานแรกของคุณ'}</td></tr>}</tbody></table></div></section></>
}

function Students({ rows, courses, search, setSearch, add, bulkImport, provision, busy, edit, resetPassword, remove }) { return <><Heading eyebrow="STUDENT DIRECTORY" title="นักเรียน" subtitle="จัดการข้อมูลประจำตัว พิมพ์ QR และตั้งรหัสผ่านชั่วคราวให้นักเรียน" action={<div className="flex flex-wrap gap-2"><button className="secondary" onClick={provision} disabled={busy}>♙ สร้างบัญชีนักเรียน</button><button className="secondary" onClick={bulkImport}>⇧ นำเข้าหลายคน</button><button className="primary" onClick={add}>＋ เพิ่มนักเรียน</button></div>} /><section className="panel"><div className="toolbar"><input className="field flex-1" placeholder="ค้นหารหัส ชื่อ หรือห้องเรียน…" value={search} onChange={e => setSearch(e.target.value)} /><button className="secondary" onClick={() => printCards(rows, 'student')}>▧ พิมพ์ QR</button></div><div className="table-wrap"><table><thead><tr><th>เลขที่</th><th>รหัสนักเรียน</th><th>ชื่อ-สกุล</th><th>ชั้น</th><th>รายวิชา</th><th>ส่งแล้ว</th><th>สถานะ</th><th /></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td>{s.student_number || '—'}</td><td><b>{s.student_code}</b></td><td>{s.student_name}</td><td>{s.class_name || '—'}</td><td>{courses.find(c => c.id === s.course_id)?.course_name || 'ยังไม่กำหนด'}</td><td>—</td><td><Pill value={s.status} /></td><td className="row-actions"><button onClick={() => edit(s)}>แก้ไข</button><button onClick={() => resetPassword(s)} disabled={!s.auth_user_id} title={s.auth_user_id ? 'ตั้งหรือรีเซ็ตรหัสผ่าน' : 'สร้างบัญชีนักเรียนก่อน'}>ตั้งรหัสผ่าน</button><button className="danger" onClick={() => remove(s)}>ลบ</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ไม่พบนักเรียน</p>}</div></section></> }

function Courses({ rows, add, remove }) { return <><Heading eyebrow="COURSE MANAGEMENT" title="รายวิชา" subtitle="เพิ่มรายวิชาที่เลือกได้ตอนลงทะเบียนนักเรียนและสร้างงาน" /><section className="panel p-5"><form className="mb-5 grid gap-3 sm:grid-cols-[1fr_2fr_auto]" onSubmit={add}><label className="grid gap-1 text-xs font-semibold">รหัสวิชา (ไม่บังคับ)<input className="field" name="course_code" placeholder="เช่น TH101" /></label><label className="grid gap-1 text-xs font-semibold">ชื่อรายวิชา<input className="field" name="course_name" required placeholder="เช่น ภาษาไทย" /></label><button className="primary self-end">＋ เพิ่มรายวิชา</button></form><div className="table-wrap"><table><thead><tr><th>รหัสวิชา</th><th>รายวิชา</th><th /></tr></thead><tbody>{rows.map(course => <tr key={course.id}><td>{course.course_code || '—'}</td><td><b>{course.course_name}</b></td><td className="row-actions"><button className="danger" onClick={() => remove(course)}>ลบ</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ยังไม่มีรายวิชา</p>}</div></section></> }

function StudentPasswordReset({ student, close, onSubmit }) {
  const [mode, setMode] = useState('student_code')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault(); setError('')
    const values = new FormData(event.currentTarget)
    const password = String(values.get('password') || '')
    const confirm = String(values.get('confirm') || '')
    if (mode === 'custom' && password !== confirm) return setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
    setBusy(true)
    try { await onSubmit(student, mode, password) }
    catch (cause) { setError(cause?.message || 'ตั้งรหัสผ่านไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}><form className="modal" onSubmit={submit}><div className="modal-head"><div><p className="eyebrow">STUDENT ACCOUNT</p><h2 className="m-0 text-lg font-bold">ตั้งรหัสผ่านชั่วคราว</h2><p className="muted mt-1">{student.student_code} · {student.student_name}</p></div><button type="button" className="text-xl text-slate-500" disabled={busy} onClick={close}>×</button></div><div className="modal-body grid gap-4"><p className="muted">ระบบไม่สามารถแสดงรหัสเดิมได้ เพราะ Supabase เก็บเป็น hash เมื่อรีเซ็ตแล้ว นักเรียนต้องตั้งรหัสใหม่หลังเข้าสู่ระบบ</p><label className="flex items-start gap-2 text-sm"><input type="radio" name="reset-mode" checked={mode === 'student_code'} onChange={() => setMode('student_code')} /><span>ตั้งรหัสชั่วคราวให้เหมือนรหัสนักเรียน <b>{student.student_code}</b></span></label><label className="flex items-start gap-2 text-sm"><input type="radio" name="reset-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} /><span>กำหนดรหัสชั่วคราวเอง (อย่างน้อย 6 ตัว)</span></label>{mode === 'custom' && <><label className="grid gap-2 text-xs font-semibold">รหัสชั่วคราว<input className="field" type="password" name="password" minLength="6" required autoComplete="new-password" /></label><label className="grid gap-2 text-xs font-semibold">ยืนยันรหัสชั่วคราว<input className="field" type="password" name="confirm" minLength="6" required autoComplete="new-password" /></label></>}{error && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}</div><div className="modal-foot"><button type="button" className="secondary" disabled={busy} onClick={close}>ยกเลิก</button><button className="primary" disabled={busy}>{busy ? 'กำลังตั้งรหัส…' : 'บันทึกรหัสชั่วคราว'}</button></div></form></div>
}

function BulkStudentImport({ existingStudents, courses, close, onImport }) {
  const [pasted, setPasted] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [courseId, setCourseId] = useState('')

  function showPreview(matrix) {
    setError('')
    const result = parseStudentMatrix(matrix, existingStudents)
    if (!result.total) { setPreview(null); setError('ไม่พบแถวข้อมูล กรุณาตรวจไฟล์หรือวางข้อมูลก่อน'); return }
    setPreview(result)
  }

  async function readFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      showPreview(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }))
    } catch {
      setError('อ่านไฟล์ไม่ได้ กรุณาใช้ .xlsx, .xls, .csv หรือ .tsv')
    }
    event.target.value = ''
  }

  async function save() {
    if (!preview?.valid.length || !courseId || busy) return
    setBusy(true); setError('')
    try {
      const result = await onImport(preview.valid, courseId)
      if (result.error) {
        setError(`เพิ่มแล้ว ${result.inserted} คน แต่มีข้อผิดพลาด: ${result.error}`)
        if (result.inserted) setPreview(null)
        return
      }
      close()
    } catch (cause) { setError(cause?.message || 'นำเข้าข้อมูลไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}><section className="modal" style={{ width: 'min(900px, 100%)' }}><div className="modal-head"><div><p className="eyebrow">BULK IMPORT</p><h2 className="m-0 text-lg font-bold">นำเข้านักเรียนหลายคน</h2></div><button className="text-xl text-slate-500" disabled={busy} onClick={close}>×</button></div><div className="modal-body grid gap-4">
    <p className="muted">เลือกไฟล์ Excel/CSV หรือคัดลอกตารางจาก Google Sheets แล้ววางด้านล่าง ระบบอ่านชีตแรกและตรวจรหัสซ้ำก่อนบันทึก</p>
    <label className="grid gap-2 text-xs font-semibold">รายวิชาสำหรับนักเรียนที่นำเข้าทั้งชุด<select className="field" required value={courseId} onChange={event => setCourseId(event.target.value)}><option value="">เลือกรายวิชา</option>{courses.map(course => <option key={course.id} value={course.id}>{course.course_name}</option>)}</select></label>
    <label className="grid gap-2 text-xs font-semibold">เลือกไฟล์ Excel หรือ CSV<input className="field" type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" onChange={readFile} /></label>
    <div><label className="mb-2 grid gap-2 text-xs font-semibold">หรือวางข้อมูลจาก Google Sheets<textarea className="field font-mono" rows="5" placeholder={'เลขที่\tรหัสนักเรียน\tชื่อ-สกุล\tชั้น\n1\t65001\tด.ช. ตัวอย่าง ใจดี\tม.1/1'} value={pasted} onChange={event => setPasted(event.target.value)} /></label><button className="secondary" onClick={() => showPreview(parsePastedStudentData(pasted))}>ตรวจข้อมูลที่วาง</button></div>
    <p className="text-[11px] leading-5 text-slate-500">เรียงคอลัมน์เป็น เลขที่, รหัสนักเรียน, ชื่อ-สกุล, ชั้น (รหัสและชื่อจำเป็น) · รองรับหัวตารางภาษาไทย/อังกฤษ หรือไม่มีหัวตาราง</p>
    {error && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
    {preview && <div className="grid gap-3"><div className="flex flex-wrap gap-x-5 gap-y-1 text-xs"><b className="text-teal-800">พร้อมนำเข้า {preview.valid.length} คน</b><span className="text-red-600">รายการที่ต้องแก้/ข้าม {preview.errors.length} แถว</span></div>{preview.valid.length > 0 && <div className="max-h-52 overflow-auto rounded-lg border border-slate-200"><table><thead><tr><th>เลขที่</th><th>รหัสนักเรียน</th><th>ชื่อ-สกุล</th><th>ชั้น</th></tr></thead><tbody>{preview.valid.slice(0, 100).map((row, index) => <tr key={`${row.student_code}-${index}`}><td>{row.student_number || '—'}</td><td>{row.student_code}</td><td>{row.student_name}</td><td>{row.class_name || '—'}</td></tr>)}</tbody></table>{preview.valid.length > 100 && <p className="p-2 text-center text-xs text-slate-500">แสดงตัวอย่าง 100 รายการแรก จาก {preview.valid.length} คน</p>}</div>}{preview.errors.length > 0 && <div className="max-h-28 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-700">{preview.errors.slice(0, 20).map(item => <p key={`${item.line}-${item.code}`}>แถว {item.line}{item.code ? ` · ${item.code}` : ''}: {item.message}</p>)}{preview.errors.length > 20 && <p>และอีก {preview.errors.length - 20} แถว</p>}</div>}</div>}
    </div><div className="modal-foot"><button className="secondary" disabled={busy} onClick={close}>ยกเลิก</button><button className="primary" disabled={busy || !preview?.valid.length || !courseId} onClick={save}>{busy ? 'กำลังนำเข้า…' : `นำเข้า ${preview?.valid.length || 0} คน`}</button></div></section></div>
}
function Assignments({ rows, courses, search, setSearch, add, edit, remove }) { return <><Heading eyebrow="ASSIGNMENT LIBRARY" title="งานและ QR" subtitle="เลือกวิชาให้งาน เพื่อสร้างรายการส่งเฉพาะนักเรียนในวิชานั้น" action={<button className="primary" onClick={add}>＋ สร้างงาน</button>} /><section className="panel"><div className="toolbar"><input className="field flex-1" placeholder="ค้นหารหัสงาน ชื่องาน หรือวิชา…" value={search} onChange={e => setSearch(e.target.value)} /><button className="secondary" onClick={() => printCards(rows, 'assignment')}>▧ พิมพ์ QR งาน</button></div><div className="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่องาน</th><th>รายวิชา</th><th>หัวข้อย่อย</th><th>กำหนดส่ง</th><th>สถานะ</th><th /></tr></thead><tbody>{rows.map(a => <tr key={a.id}><td><b>{a.assignment_code}</b></td><td>{a.assignment_name}</td><td>{courses.find(c => c.id === a.course_id)?.course_name || 'วิชาเดิม/ไม่ระบุ'}</td><td>{a.subject || '—'}</td><td>{niceDate(a.due_date)}</td><td><Pill value={a.status} /></td><td className="row-actions"><button onClick={() => printCards([a], 'assignment')}>QR</button><button onClick={() => edit(a)}>แก้ไข</button><button className="danger" onClick={() => remove(a)}>ลบ</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ยังไม่มีงาน</p>}</div></section></> }

function Scanner({ mode, setMode, assignments, selected, setSelected, student, assignment, duplicate, receive, reset, readerRef, cameraOn, start, stop, error }) {
  return <><Heading eyebrow="FAST CHECK-IN" title="สแกนรับงาน" subtitle="เลือกงานเพื่อสแกนนักเรียนต่อเนื่อง หรือสแกนนักเรียนก่อน" /><div className="grid items-start gap-4 lg:grid-cols-2"><section className="panel p-5"><div className="mode-tabs"><button className={mode === 'assignment-first' ? 'active' : ''} onClick={() => setMode('assignment-first')}>เลือกงานก่อน</button><button className={mode === 'student-first' ? 'active' : ''} onClick={() => setMode('student-first')}>นักเรียนก่อน</button></div>{mode === 'assignment-first' && <label className="mb-3 grid gap-2 text-xs font-semibold">กำลังรับงาน<select className="field" value={selected} onChange={e => setSelected(e.target.value)}><option value="">เลือกงาน</option>{assignments.map(a => <option value={a.id} key={a.id}>{a.assignment_code} · {a.assignment_name}</option>)}</select></label>}<div id="reader" ref={readerRef} /><div className="flex gap-2"><button className="primary flex-1" onClick={start} disabled={cameraOn}>เปิดกล้อง</button><button className="secondary flex-1" onClick={stop} disabled={!cameraOn}>หยุด</button></div>{error && <p className="mt-3 text-xs text-red-600">{error}</p>}<p className="mt-3 text-[10px] leading-5 text-slate-400">กล้องต้องใช้ HTTPS (ยกเว้น localhost) และอนุญาตสิทธิ์ในเบราว์เซอร์</p></section><section className="panel p-5"><div className="panel-head !p-0 pb-4"><div><h2>ผลการสแกน</h2><p className="muted">รายการล่าสุดจะแสดงที่นี่</p></div><Pill value={duplicate ? 'duplicate' : student && assignment ? 'ready' : 'neutral'} /></div><div className="scan-card mb-4">{student || assignment ? <div className="w-full text-left">{student && <div className="border-b border-slate-200 pb-3"><small className="muted">นักเรียน</small><b className="mt-1 block">{student.student_name}</b><span className="muted">{student.student_code} · {student.class_name || 'ไม่ระบุชั้น'} {student.student_number ? `· เลขที่ ${student.student_number}` : ''}</span></div>}{assignment && <div className="pt-3"><small className="muted">งาน</small><b className="mt-1 block">{assignment.assignment_name}</b><span className="muted">{assignment.assignment_code} · {assignment.subject || 'ไม่ระบุวิชา'}</span></div>}{duplicate && <div className="mt-3 rounded-lg bg-orange-50 p-3 text-xs font-semibold text-orange-800">งานนี้ถูกส่งแล้ว · {statusNames[duplicate.status]}<small className="mt-1 block font-normal">ส่งเมื่อ {niceDate(duplicate.submitted_at)}</small></div>}</div> : <div><span className="text-3xl text-teal-700">▣</span><p className="muted mt-2">สแกน QR นักเรียนหรืองานเพื่อเริ่มรับงาน</p></div>}</div><button className="primary w-full" disabled={!student || !assignment || !!duplicate} onClick={receive}>ยืนยันรับงาน</button><button className="secondary mt-2 w-full" onClick={reset}>ยกเลิกรายการ</button></section></div></>
}

function Reports({ rows, search, setSearch, assignmentFilter, setAssignmentFilter, statusFilter, setStatusFilter, assignments, edit }) { return <><Heading eyebrow="SUBMISSIONS & GRADING" title="รายงานและตรวจงาน" subtitle="ค้นหารายการส่งงาน ปรับสถานะ ให้คะแนน และบันทึกหมายเหตุ" /><section className="panel"><div className="toolbar flex-wrap"><input className="field min-w-40 flex-1" placeholder="ค้นหานักเรียนหรืองาน…" value={search} onChange={e => setSearch(e.target.value)} /><select className="field min-w-36" value={assignmentFilter} onChange={e => setAssignmentFilter(e.target.value)}><option value="">งานทั้งหมด</option>{assignments.map(a => <option key={a.id} value={a.id}>{a.assignment_name}</option>)}</select><select className="field min-w-32" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">ทุกสถานะ</option>{Object.entries(statusNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>นักเรียน</th><th>งาน</th><th>สถานะ</th><th>ส่งเมื่อ</th><th>คะแนน</th><th>หมายเหตุ</th><th /></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td><b>{s.students?.student_name || '—'}</b><small>{s.students?.student_code} · {s.students?.class_name}</small></td><td><b>{s.assignments?.assignment_name || '—'}</b><small>{s.assignments?.assignment_code}</small></td><td><Pill value={s.status} /></td><td>{niceDate(s.submitted_at)}</td><td>{s.score == null ? '—' : `${s.score}${s.max_score ? ` / ${s.max_score}` : ''}`}</td><td className="max-w-48 truncate">{s.remark || '—'}</td><td><button className="text-button" onClick={() => edit(s)}>ตรวจ / แก้ไข</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ไม่พบรายการ</p>}</div></section></> }

function Pill({ value }) { const kind = value === 'active' || value === 'checked' || value === 'ready' ? 'green' : value === 'late' || value === 'duplicate' ? 'orange' : value === 'inactive' || value === 'returned' ? 'red' : ''; const label = value === 'active' ? 'ใช้งาน' : value === 'inactive' ? 'ปิดใช้งาน' : value === 'ready' ? 'พร้อมรับงาน' : value === 'duplicate' ? 'ส่งแล้ว' : statusNames[value] || 'พร้อมสแกน'; return <span className={`pill ${kind}`}>{label}</span> }

function Editor({ type, record, courses, close, save }) {
  const isStudent = type === 'student', isAssignment = type === 'assignment', grading = type === 'grade'
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close() }}><form className="modal" onSubmit={save}><div className="modal-head"><div><p className="eyebrow">{grading ? 'GRADING' : isStudent ? 'STUDENT' : 'ASSIGNMENT'}</p><h2 className="m-0 text-lg font-bold">{grading ? 'บันทึกผลการตรวจ' : record ? 'แก้ไขข้อมูล' : isStudent ? 'เพิ่มนักเรียน' : 'สร้างงาน'}</h2></div><button type="button" className="text-xl text-slate-500" onClick={close}>×</button></div><div className="modal-body">
    {grading ? <><p className="mb-4 text-xs"><b>{record.students?.student_name}</b> · {record.assignments?.assignment_name}</p>{record.attachment_path && <p className="mb-3"><StudentWorkLink path={record.attachment_path} name={record.attachment_name || 'ไฟล์งาน'} /></p>}{record.submission_note && <p className="mb-3 rounded-lg bg-slate-50 p-3 text-xs">ข้อความจากนักเรียน: {record.submission_note}</p>}<label>สถานะ<select className="field" name="status" defaultValue={record.status}>{Object.entries(statusNames).filter(([key]) => key !== 'pending').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label>คะแนน<input className="field" name="score" type="number" min="0" step="0.01" defaultValue={record.score ?? ''} /></label><label>คะแนนเต็ม<input className="field" name="max_score" type="number" min="0" step="0.01" defaultValue={record.max_score ?? ''} /></label></div><label>หมายเหตุ<textarea className="field" name="remark" rows="3" defaultValue={record.remark || ''} /></label></> : isStudent ? <><label>รหัสนักเรียน<input className="field" name="student_code" required defaultValue={record?.student_code || ''} disabled={!!record?.auth_user_id} /></label><label>ชื่อ-นามสกุล<input className="field" name="student_name" required defaultValue={record?.student_name || ''} /></label><div className="grid grid-cols-2 gap-3"><label>ชั้น / ห้อง<input className="field" name="class_name" defaultValue={record?.class_name || ''} placeholder="ม.2/3" /></label><label>เลขที่<input className="field" name="student_number" type="number" min="1" defaultValue={record?.student_number || ''} /></label></div><label>รายวิชา<select className="field" name="course_id" required defaultValue={record?.course_id || ''}><option value="">เลือกรายวิชา</option>{courses.map(course => <option key={course.id} value={course.id}>{course.course_name}</option>)}</select></label><label>สถานะ<select className="field" name="status" defaultValue={record?.status || 'active'}><option value="active">ใช้งาน</option><option value="inactive">ปิดใช้งาน</option></select></label></> : <><label>รหัสงาน<input className="field" name="assignment_code" required defaultValue={record?.assignment_code || ''} /></label><label>ชื่องาน<input className="field" name="assignment_name" required defaultValue={record?.assignment_name || ''} /></label><label>รายวิชา<select className="field" name="course_id" required defaultValue={record?.course_id || ''}><option value="">เลือกรายวิชา</option>{courses.map(course => <option key={course.id} value={course.id}>{course.course_name}</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label>หัวข้อย่อย<input className="field" name="subject" defaultValue={record?.subject || ''} placeholder="เช่น เศษส่วน" /></label><label>กำหนดส่ง<input className="field" name="due_date" type="datetime-local" defaultValue={record?.due_date ? new Date(record.due_date).toISOString().slice(0, 16) : ''} /></label></div><label>รายละเอียด<textarea className="field" name="description" rows="3" defaultValue={record?.description || ''} /></label><label>สถานะ<select className="field" name="status" defaultValue={record?.status || 'active'}><option value="active">ใช้งาน</option><option value="inactive">ปิดใช้งาน</option></select></label><p className="text-[10px] leading-5 text-slate-400">ระบบจะสร้างรายการส่งให้นักเรียนในรายวิชาที่เลือก</p></>}
  </div><div className="modal-foot"><button type="button" className="secondary" onClick={close}>ยกเลิก</button><button className="primary">บันทึกข้อมูล</button></div></form></div>
}

function printCards(rows, type) {
  const area = document.createElement('div'); area.id = 'printArea'; area.className = 'ready'; document.body.append(area)
  const root = createRoot(area)
  flushSync(() => root.render(rows.map(row => <article className="qr-card" key={row.id}><div><b>{type === 'student' ? row.student_name : row.assignment_name}</b><small>{type === 'student' ? `${row.class_name || ''}${row.student_number ? ` · เลขที่ ${row.student_number}` : ''}` : row.subject || ''}</small><small>{type === 'student' ? row.student_code : row.assignment_code}</small></div><QRCodeSVG value={`${type === 'student' ? 'STU' : 'ASSIGN'}:${row.qr_token}`} size={116} /></article>)))
  window.setTimeout(() => { window.print(); window.setTimeout(() => { root.unmount(); area.remove() }, 700) }, 50)
}
