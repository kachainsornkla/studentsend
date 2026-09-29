import { serviceClient, json, corsHeaders, errorResponse, authenticatedUser } from '../_shared/http.ts'

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    try {
      const user = await authenticatedUser(request)
      if (user.app_metadata?.account_type !== 'student' || user.app_metadata?.must_change_password !== true) {
        return json({ error: 'No initial password change is required' }, 403)
      }
      const { password } = await request.json()
      if (typeof password !== 'string' || password.length < 8) {
        return json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' }, 400)
      }
      const admin = serviceClient()
      const { data: student, error: queryError } = await admin.from('students')
        .select('id').eq('auth_user_id', user.id).eq('status', 'active').maybeSingle()
      if (queryError) throw queryError
      if (!student) return json({ error: 'Student account is inactive' }, 403)

      const { error } = await admin.auth.admin.updateUserById(user.id, {
        password,
        app_metadata: { ...user.app_metadata, account_type: 'student', must_change_password: false },
      })
      if (error) throw error
      return json({ success: true })
    } catch (error) { return errorResponse(error) }
  },
}
