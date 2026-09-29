import { createClient } from '@supabase/supabase-js'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

export const serviceClient = () => {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY function secrets')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

export async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('Authorization')
  if (!authorization) throw new Error('Unauthorized')
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY function secrets')
  const client = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: { user }, error } = await client.auth.getUser()
  if (error || !user) throw new Error('Unauthorized')
  return user
}

export async function requireStaff(request: Request, admin = serviceClient()) {
  const user = await authenticatedUser(request)
  const { data, error } = await admin.from('app_users')
    .select('active,role').eq('user_id', user.id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.active || !['admin', 'teacher'].includes(data.role)) throw new Error('Active staff account required')
  return user
}

export const errorResponse = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected error'
  const status = message === 'Unauthorized' ? 401 : message === 'Active staff account required' ? 403 : 400
  return json({ error: message }, status)
}
