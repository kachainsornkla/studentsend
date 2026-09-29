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

function runtimeKey(mapName: string, legacyName: string) {
  const keyMap = Deno.env.get(mapName)
  if (keyMap) {
    try {
      const keys = JSON.parse(keyMap) as Record<string, string>
      if (keys.default) return keys.default
    } catch {
      // Fall back to the legacy runtime variable below.
    }
  }
  return Deno.env.get(legacyName)
}

export const serviceClient = () => {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = runtimeKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('Supabase service key is missing from the Edge Function runtime')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

export async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('Authorization')
  if (!authorization) throw new Error('Unauthorized')
  const url = Deno.env.get('SUPABASE_URL')!
  const key = runtimeKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
  if (!url || !key) throw new Error('Supabase publishable key is missing from the Edge Function runtime')
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
