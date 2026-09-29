# StudentSend

ระบบจัดการและรับส่งงานนักเรียนด้วย QR Code สร้างด้วย PHP 8.1+ และ MySQL 8 / MariaDB

## สิ่งที่ตรวจพบก่อนพัฒนา

Repository เดิมไม่มี source code, schema, authentication, AdminLTE หรือ API (มีเพียง Git metadata และยังไม่มี commit) จึงไม่มีส่วนเดิมให้ reuse ได้ ระบบนี้เริ่มจากโครงสร้าง PHP ขนาดเล็กที่ใช้ PDO และ vanilla JavaScript

## ความสามารถ

- เข้าสู่ระบบด้วยบัญชีครู/ผู้ดูแลและรหัสผ่านที่ hash ด้วย `password_hash`.
- จัดการนักเรียนและงาน พร้อมสถานะ active/inactive และ QR token สุ่มที่ไม่เปิดเผยข้อมูลจริง
- สร้าง QR นักเรียนหนึ่งใบต่อคน และ QR งานหนึ่งใบต่องาน; พิมพ์เป็นแผ่น A4 หลายใบ
- สแกนกล้องมือถือหรือ webcam ได้ทั้งโหมดเลือกงานก่อนและสแกนนักเรียนก่อน
- สร้างรายการ pending สำหรับนักเรียน active เมื่องานถูกเพิ่ม และสร้างรายการงาน active เมื่อนักเรียนใหม่ถูกเพิ่ม
- รับงานครั้งเดียวด้วย unique constraint; การ insert ใช้ `INSERT IGNORE` เพื่อป้องกันการรับซ้ำแม้คำขอเข้าพร้อมกัน
- คำนวณ submitted/late ในเวลารับงานจาก due date, ตรวจสถานะ, ให้คะแนน และบันทึกหมายเหตุ
- Dashboard และรายงานรายนักเรียน/งาน รองรับข้อมูลระดับ 200 × 10 และมากกว่า
- CSRF token, prepared statements, session cookie แบบ HttpOnly/SameSite, password hashing และ validation เบื้องต้น

## ติดตั้ง

1. ติดตั้ง PHP 8.1+ พร้อม `pdo_mysql` และ MySQL 8 หรือ MariaDB
2. สร้าง schema:

   ```sh
   mysql -u root -p < database/schema.sql
   ```

3. กำหนดค่าฐานข้อมูลผ่าน environment variables (ค่าเริ่มต้นอยู่ใน `config/config.php`):

   ```text
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_DATABASE=studentsend
   DB_USERNAME=...
   DB_PASSWORD=...
   APP_TIMEZONE=Asia/Bangkok
   ```

4. สร้างผู้ใช้เริ่มต้น. รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร:

   ```sh
   STUDENTSEND_INITIAL_PASSWORD='use-a-long-unique-password' php tools/create_user.php admin "School Administrator"
   ```

   บน PowerShell: `$env:STUDENTSEND_INITIAL_PASSWORD='use-a-long-unique-password'; php tools/create_user.php admin 'School Administrator'`

5. เสิร์ฟ `public/` เป็น document root ผ่าน Apache/Nginx ที่ใช้ HTTPS. สำหรับทดลองบนเครื่องตัวเองใช้ `php -S 127.0.0.1:8000 -t public` แล้วเปิด `http://127.0.0.1:8000`. กล้องต้องใช้ HTTPS เว้นแต่ localhost

QR scanner และ generator โหลดจาก CDN (`html5-qrcode`, `qrcodejs`) และฟอนต์จาก Google Fonts; ต้องเชื่อมอินเทอร์เน็ตเพื่อให้สแกน/สร้าง QR ได้ในหน้าเว็บ หากต้องใช้ในเครือข่ายปิด ให้นำไลบรารีที่มี license เหมาะสมมาโฮสต์ใน `public/assets/vendor/` แล้วแก้ script tags ใน `public/index.php`.

## การใช้งาน

1. เพิ่มรายชื่อนักเรียนและงาน (สร้างงานจะสร้างสถานะ pending ให้นักเรียน active ที่มีอยู่)
2. พิมพ์ QR นักเรียน/งานจากหน้ารายการ
3. ไปที่ “สแกนรับงาน”, เลือกงานเพื่อรับงานเดียวต่อเนื่อง หรือเลือกโหมดนักเรียนก่อน
4. สแกน QR; หน้าจอจะแสดงสถานะเดิมก่อนเปิดปุ่มยืนยัน
5. ตรวจงานจากหน้ารายงาน: ปรับสถานะ, คะแนน, คะแนนเต็ม และหมายเหตุ

QR payload ใช้รูปแบบ `STU:<32-char random token>` หรือ `ASSIGN:<32-char random token>`. Token ใช้เป็น opaque identifier; ข้อมูลชื่อและข้อมูลชั้นเรียนอยู่ในฐานข้อมูลเท่านั้น

## โครงสร้าง

```text
app/bootstrap.php       PDO, session, API handlers
config/config.php       Database/app configuration
database/schema.sql     Tables, indexes, constraints
public/index.php        Auth shell and application UI
public/assets/app.js    SPA interactions, scanner, QR print, API client
public/assets/app.css   Responsive UI and print styles
tools/create_user.php   CLI account provisioning
```

## Verification / known limits

- This environment did not have PHP installed, and no MySQL service/configuration was present. PHP lint, schema migration against MySQL, browser QR scanning, print rendering, and 200×10 load verification could not be executed here.
- QR code/scanner browser libraries are fetched from CDN; camera access needs a secure browser context and permission.
- The UI is a single teacher/admin workspace. The database includes a teacher/admin role for future role-specific authorization, but current application routes grant the same capabilities to all active accounts.
- Database credentials should use a dedicated account with privileges limited to this database. Deploy behind HTTPS and configure backups before production use.
