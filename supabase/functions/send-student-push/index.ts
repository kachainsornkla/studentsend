import { serviceClient, json, corsHeaders, errorResponse, requireStaff } from '../_shared/http.ts'
import webpush from 'web-push'

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    try {
      const admin = serviceClient()
      await requireStaff(request, admin)
      const { submission_id } = await request.json()
      const id = Number(submission_id)
      if (!Number.isSafeInteger(id) || id < 1) return json({ error: 'Invalid submission_id' }, 400)

      const { data: submission, error: submissionError } = await admin.from('submissions')
        .select('id,status,student_id,assignment_id,students(auth_user_id,student_name),assignments(assignment_name)')
        .eq('id', id).maybeSingle()
      if (submissionError) throw submissionError
      if (!submission || submission.status !== 'checked' || !submission.students?.auth_user_id) {
        return json({ sent: 0, skipped: true })
      }

      const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')
      const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')
      const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@studentsend.invalid'
      if (!publicKey || !privateKey) throw new Error('Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY function secrets')
      webpush.setVapidDetails(subject, publicKey, privateKey)

      const { data: subscriptions, error: subscriptionsError } = await admin.from('student_push_subscriptions')
        .select('endpoint,p256dh,auth_secret').eq('user_id', submission.students.auth_user_id)
      if (subscriptionsError) throw subscriptionsError
      let sent = 0
      for (const row of subscriptions || []) {
        try {
          await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth_secret } }, JSON.stringify({
            title: 'ตรวจงานเรียบร้อยแล้ว',
            body: `${submission.assignments?.assignment_name || 'งานของคุณ'} ได้รับการตรวจแล้ว`,
            url: '/',
            tag: `submission-${submission.id}`,
          }))
          sent += 1
        } catch (error) {
          if ([404, 410].includes(error?.statusCode)) {
            await admin.from('student_push_subscriptions').delete().eq('endpoint', row.endpoint)
          } else console.error('Push delivery failed', error?.statusCode || error?.message)
        }
      }
      return json({ sent })
    } catch (error) { return errorResponse(error) }
  },
}
