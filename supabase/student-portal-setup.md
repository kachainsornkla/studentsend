# Student portal setup

The student portal adds account-based access to each student's own work, digital uploads, and Web Push notifications. Keep the Supabase secret/service-role key in Supabase Edge Function secrets only. Never add it to a `VITE_` variable.

## 1. Apply the database migration

The existing project must already have `supabase/schema.sql` installed. In Supabase Dashboard, open **SQL Editor**, paste the full contents of `supabase/student-portal.sql`, and run it once. It adds student/Auth links, work attachment fields, private file storage, student-only RLS policies, the submission RPC, and Realtime publication membership.

## 2. Deploy the Edge Functions

Install and authenticate the Supabase CLI, then link the existing project:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy provision-student-accounts
supabase functions deploy change-student-password
supabase functions deploy send-student-push
```

Supabase provides `SUPABASE_URL` and the API keys to Edge Functions automatically. Current projects expose keys as JSON maps named `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS`; the functions select the `default` key and also support the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` variables. Do not manually add these platform-reserved `SUPABASE_` variables as function secrets. Only add the VAPID secrets in the next step.

## 3. Enable Web Push

Generate one VAPID key pair. Keep the private key on the server:

```sh
npx web-push generate-vapid-keys
```

Set these secrets for Supabase Edge Functions:

```sh
supabase secrets set VAPID_PUBLIC_KEY=YOUR_PUBLIC_KEY VAPID_PRIVATE_KEY=YOUR_PRIVATE_KEY VAPID_SUBJECT=mailto:YOUR_CONTACT_EMAIL
```

Add `VITE_VAPID_PUBLIC_KEY` with the public key in the Cloudflare Workers **Build Variables and Secrets**, then redeploy so Vite rebuilds the app. The public VAPID key can be visible in the frontend; the private key must stay in Supabase secrets.

## 4. Create student accounts

Sign in as staff, open **นักเรียน**, and select **สร้างบัญชีนักเรียน**. Active students without an account are provisioned with their student code as the initial login name and password. Supabase Auth requires at least 6 characters, so the app internally pads a shorter initial code to meet that requirement while students still enter their own code. At first sign-in, each student must replace that temporary password with one at least 8 characters long. Student codes are locked from editing after an account has been linked.

## 5. Student access and notifications

Students can view their pending, submitted, and checked work, upload a file or send a text note, review scores/comments, and display their QR code for physical hand-in. Files are stored in the private `student-submissions` bucket, with a 25 MB maximum.

Students must allow notifications on each device/browser. Web Push can notify an installed PWA while it is closed when the browser and operating system support Push. App-selected alert sounds and volume apply while StudentSend is open; closed-app push sound is controlled by device/browser settings.
