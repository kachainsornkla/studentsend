# StudentSend

ระบบจัดการและรับส่งงานนักเรียนด้วย QR Code ใช้ React + Vite, Tailwind CSS, Supabase Auth/PostgreSQL, กล้องเบราว์เซอร์ และ Vite PWA Plugin

## Features

- เข้าสู่ระบบด้วย Supabase Auth (email/password); ไม่มีระบบรหัสผ่านแยกในแอป
- จัดการนักเรียน งาน สถานะ คะแนน และหมายเหตุ
- QR token สุ่มแยกสำหรับนักเรียนแต่ละคนและงานแต่ละชิ้น
- สแกน QR ผ่านกล้องด้วย `html5-qrcode` ได้ทั้งโหมดเลือกงานก่อนและนักเรียนก่อน
- รับงานซ้ำไม่ได้ด้วย `UNIQUE(student_id, assignment_id)` และ conditional update จาก `pending`
- สร้างรายการ `pending` อัตโนมัติเมื่อเพิ่ม/เปิดใช้งานนักเรียนหรืองาน
- Dashboard, ค้นหา/กรองรายงาน และพิมพ์ QR A4
- PWA manifest และ auto-update service worker
- RLS อนุญาตเฉพาะ UUID ที่ลงทะเบียนเป็น active staff ใน `app_users`

## Local development

1. ใช้ Node.js 20.19+ หรือ 22.12+.
2. เปิด Supabase project แล้วรันเนื้อหาใน [supabase/schema.sql](supabase/schema.sql) ใน SQL Editor
3. เชิญบัญชีครูผ่าน Supabase Authentication แล้วเพิ่ม UUID ใน `app_users` ผ่าน SQL Editor:

   ```sql
   insert into public.app_users(user_id, display_name, role)
   values ('AUTH-USER-UUID', 'ชื่อครู', 'admin');
   ```

4. คัดลอก `.env.example` เป็น `.env.local` แล้วใส่ Project URL และ Publishable key จาก Supabase:

   ```text
   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
   ```

5. ติดตั้งและเริ่มพัฒนา:

   ```sh
   pnpm install
   pnpm dev
   ```

   ใช้ `pnpm build` เพื่อสร้างเว็บ production ใน `dist/` และ `pnpm preview` เพื่อดู build ในเครื่อง

## Deploy to Cloudflare Pages

เชื่อม Git repository ใน Cloudflare Pages แล้วตั้งค่า:

- Build command: `pnpm build`
- Build output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL` และ `VITE_SUPABASE_PUBLISHABLE_KEY`

ตั้ง environment variables ทั้ง Production และ Preview ตามต้องการ จากนั้น Pages จะ build ใหม่เมื่อมีการ push commit. ห้ามใช้ Supabase `service_role` key ใน frontend; publishable key ใช้ได้เมื่อเปิด RLS และ policies ตาม schema

## Camera and PWA

กล้องต้องใช้ HTTPS (localhost ใช้ได้โดยไม่ต้อง HTTPS) และผู้ใช้ต้องอนุญาต Camera. PWA service worker ใช้บน secure context และติดตั้งได้จากเบราว์เซอร์ที่รองรับ

## Database import

`supabase/schema.sql` เป็น PostgreSQL schema สำหรับโปรเจกต์ Supabase ใหม่ ไม่ใช่ CSV data dump. การ import รายชื่อนักเรียนเดิมให้เตรียม CSV อย่างน้อย `student_code,student_name,class_name,student_number` แล้ว import ผ่าน Table Editor หลังสร้าง schema; อย่านำ QR token หรือข้อมูลรหัสผ่านจากระบบเก่ามาใช้ซ้ำ
