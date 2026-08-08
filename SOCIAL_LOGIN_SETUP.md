# ตั้งค่า Social Login (Google / Facebook / LINE) — support-system-pwa

ตั้งค่าได้ทั้งหมดจาก **หน้าหลังบ้าน (Admin) → Settings → "Social Login"** ไม่ต้องแก้โค้ด
ไม่ต้อง redeploy — บันทึกแล้วปุ่ม Social Login หน้า Login ของลูกค้าใช้งานได้ทันที

## ภาพรวมการทำงาน

```
customer/index.html  --คลิกปุ่ม-->  GET /api/auth/google
                                        │ (backend redirect ไปหน้า consent ของ Google)
                                        ▼
                                  ผู้ใช้ล็อกอินที่ Google
                                        │
                                        ▼
                      GET /api/auth/google/callback?code=...&state=...
                                        │ (backend แลก code เป็น token, ดึงโปรไฟล์,
                                        │  หา/สร้าง user ใน SQLite, ออก JWT)
                                        ▼
                 redirect กลับไปที่ URL หน้าเว็บลูกค้า#social_login=1&token=...&refresh=...
                                        │
                                        ▼
                        app.js อ่าน token จาก URL แล้วล็อกอินให้อัตโนมัติ
```

Client ID/Secret ที่กรอกในหน้า Admin จะถูกเก็บในฐานข้อมูล (ไม่ใช่ไฟล์ `.env`) และ **Client
Secret จะไม่ถูกส่งกลับมาแสดงอีกเลยหลังบันทึก** (เหมือนช่องรหัสผ่านทั่วไป) — หน้า Settings จะ
โชว์แค่สถานะ "เปิดใช้งานแล้ว" ให้ทราบว่าตั้งไว้แล้ว ถ้าต้องการเปลี่ยนค่า พิมพ์ค่าใหม่ทับได้เลย
เว้นช่องไว้ = ใช้ค่าเดิมที่เคยตั้งไว้ (ไม่ได้แปลว่าลบ)

Callback URL ที่ต้องเอาไปตั้งค่าฝั่งแต่ละผู้ให้บริการ **ระบบคำนวณให้อัตโนมัติ** ตามโดเมนจริงที่
backend รันอยู่ (ไม่ต้องเดาหรือพิมพ์เอง) — มีปุ่ม "คัดลอก" ให้กดตรงหน้า Settings เลย

## ขั้นตอนที่ 1 — สร้างแอปกับแต่ละผู้ให้บริการ

เปิดหน้า **Admin → Settings → Social Login** ทิ้งไว้ก่อน (จะใช้ก๊อป Callback URL แต่ละเจ้า)

### Google
1. ไปที่ [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. สร้าง OAuth 2.0 Client ID ประเภท **Web application**
3. ช่อง **Authorized redirect URI** → วางค่าที่ก๊อปมาจากช่อง "Callback / Redirect URI" ของ
   การ์ด Google ในหน้า Admin (หน้าตาประมาณ `https://api.yourdomain.com/api/auth/google/callback`)
4. คัดลอก Client ID และ Client Secret ไปกรอกในหน้า Admin แล้วกด **บันทึก**

### Facebook
1. ไปที่ [Facebook Developers](https://developers.facebook.com/) → สร้างแอป → เพิ่มผลิตภัณฑ์ "Facebook Login"
2. ช่อง **Valid OAuth Redirect URIs** → วาง Callback URL ที่ก๊อปจากหน้า Admin (การ์ด Facebook)
3. คัดลอก App ID และ App Secret ไปกรอกในหน้า Admin แล้วกด **บันทึก**
4. ก่อนขึ้น production ต้องส่งแอปไปให้ Facebook ตรวจสอบ (App Review) ถ้าต้องการ scope `email`
   — ถ้ายังไม่ผ่าน จะได้แค่ชื่อกับรูปโปรไฟล์ (ระบบรองรับกรณีนี้อยู่แล้ว อีเมลจะเป็น `null`)

### LINE
1. ไปที่ [LINE Developers Console](https://developers.line.biz/console/) → สร้าง Provider และ Channel
   ประเภท **LINE Login**
2. ช่อง **Callback URL** → วาง Callback URL ที่ก๊อปจากหน้า Admin (การ์ด LINE)
3. คัดลอก Channel ID และ Channel Secret ไปกรอกในหน้า Admin แล้วกด **บันทึก**
4. ปกติจะได้แค่ `userId`, `displayName`, `pictureUrl` — ถ้าต้องการอีเมลต้องยื่นขอสิทธิ์
   "Email address permission" จากทีม LINE เพิ่มเติม

## ขั้นตอนที่ 2 — ตั้ง "URL หน้าเว็บลูกค้า"

ในหน้า Admin → Settings → Social Login มีช่อง **"URL หน้าเว็บลูกค้า (Frontend URL)"** —
ใส่ที่อยู่จริงของ `customer/index.html` เช่น `https://support-customer.vercel.app/index.html`
(นี่คือที่ backend จะ redirect กลับไปหลังล็อกอิน Social เสร็จ) เว้นว่างไว้ได้ถ้าตั้ง
`FRONTEND_URL` ไว้ใน `.env` อยู่แล้ว — ค่าที่ตั้งในหน้า Admin จะสำคัญกว่าเสมอ

## ขั้นตอนที่ 3 — ทดสอบ

1. รีเฟรชหน้า Admin → Settings → Social Login — การ์ดเจ้าที่กรอกครบควรขึ้น "● เปิดใช้งานแล้ว"
2. เปิดหน้า login ของ customer PWA — ปุ่มของเจ้านั้นจะกดได้ (ไม่จางแล้ว)
3. กดปุ่ม → ควรถูกพาไปหน้ายืนยันตัวตนของผู้ให้บริการ แล้ววกกลับมาที่แอปพร้อมล็อกอินสำเร็จ

## (ทางเลือกสำรอง) ตั้งค่าผ่าน .env แทน

ถ้าอยากตั้งผ่านไฟล์ `.env` ของ backend แทนหน้า Admin (เช่น ทีม dev อยากคุมค่าเองผ่าน
environment variables) ก็ยังทำได้ — ดูบล็อก "Social login" ใน `.env.example` ค่าจาก
หน้า Admin จะสำคัญกว่าเสมอถ้าตั้งไว้ทั้งคู่

## พฤติกรรมบัญชีผู้ใช้

- ล็อกอินด้วย Social ครั้งแรก → ระบบสร้างบัญชี `customer` ใหม่อัตโนมัติ (username สุ่ม
  เช่น `google_a1b2c3d4e5`, มี `wallet_balance`/`referral_code` เหมือนสมัครปกติทุกอย่าง)
- ถ้าผู้ให้บริการส่งอีเมลกลับมา และมีบัญชี username/password เดิมที่ใช้อีเมลเดียวกันอยู่แล้ว
  ระบบจะ**ผูก**ตัวตน Social เข้ากับบัญชีเดิมแทนการสร้างซ้ำ (กระเป๋าเงิน/แต้ม/ประวัติสั่งซื้อ
  ไม่หาย)
- ผู้ใช้ที่สมัครผ่าน Social ล้วนจะไม่มีรหัสผ่านที่ใช้ได้จริง (เป็นค่าสุ่มที่ไม่มีใครรู้)
  จนกว่าจะเพิ่มฟีเจอร์ "ตั้งรหัสผ่าน" ในหน้าตั้งค่าบัญชีเอง

## หมายเหตุด้านความปลอดภัย

- Client Secret ทุกเจ้าเก็บในฐานข้อมูลฝั่งเซิร์ฟเวอร์เท่านั้น และ**ไม่เคยถูกส่งกลับมาแสดงผล
  ผ่าน API อีก** ไม่ว่าจะเป็นแอดมินหรือลูกค้า (มีแค่สถานะ "เปิดใช้งานแล้ว"/"ยังไม่ได้ตั้งค่า")
- Client ID มองเห็นได้เฉพาะแอดมินที่ล็อกอินแล้วเท่านั้น (ไม่รั่วผ่าน endpoint สาธารณะ)
- ทุก callback ตรวจสอบ `state` parameter ที่เซ็นด้วย `JWT_SECRET` (HMAC + timestamp
  10 นาที) เพื่อป้องกัน CSRF
- Production ต้องใช้ HTTPS จริงทั้ง Frontend URL และ Callback URL — ผู้ให้บริการ
  OAuth ส่วนใหญ่ไม่อนุญาต redirect URI แบบ `http://` (ยกเว้น `localhost` ตอน dev)
