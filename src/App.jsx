import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { QRCodeSVG } from 'qrcode.react'
import { isSupabaseConfigured, supabase } from './supabase'

const statusNames = { pending: 'ยังไม่ส่ง', submitted: 'ส่งแล้ว', checking: 'รอตรวจ', checked: 'ตรวจแล้ว', returned: 'ส่งกลับแก้ไข', late: 'ส่งช้า' }
const nav = [['dashboard', '▦', 'ภาพรวม'], ['students', '♙', 'นักเรียน'], ['assignments', '▤', 'งานและ QR'], ['scanner', '▣', 'สแกนรับงาน'], ['reports', '▥', 'รายงานและตรวจ']]
const emptyStudent = { student_code: '', student_name: '', class_name: '', student_number: '', status: 'active' }
const emptyAssignment = { assignment_code: '', assignment_name: '', subject: '', description: '', due_date: '', status: 'active' }
const msg = error => error?.message || 'เกิดข้อผิดพลาด'
const niceDate = value => value ? new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [page, setPage] = useState('dashboard')
  const [students, setStudents] = useState([])
  const [assignments, setAssignments] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [search, setSearch] = useState('')
  const [assignmentFilter, setAssignmentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [modal, setModal] = useState(null)
  const [record, setRecord] = useState(null)
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
    supabase.from('app_users').select('display_name,role,active').eq('user_id', session.user.id).maybeSingle()
      .then(({ data, error }) => { if (alive) setProfile(error ? { error: error.message } : data) })
    return () => { alive = false }
  }, [session])

  const notify = useCallback(text => { setToast(text); window.setTimeout(() => setToast(''), 3000) }, [])

  const loadAll = useCallback(async () => {
    if (!session?.user || !profile || profile.error || !profile.active) return
    setBusy(true)
    const [s, a, sub] = await Promise.all([
      supabase.from('students').select('*').order('class_name').order('student_number').limit(1000),
      supabase.from('assignments').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('submissions').select('*,students(id,student_code,student_name,class_name,student_number,status),assignments(id,assignment_code,assignment_name,subject,due_date,status)').order('updated_at', { ascending: false }).limit(10000),
    ])
    const error = s.error || a.error || sub.error
    if (error) notify(msg(error))
    setStudents(s.data || []); setAssignments(a.data || []); setSubmissions(sub.data || [])
    setBusy(false)
  }, [session, profile, notify])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { if (page !== 'scanner') stopCamera() }, [page])
  useEffect(() => { if (page === 'scanner' && activeAssignment === '' && assignments.some(a => a.status === 'active')) setActiveAssignment(String(assignments.find(a => a.status === 'active').id)) }, [page, assignments, activeAssignment])
  useEffect(() => () => { stopCamera() }, [])

  async function signIn(event) {
    event.preventDefault(); setLoginBusy(true); setLoginError('')
    const form = new FormData(event.currentTarget)
    const { error } = await supabase.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') })
    if (error) setLoginError(error.message)
    setLoginBusy(false)
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
  const filteredAssignments = assignments.filter(a => !search || [a.assignment_code, a.assignment_name, a.subject].some(v => v?.toLowerCase().includes(search.toLowerCase())))
  const filteredSubmissions = submissions.filter(s => {
    const text = [s.students?.student_code, s.students?.student_name, s.assignments?.assignment_code, s.assignments?.assignment_name].some(v => v?.toLowerCase().includes(search.toLowerCase()))
    return text && (!assignmentFilter || String(s.assignment_id) === assignmentFilter) && (!statusFilter || s.status === statusFilter)
  })

  async function saveStudent(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const row = { student_code: values.student_code.trim(), student_name: values.student_name.trim(), class_name: values.class_name.trim() || null, student_number: values.student_number ? Number(values.student_number) : null, status: values.status }
    const request = record?.id ? supabase.from('students').update(row).eq('id', record.id) : supabase.from('students').insert(row)
    const { error } = await request; if (error) return notify(msg(error)); setModal(null); await loadAll(); notify('บันทึกข้อมูลนักเรียนแล้ว')
  }

  async function saveAssignment(event) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const row = { assignment_code: values.assignment_code.trim(), assignment_name: values.assignment_name.trim(), subject: values.subject.trim() || null, description: values.description.trim() || null, due_date: values.due_date ? new Date(values.due_date).toISOString() : null, status: values.status, ...(record?.id ? {} : { created_by: session.user.id }) }
    const request = record?.id ? supabase.from('assignments').update(row).eq('id', record.id) : supabase.from('assignments').insert(row)
    const { error } = await request; if (error) return notify(msg(error)); setModal(null); await loadAll(); notify('บันทึกงานแล้ว')
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
    if (error) return notify(msg(error)); setModal(null); await loadAll(); notify('บันทึกผลตรวจแล้ว')
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
  if (profile.error || !profile.active) return <div className="grid min-h-screen place-items-center p-6"><div className="panel max-w-lg p-7 text-center"><h1 className="mb-2 text-xl font-bold">บัญชียังไม่ได้รับสิทธิ์ใช้งาน</h1><p className="muted mb-5">เพิ่ม UUID บัญชีนี้ในตาราง <code>public.app_users</code> ผ่าน SQL Editor ของ Supabase</p><button className="primary" onClick={signOut}>ออกจากระบบ</button></div></div>

  return <div className="min-h-screen">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <a className="brand" href="#dashboard" onClick={e => { e.preventDefault(); changePage('dashboard') }}><span className="brand-mark">S</span><span>StudentSend<small>CLASSROOM WORKFLOW</small></span></a>
      <nav className="grid gap-1">{nav.map(([key, icon, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => changePage(key)}><span>{icon}</span><span>{label}</span></button>)}</nav>
      <div className="mt-auto flex items-center gap-2 border-t border-slate-100 px-1 pt-4"><span className="grid h-9 w-9 place-items-center rounded-full bg-orange-100 font-bold text-orange-700">{(profile.display_name || 'T')[0]}</span><span className="min-w-0 flex-1 truncate text-xs font-semibold">{profile.display_name}<small className="block text-[10px] font-normal text-slate-400">{profile.role === 'admin' ? 'Administrator' : 'Teacher'}</small></span><button className="p-2 text-slate-500" title="ออกจากระบบ" onClick={signOut}>↗</button></div>
    </aside>
    {menuOpen && <button className="fixed inset-0 z-[8] bg-slate-900/20 md:hidden" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} />}
    <main className="main">
      <header className="topbar"><button className="mr-3 rounded p-2 md:hidden" onClick={() => setMenuOpen(true)}>☰</button><div><span className="eyebrow">CLASSROOM MANAGEMENT</span><strong>{{ dashboard: 'ภาพรวม', students: 'นักเรียน', assignments: 'งานและ QR', scanner: 'สแกนรับงาน', reports: 'รายงานและตรวจ' }[page]}</strong></div><span className="text-xs text-slate-500">{new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></header>
      <div className="content">
        {page === 'dashboard' && <Dashboard stats={dashboard} assignments={assignments.filter(a => a.status === 'active')} submissions={submissions} busy={busy} go={changePage} />}
        {page === 'students' && <Students rows={filteredStudents} search={search} setSearch={setSearch} add={() => { setRecord(null); setModal('student') }} edit={s => { setRecord(s); setModal('student') }} remove={s => removeRow('students', s)} />}
        {page === 'assignments' && <Assignments rows={filteredAssignments} search={search} setSearch={setSearch} add={() => { setRecord(null); setModal('assignment') }} edit={a => { setRecord(a); setModal('assignment') }} remove={a => removeRow('assignments', a)} />}
        {page === 'scanner' && <Scanner mode={mode} setMode={m => { setMode(m); resetPair() }} assignments={assignments.filter(a => a.status === 'active')} selected={activeAssignment} setSelected={setActiveAssignment} student={scanStudent} assignment={scanAssignment} duplicate={duplicate} receive={receiveSubmission} reset={resetPair} readerRef={readerRef} cameraOn={cameraOn} start={startCamera} stop={stopCamera} error={cameraError} />}
        {page === 'reports' && <Reports rows={filteredSubmissions} search={search} setSearch={setSearch} assignmentFilter={assignmentFilter} setAssignmentFilter={setAssignmentFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} assignments={assignments} edit={s => { setRecord(s); setModal('grade') }} />}
      </div>
    </main>
    {modal && <Editor type={modal} record={record} close={() => setModal(null)} save={modal === 'student' ? saveStudent : modal === 'assignment' ? saveAssignment : saveGrade} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>
}

function ConfigHelp() { return <div className="login-shell"><div className="login-card"><span className="brand-mark mb-5">S</span><p className="eyebrow">SUPABASE SETUP</p><h1 className="mb-2 text-2xl font-bold">ตั้งค่าการเชื่อมต่อ</h1><p className="muted mb-5">คัดลอก <code>.env.example</code> เป็น <code>.env.local</code> แล้วใส่ Supabase Project URL และ Publishable Key จากหน้า Connect ของโปรเจกต์</p><code className="block rounded-lg bg-slate-50 p-3 text-xs">VITE_SUPABASE_URL=…<br/>VITE_SUPABASE_PUBLISHABLE_KEY=…</code></div></div> }
function Login({ onSubmit, busy, error }) { return <div className="login-shell"><form className="login-card" onSubmit={onSubmit}><span className="brand-mark mb-5">S</span><p className="eyebrow">SCHOOLS · SIMPLE · SECURE</p><h1 className="mb-1 text-3xl font-bold">StudentSend</h1><p className="muted mb-6">เข้าสู่ระบบด้วยบัญชีครู Supabase Auth</p><label className="mb-3 grid gap-2 text-xs font-semibold">อีเมล<input className="field" type="email" name="email" required autoComplete="username" /></label><label className="mb-4 grid gap-2 text-xs font-semibold">รหัสผ่าน<input className="field" type="password" name="password" required autoComplete="current-password" /></label>{error && <p className="mb-3 text-xs text-red-600">{error}</p>}<button className="primary w-full" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button></form></div> }

function Heading({ eyebrow, title, subtitle, action }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>{action}</div> }
function Dashboard({ stats, assignments, submissions, busy, go }) {
  const cards = [['นักเรียนทั้งหมด', stats.students, 'รายชื่อที่เปิดใช้งาน', '♙'], ['งานทั้งหมด', stats.assignments, 'งานที่กำลังใช้งาน', '▤'], ['ส่งแล้ว', stats.received, `จาก ${stats.total} รายการ`, '✓'], ['ยังไม่ส่ง', stats.pending, 'ติดตามได้จากรายงาน', '◷'], ['รอตรวจ', stats.checking, 'รายการที่ต้องตรวจ', '⌕'], ['ตรวจแล้ว', stats.checked, 'บันทึกผลแล้ว', '★']]
  return <><Heading eyebrow="YOUR CLASS AT A GLANCE" title="ภาพรวมการส่งงาน" subtitle="ติดตามความคืบหน้าของนักเรียนและงานทั้งหมด" action={<button className="primary" onClick={() => go('scanner')}>＋ รับงานด้วย QR</button>} /><div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">{cards.map(([label, number, note, icon], i) => <article className="stat" key={label}><span className={`mb-3 grid h-9 w-9 place-items-center rounded-xl text-lg ${['bg-teal-50 text-teal-700', 'bg-orange-50 text-orange-600', 'bg-sky-50 text-sky-700', 'bg-rose-50 text-rose-600', 'bg-violet-50 text-violet-600', 'bg-green-50 text-green-700'][i]}`}>{icon}</span><span className="text-xs font-semibold text-slate-500">{label}</span><strong>{Number(number || 0).toLocaleString()}</strong><small>{note}</small></article>)}</div><section className="panel"><div className="panel-head"><div><h2>ความคืบหน้ารายงาน</h2><p className="muted">สถานะการส่งของนักเรียนในแต่ละงาน</p></div><button className="text-button" onClick={() => go('reports')}>ดูรายงานทั้งหมด →</button></div><div className="table-wrap"><table><thead><tr><th>งาน</th><th>วิชา</th><th>กำหนดส่ง</th><th>ส่งแล้ว</th><th>ยังไม่ส่ง</th><th>ความคืบหน้า</th></tr></thead><tbody>{assignments.length ? assignments.map(a => { const list = submissions.filter(s => s.assignment_id === a.id), done = list.filter(s => s.status !== 'pending').length, pending = list.length - done, pct = list.length ? Math.round(done / list.length * 100) : 0; return <tr key={a.id}><td><b>{a.assignment_name}</b><small>{a.assignment_code}</small></td><td>{a.subject || '—'}</td><td>{niceDate(a.due_date)}</td><td>{done}</td><td>{pending}</td><td><div className="inline-flex items-center gap-2"><span className="h-1.5 w-24 overflow-hidden rounded bg-slate-100"><i className="block h-full rounded bg-teal-700" style={{ width: `${pct}%` }} /></span><small>{pct}%</small></div></td></tr> }) : <tr><td className="empty" colSpan="6">{busy ? 'กำลังโหลด…' : 'ยังไม่มีงาน ลองสร้างงานแรกของคุณ'}</td></tr>}</tbody></table></div></section></>
}

function Students({ rows, search, setSearch, add, edit, remove }) { return <><Heading eyebrow="STUDENT DIRECTORY" title="นักเรียน" subtitle="จัดการข้อมูลประจำตัวและพิมพ์ QR นักเรียน" action={<button className="primary" onClick={add}>＋ เพิ่มนักเรียน</button>} /><section className="panel"><div className="toolbar"><input className="field flex-1" placeholder="ค้นหารหัส ชื่อ หรือห้องเรียน…" value={search} onChange={e => setSearch(e.target.value)} /><button className="secondary" onClick={() => printCards(rows, 'student')}>▧ พิมพ์ QR</button></div><div className="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่อ-นามสกุล</th><th>ชั้น / เลขที่</th><th>ส่งแล้ว</th><th>สถานะ</th><th /></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td><b>{s.student_code}</b></td><td>{s.student_name}</td><td>{s.class_name || '—'} {s.student_number && `· ${s.student_number}`}</td><td>—</td><td><Pill value={s.status} /></td><td className="row-actions"><button onClick={() => edit(s)}>แก้ไข</button><button className="danger" onClick={() => remove(s)}>ลบ</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ไม่พบนักเรียน</p>}</div></section></> }
function Assignments({ rows, search, setSearch, add, edit, remove }) { return <><Heading eyebrow="ASSIGNMENT LIBRARY" title="งานและ QR" subtitle="QR งานหนึ่งใบใช้ร่วมกับนักเรียนทุกคน" action={<button className="primary" onClick={add}>＋ สร้างงาน</button>} /><section className="panel"><div className="toolbar"><input className="field flex-1" placeholder="ค้นหารหัสงาน ชื่องาน หรือวิชา…" value={search} onChange={e => setSearch(e.target.value)} /><button className="secondary" onClick={() => printCards(rows, 'assignment')}>▧ พิมพ์ QR งาน</button></div><div className="table-wrap"><table><thead><tr><th>รหัส</th><th>ชื่องาน</th><th>วิชา</th><th>กำหนดส่ง</th><th>สถานะ</th><th /></tr></thead><tbody>{rows.map(a => <tr key={a.id}><td><b>{a.assignment_code}</b></td><td>{a.assignment_name}</td><td>{a.subject || '—'}</td><td>{niceDate(a.due_date)}</td><td><Pill value={a.status} /></td><td className="row-actions"><button onClick={() => printCards([a], 'assignment')}>QR</button><button onClick={() => edit(a)}>แก้ไข</button><button className="danger" onClick={() => remove(a)}>ลบ</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ยังไม่มีงาน</p>}</div></section></> }

function Scanner({ mode, setMode, assignments, selected, setSelected, student, assignment, duplicate, receive, reset, readerRef, cameraOn, start, stop, error }) {
  return <><Heading eyebrow="FAST CHECK-IN" title="สแกนรับงาน" subtitle="เลือกงานเพื่อสแกนนักเรียนต่อเนื่อง หรือสแกนนักเรียนก่อน" /><div className="grid items-start gap-4 lg:grid-cols-2"><section className="panel p-5"><div className="mode-tabs"><button className={mode === 'assignment-first' ? 'active' : ''} onClick={() => setMode('assignment-first')}>เลือกงานก่อน</button><button className={mode === 'student-first' ? 'active' : ''} onClick={() => setMode('student-first')}>นักเรียนก่อน</button></div>{mode === 'assignment-first' && <label className="mb-3 grid gap-2 text-xs font-semibold">กำลังรับงาน<select className="field" value={selected} onChange={e => setSelected(e.target.value)}><option value="">เลือกงาน</option>{assignments.map(a => <option value={a.id} key={a.id}>{a.assignment_code} · {a.assignment_name}</option>)}</select></label>}<div id="reader" ref={readerRef} /><div className="flex gap-2"><button className="primary flex-1" onClick={start} disabled={cameraOn}>เปิดกล้อง</button><button className="secondary flex-1" onClick={stop} disabled={!cameraOn}>หยุด</button></div>{error && <p className="mt-3 text-xs text-red-600">{error}</p>}<p className="mt-3 text-[10px] leading-5 text-slate-400">กล้องต้องใช้ HTTPS (ยกเว้น localhost) และอนุญาตสิทธิ์ในเบราว์เซอร์</p></section><section className="panel p-5"><div className="panel-head !p-0 pb-4"><div><h2>ผลการสแกน</h2><p className="muted">รายการล่าสุดจะแสดงที่นี่</p></div><Pill value={duplicate ? 'duplicate' : student && assignment ? 'ready' : 'neutral'} /></div><div className="scan-card mb-4">{student || assignment ? <div className="w-full text-left">{student && <div className="border-b border-slate-200 pb-3"><small className="muted">นักเรียน</small><b className="mt-1 block">{student.student_name}</b><span className="muted">{student.student_code} · {student.class_name || 'ไม่ระบุชั้น'} {student.student_number ? `· เลขที่ ${student.student_number}` : ''}</span></div>}{assignment && <div className="pt-3"><small className="muted">งาน</small><b className="mt-1 block">{assignment.assignment_name}</b><span className="muted">{assignment.assignment_code} · {assignment.subject || 'ไม่ระบุวิชา'}</span></div>}{duplicate && <div className="mt-3 rounded-lg bg-orange-50 p-3 text-xs font-semibold text-orange-800">งานนี้ถูกส่งแล้ว · {statusNames[duplicate.status]}<small className="mt-1 block font-normal">ส่งเมื่อ {niceDate(duplicate.submitted_at)}</small></div>}</div> : <div><span className="text-3xl text-teal-700">▣</span><p className="muted mt-2">สแกน QR นักเรียนหรืองานเพื่อเริ่มรับงาน</p></div>}</div><button className="primary w-full" disabled={!student || !assignment || !!duplicate} onClick={receive}>ยืนยันรับงาน</button><button className="secondary mt-2 w-full" onClick={reset}>ยกเลิกรายการ</button></section></div></>
}

function Reports({ rows, search, setSearch, assignmentFilter, setAssignmentFilter, statusFilter, setStatusFilter, assignments, edit }) { return <><Heading eyebrow="SUBMISSIONS & GRADING" title="รายงานและตรวจงาน" subtitle="ค้นหารายการส่งงาน ปรับสถานะ ให้คะแนน และบันทึกหมายเหตุ" /><section className="panel"><div className="toolbar flex-wrap"><input className="field min-w-40 flex-1" placeholder="ค้นหานักเรียนหรืองาน…" value={search} onChange={e => setSearch(e.target.value)} /><select className="field min-w-36" value={assignmentFilter} onChange={e => setAssignmentFilter(e.target.value)}><option value="">งานทั้งหมด</option>{assignments.map(a => <option key={a.id} value={a.id}>{a.assignment_name}</option>)}</select><select className="field min-w-32" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">ทุกสถานะ</option>{Object.entries(statusNames).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="table-wrap"><table><thead><tr><th>นักเรียน</th><th>งาน</th><th>สถานะ</th><th>ส่งเมื่อ</th><th>คะแนน</th><th>หมายเหตุ</th><th /></tr></thead><tbody>{rows.map(s => <tr key={s.id}><td><b>{s.students?.student_name || '—'}</b><small>{s.students?.student_code} · {s.students?.class_name}</small></td><td><b>{s.assignments?.assignment_name || '—'}</b><small>{s.assignments?.assignment_code}</small></td><td><Pill value={s.status} /></td><td>{niceDate(s.submitted_at)}</td><td>{s.score == null ? '—' : `${s.score}${s.max_score ? ` / ${s.max_score}` : ''}`}</td><td className="max-w-48 truncate">{s.remark || '—'}</td><td><button className="text-button" onClick={() => edit(s)}>ตรวจ / แก้ไข</button></td></tr>)}</tbody></table>{!rows.length && <p className="empty">ไม่พบรายการ</p>}</div></section></> }

function Pill({ value }) { const kind = value === 'active' || value === 'checked' || value === 'ready' ? 'green' : value === 'late' || value === 'duplicate' ? 'orange' : value === 'inactive' || value === 'returned' ? 'red' : ''; const label = value === 'active' ? 'ใช้งาน' : value === 'inactive' ? 'ปิดใช้งาน' : value === 'ready' ? 'พร้อมรับงาน' : value === 'duplicate' ? 'ส่งแล้ว' : statusNames[value] || 'พร้อมสแกน'; return <span className={`pill ${kind}`}>{label}</span> }

function Editor({ type, record, close, save }) {
  const isStudent = type === 'student', isAssignment = type === 'assignment', grading = type === 'grade'
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close() }}><form className="modal" onSubmit={save}><div className="modal-head"><div><p className="eyebrow">{grading ? 'GRADING' : isStudent ? 'STUDENT' : 'ASSIGNMENT'}</p><h2 className="m-0 text-lg font-bold">{grading ? 'บันทึกผลการตรวจ' : record ? 'แก้ไขข้อมูล' : isStudent ? 'เพิ่มนักเรียน' : 'สร้างงาน'}</h2></div><button type="button" className="text-xl text-slate-500" onClick={close}>×</button></div><div className="modal-body">
    {grading ? <><p className="mb-4 text-xs"><b>{record.students?.student_name}</b> · {record.assignments?.assignment_name}</p><label>สถานะ<select className="field" name="status" defaultValue={record.status}>{Object.entries(statusNames).filter(([key]) => key !== 'pending').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label>คะแนน<input className="field" name="score" type="number" min="0" step="0.01" defaultValue={record.score ?? ''} /></label><label>คะแนนเต็ม<input className="field" name="max_score" type="number" min="0" step="0.01" defaultValue={record.max_score ?? ''} /></label></div><label>หมายเหตุ<textarea className="field" name="remark" rows="3" defaultValue={record.remark || ''} /></label></> : isStudent ? <><label>รหัสนักเรียน<input className="field" name="student_code" required defaultValue={record?.student_code || ''} /></label><label>ชื่อ-นามสกุล<input className="field" name="student_name" required defaultValue={record?.student_name || ''} /></label><div className="grid grid-cols-2 gap-3"><label>ชั้น / ห้อง<input className="field" name="class_name" defaultValue={record?.class_name || ''} placeholder="ม.2/3" /></label><label>เลขที่<input className="field" name="student_number" type="number" min="1" defaultValue={record?.student_number || ''} /></label></div><label>สถานะ<select className="field" name="status" defaultValue={record?.status || 'active'}><option value="active">ใช้งาน</option><option value="inactive">ปิดใช้งาน</option></select></label></> : <><label>รหัสงาน<input className="field" name="assignment_code" required defaultValue={record?.assignment_code || ''} /></label><label>ชื่องาน<input className="field" name="assignment_name" required defaultValue={record?.assignment_name || ''} /></label><div className="grid grid-cols-2 gap-3"><label>วิชา<input className="field" name="subject" defaultValue={record?.subject || ''} /></label><label>กำหนดส่ง<input className="field" name="due_date" type="datetime-local" defaultValue={record?.due_date ? new Date(record.due_date).toISOString().slice(0, 16) : ''} /></label></div><label>รายละเอียด<textarea className="field" name="description" rows="3" defaultValue={record?.description || ''} /></label><label>สถานะ<select className="field" name="status" defaultValue={record?.status || 'active'}><option value="active">ใช้งาน</option><option value="inactive">ปิดใช้งาน</option></select></label><p className="text-[10px] leading-5 text-slate-400">รายการ pending จะถูกสร้างอัตโนมัติให้นักเรียน active</p></>}
  </div><div className="modal-foot"><button type="button" className="secondary" onClick={close}>ยกเลิก</button><button className="primary">บันทึกข้อมูล</button></div></form></div>
}

function printCards(rows, type) {
  const area = document.createElement('div'); area.id = 'printArea'; area.className = 'ready'; document.body.append(area)
  const root = createRoot(area)
  flushSync(() => root.render(rows.map(row => <article className="qr-card" key={row.id}><div><b>{type === 'student' ? row.student_name : row.assignment_name}</b><small>{type === 'student' ? `${row.class_name || ''}${row.student_number ? ` · เลขที่ ${row.student_number}` : ''}` : row.subject || ''}</small><small>{type === 'student' ? row.student_code : row.assignment_code}</small></div><QRCodeSVG value={`${type === 'student' ? 'STU' : 'ASSIGN'}:${row.qr_token}`} size={116} /></article>)))
  window.setTimeout(() => { window.print(); window.setTimeout(() => { root.unmount(); area.remove() }, 700) }, 50)
}
