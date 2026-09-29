import { serviceClient, json, corsHeaders, errorResponse, requireStaff } from '../_shared/http.ts'

const loginEmail = (code: string) => {
  const hex = Array.from(new TextEncoder().encode(code), byte => byte.toString(16).padStart(2, '0')).join('')
  return `s-${hex}@students.studentsend.invalid`
}

const initialPassword = (code: string) => code.length >= 6 ? code : `${code}${'#'.repeat(6 - code.length)}`

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    try {
      const admin = serviceClient()
      await requireStaff(request, admin)
      const body = await request.json()
      const ids = Array.isArray(body.student_ids) ? [...new Set(body.student_ids.map(Number))] : []
      if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
        return json({ error: 'Provide 1–500 valid student IDs' }, 400)
      }

      const { data: students, error: queryError } = await admin.from('students')
        .select('id,student_code,student_name,status,auth_user_id').in('id', ids)
      if (queryError) throw queryError

      let created = 0, skipped = 0
      const errors: { student_id: number; student_code: string; message: string }[] = []
      for (const student of students || []) {
        if (student.status !== 'active' || student.auth_user_id) { skipped += 1; continue }
        const email = loginEmail(String(student.student_code))
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password: initialPassword(String(student.student_code)),
          email_confirm: true,
          app_metadata: { account_type: 'student', must_change_password: true },
          user_metadata: { display_name: student.student_name },
        })
        if (error || !data.user) {
          errors.push({ student_id: student.id, student_code: student.student_code, message: error?.message || 'Unable to create Auth account' })
          continue
        }
        const { error: linkError } = await admin.from('students').update({ auth_user_id: data.user.id })
          .eq('id', student.id).is('auth_user_id', null)
        if (linkError) {
          await admin.auth.admin.deleteUser(data.user.id)
          errors.push({ student_id: student.id, student_code: student.student_code, message: linkError.message })
          continue
        }
        created += 1
      }
      return json({ created, skipped, errors })
    } catch (error) { return errorResponse(error) }
  },
}
