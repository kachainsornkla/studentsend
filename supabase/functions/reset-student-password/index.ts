import { serviceClient, json, corsHeaders, errorResponse, requireStaff } from '../_shared/http.ts'

const initialPassword = (code: string) => code.length >= 6 ? code : `${code}${'#'.repeat(6 - code.length)}`

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    try {
      const admin = serviceClient()
      await requireStaff(request, admin)
      const body = await request.json()
      const studentId = Number(body.student_id)
      if (!Number.isSafeInteger(studentId) || studentId < 1) return json({ error: 'Invalid student_id' }, 400)

      const { data: student, error: queryError } = await admin.from('students')
        .select('id,student_code,status,auth_user_id').eq('id', studentId).maybeSingle()
      if (queryError) throw queryError
      if (!student) return json({ error: 'Student not found' }, 404)
      if (student.status !== 'active') return json({ error: 'เปิดใช้งานนักเรียนก่อนตั้งรหัสผ่าน' }, 400)
      if (!student.auth_user_id) return json({ error: 'นักเรียนยังไม่มีบัญชี กรุณาสร้างบัญชีนักเรียนก่อน' }, 400)

      let password: string
      if (body.mode === 'student_code') {
        password = initialPassword(String(student.student_code).trim())
      } else if (body.mode === 'custom') {
        password = typeof body.password === 'string' ? body.password : ''
        if (password.length < 6) return json({ error: 'รหัสชั่วคราวต้องมีอย่างน้อย 6 ตัวอักษรตามข้อกำหนด Supabase Auth' }, 400)
      } else {
        return json({ error: 'Invalid password reset mode' }, 400)
      }

      const { data: authData, error: authLookupError } = await admin.auth.admin.getUserById(student.auth_user_id)
      if (authLookupError || !authData.user) throw authLookupError || new Error('Student Auth user not found')
      const { error: updateError } = await admin.auth.admin.updateUserById(student.auth_user_id, {
        password,
        app_metadata: { ...authData.user.app_metadata, account_type: 'student', must_change_password: true },
      })
      if (updateError) throw updateError
      return json({ success: true })
    } catch (error) { return errorResponse(error) }
  },
}
