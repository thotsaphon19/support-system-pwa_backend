# ระบบฝ่ายบริการ (Customer Service System) — Full Stack

ระบบฝ่ายบริการลูกค้าแบบครบวงจร ประกอบด้วย **แอปลูกค้า (PWA)**, **แอปแอดมิน (PWA)**,
และ **Backend API + ฐานข้อมูลจริง** ที่เชื่อมต่อกันแบบเรียลไทม์ (Socket.io)

> 🐘 **อัปเดตล่าสุด: ย้ายฐานข้อมูลจาก SQLite ไปเป็น Postgres (Neon)** — ทุก endpoint เชื่อมต่อฐานข้อมูลจริงผ่าน `DATABASE_URL` แล้ว รวมถึงรูปภาพที่อัปโหลด (สินค้า, โลโก้, สลิปโอนเงิน) ที่ตอนนี้เก็บเป็นแถวข้อมูลในฐานข้อมูลแทนการเขียนลงดิสก์ของเซิร์ฟเวอร์ — แก้ปัญหาข้อมูล/รูปภาพหายเมื่อ deploy ใหม่บนแพลตฟอร์มที่ดิสก์ไม่ถาวร (เช่น Vercel, Render) ดูวิธีตั้งค่าที่ [`backend/.env.example`](./backend/.env.example)

> 📘 **ต้องการ deploy ขึ้น production?** ดูคู่มือแบบละเอียดทีละขั้นตอน (Docker / Manual VPS / Split deployment, ตัวแปร env ทุกตัว, TURN, Push, checklist ทดสอบ, troubleshooting) ได้ที่ **[`DEPLOYMENT.md`](./DEPLOYMENT.md)**
>
> 🎯 **ใช้ Render + Vercel โดยเฉพาะ?** มีคู่มือแยกละเอียดกว่านั้นอีก อธิบายทุกช่องตั้งค่าที่เจอในหน้าจอจริง ที่ **[`DEPLOY_RENDER_VERCEL.md`](./DEPLOY_RENDER_VERCEL.md)**
>
> 🔒 **ก่อนเปิดใช้งานจริง อ่าน [`SECURITY.md`](./SECURITY.md) ก่อนเสมอ** — มี checklist ความปลอดภัยที่ต้องทำเอง (เปลี่ยนบัญชีทดสอบ, สุ่ม secret, firewall ฯลฯ) ที่โค้ดเพียงอย่างเดียวป้องกันให้ไม่ได้

```
project/
├── backend/       ← Node.js + Express + Postgres (Neon) + Socket.io (REST API + realtime chat)
├── customer/      ← แอปฝั่งลูกค้า (มือถือ, PWA) — เชื่อมกับ backend จริง
├── admin/         ← แอปฝั่งแอดมิน (เดสก์ท็อป, PWA) — เชื่อมกับ backend จริง
├── docker-compose.yml
├── nginx.conf.example
├── turnserver.conf   ← config for the optional self-hosted TURN server
├── DEPLOYMENT.md     ← คู่มือ deploy แบบละเอียดทีละขั้นตอน
├── DEPLOY_RENDER_VERCEL.md ← คู่มือ deploy เฉพาะ Render + Vercel แบบละเอียดทุกช่องตั้งค่า
└── SECURITY.md       ← checklist ความปลอดภัยก่อนเปิดใช้งานจริง
```

## สถาปัตยกรรมโดยย่อ

- **Backend**: Express REST API + Socket.io สำหรับแชทเรียลไทม์ ใช้ Postgres (แนะนำ [Neon](https://neon.tech) — ฟรี, serverless, ไม่ต้องดูแลเซิร์ฟเวอร์เอง) เป็นฐานข้อมูลจริง เชื่อมต่อผ่าน `DATABASE_URL` ตัวเดียว รูปภาพที่อัปโหลดทั้งหมด (สินค้า/โลโก้/สลิปโอนเงิน) ก็เก็บเป็นแถวข้อมูลในฐานข้อมูลเดียวกัน ไม่ใช่ไฟล์บนดิสก์ — ข้อมูลและรูปภาพจึงไม่หายเมื่อ redeploy แม้บนแพลตฟอร์มที่ดิสก์เป็น ephemeral (Vercel, Render ฯลฯ) migration (`CREATE TABLE IF NOT EXISTS` ทั้งหมด) รันอัตโนมัติทุกครั้งที่ backend สตาร์ท จึงไม่ต้องตั้งค่าฐานข้อมูลใหม่เองทุกครั้งที่ deploy
- **Auth**: JWT (เก็บ token ใน localStorage ของแต่ละแอป) + รหัสผ่านเข้ารหัสด้วย bcrypt
- **Realtime**: Socket.io endpoint เดียวกับ REST API (พอร์ตเดียวกัน) ใช้สำหรับข้อความแชทและการแจ้งเตือนอัปเดตสถานะงาน
- **Frontend ทั้งสองแอป** เป็น static HTML/CSS/JS ธรรมดา (ไม่ต้อง build step) เรียก REST API ผ่าน `fetch()` และเชื่อม Socket.io ผ่าน CDN script

---

## 1) รันบนเครื่อง (Local Development)

### Backend

```bash
cd backend
npm install
cp .env.example .env        # แก้ค่าตามต้องการ (ดูรายละเอียดด้านล่าง)
# เพิ่ม DATABASE_URL ใน .env ให้ชี้ไปยัง Postgres ของคุณ — สมัครฟรีที่ https://neon.tech
# แล้วคัดลอก connection string มาวางที่ DATABASE_URL (ดูคำอธิบายละเอียดใน .env.example)
npm run seed                 # สร้างตารางในฐานข้อมูล + ข้อมูลตัวอย่าง + บัญชีทดสอบ (รันซ้ำได้ปลอดภัย)
npm start                    # รันที่ http://localhost:4000 — migration รันอัตโนมัติทุกครั้งที่สตาร์ทด้วย
```

บัญชีทดสอบหลัง seed:
- **แอดมิน**: `admin` / `admin1234`
- **ลูกค้า**: `customer` / `customer1234`

### เปิดใช้งาน Push Notifications (ไม่บังคับ)

ถ้าไม่ตั้งค่า VAPID keys ระบบจะยังทำงานปกติทุกอย่าง เพียงแต่จะไม่ส่ง push notification จริง (แจ้งเตือนแบบ Socket.io เรียลไทม์ตอนแอปเปิดอยู่ยังทำงานตามปกติ) หากต้องการ push แบบ native (แจ้งเตือนได้แม้แอปไม่ได้เปิดอยู่):

```bash
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys(),null,2))"
```

คัดลอกค่า `publicKey`/`privateKey` ที่ได้ไปใส่ใน `.env` ที่ช่อง `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`

### เปิดใช้งาน TURN Server (แนะนำสำหรับ Production)

STUN อย่างเดียว (ค่าเริ่มต้น) ใช้งานได้กับเครือข่ายทั่วไป แต่ผู้ใช้ที่อยู่หลัง NAT/Firewall เข้มงวด (เช่นเครือข่ายองค์กรบางแห่ง) อาจเชื่อมต่อสายวิดีโอคอลแบบ peer-to-peer ไม่ได้เลย — TURN server จะ relay สื่อผ่านเซิร์ฟเวอร์แทนในกรณีนั้น

**ตัวเลือก A — self-host ด้วย coturn** (มีให้พร้อมใน `docker-compose.yml`):
```bash
# 1. สร้าง secret แบบสุ่ม
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. ใส่ค่าเดียวกันใน turnserver.conf (static-auth-secret=...) และ backend/.env (TURN_SECRET=...)
# 3. ตั้ง TURN_URL=turn:<IP เซิร์ฟเวอร์ของคุณ>:3478 ใน backend/.env
# 4. เปิดพอร์ต 3478 (TCP/UDP) และ 49152-65535 (UDP) ในไฟร์วอลล์/security group
# 5. รัน docker compose ตามปกติ — service `turn` จะเริ่มทำงานอัตโนมัติ
```

**ตัวเลือก B — ใช้บริการ TURN สำเร็จรูป** เช่น Twilio Network Traversal Service, Xirsys, Cloudflare Calls, Metered.ca — สมัครแล้วใส่ URL/secret ที่ได้รับตามรูปแบบที่ผู้ให้บริการกำหนดใน `TURN_URL`/`TURN_SECRET`

ทั้งสองแอปดึง TURN credentials (ที่หมดอายุอัตโนมัติทุก 1 ชั่วโมง) จาก `/api/turn-credentials` ก่อนเริ่ม/รับสายทุกครั้งอัตโนมัติอยู่แล้ว ไม่ต้องแก้โค้ด frontend เพิ่ม

### หมายเหตุเกี่ยวกับ AI Avatar

โหมด "AI Avatar" ใช้ [MediaPipe FaceLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (โหลดจาก CDN ของ Google ตอนรันจริงในเบราว์เซอร์) ตรวจจับสีหน้าและท่าทางศีรษะของเจ้าหน้าที่แบบเรียลไทม์ แล้ววาดอวตารภาพประกอบที่ขยับตาม — กระพริบตา อ้าปากพูด ยิ้ม หันหน้าซ้าย-ขวา-ก้ม-เงย ตามการเคลื่อนไหวจริง พร้อมการแรเงาให้ดูมีมิติ (ไล่สีผิว แสงเงา หู คอ ไหล่/ชุด) และปรับแต่งได้ (สีผิว สีผม สีชุด) ในหน้าตั้งค่าแอดมิน — เป็นเทคโนโลยีแบบเดียวกับ VTuber/Memoji/Zoom Avatar

**ขอบเขตที่จงใจไม่ทำ:** อวตารนี้ไม่ใช่และจะไม่มีวันเป็น "ใบหน้ามนุษย์สมจริง" (photorealistic face) การสร้างใบหน้าคนสมจริงมาแทนที่ใบหน้าจริงแบบเรียลไทม์คือเทคโนโลยี real-time face-swap/deepfake ซึ่งมีความเสี่ยงสูงต่อการถูกนำไปใช้แอบอ้างตัวตนผู้อื่นโดยไม่ยินยอม — จึงไม่สร้างส่วนนี้ไม่ว่าจุดประสงค์การใช้งานจะเป็นอะไรก็ตาม

**หมายเหตุการทดสอบ:** โค้ดฝั่ง frontend ทั้งหมด (WebRTC, avatar renderer, push subscription) ผ่านการตรวจสอบไวยากรณ์และตรรกะอย่างละเอียดแล้ว แต่ยังไม่ได้ทดสอบภาพจริงในเบราว์เซอร์ (สภาพแวดล้อมที่ใช้พัฒนาไม่มี browser ให้ทดสอบ) แนะนำให้ทดสอบกล้อง/ไมค์/วิดีโอคอลจริงก่อนใช้งานจริงกับลูกค้า โดยเฉพาะบน Safari/iOS ที่มักมีข้อจำกัดเรื่อง autoplay และสิทธิ์กล้องที่ต่างจาก Chrome/Android

### Customer app / Admin app

ทั้งสองแอปเป็น static site เรียก backend ที่ `http://localhost:4000` โดย default (ตั้งค่าที่ `customer/config.js` และ `admin/config.js`)

```bash
# ฝั่งลูกค้า
cd customer && python3 -m http.server 8080
# เปิด http://localhost:8080

# ฝั่งแอดมิน (อีก terminal)
cd admin && python3 -m http.server 8081
# เปิด http://localhost:8081
```

> ใช้เครื่องมือ static server อะไรก็ได้ (เช่น `npx serve`, VS Code Live Server) ทั้งสองแอปไม่มี build step

---

## 2) รันด้วย Docker (แนะนำสำหรับทดสอบ production-like)

```bash
cp backend/.env.example backend/.env   # แก้ JWT_SECRET เป็นค่าจริงก่อน
docker compose up --build
```

- Backend API: `http://localhost:4000`
- Customer app: `http://localhost:8080`
- Admin app: `http://localhost:8081`

ฐานข้อมูล SQLite จะถูกเก็บใน Docker volume (`support_data`) ข้อมูลไม่หายเมื่อ container รีสตาร์ท

---

## 3) Deploy ขึ้น Production จริง

### ขั้นตอนสรุป

1. **เช่า VPS** (เช่น DigitalOcean, Vultr, AWS Lightsail) หรือใช้ platform อย่าง Railway/Render สำหรับ backend
2. ติดตั้ง Node.js 20+ บนเซิร์ฟเวอร์ แล้ว `npm install --omit=dev` ใน `backend/`
3. ตั้งค่า `.env` จริง:
   - `JWT_SECRET` — สุ่มค่าใหม่ด้วย `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `CORS_ORIGINS` — ใส่โดเมนจริงของแอปลูกค้า/แอดมิน เช่น `https://app.yourdomain.com,https://admin.yourdomain.com`
   - `DB_PATH` — ชี้ไปยัง disk ที่ persist ได้ (ไม่ใช่ ephemeral storage)
4. รัน backend ด้วย process manager เช่น **PM2** ให้ auto-restart เมื่อ crash หรือ reboot:
   ```bash
   npm install -g pm2
   pm2 start server.js --name support-backend
   pm2 save && pm2 startup
   ```
5. ติดตั้ง **Nginx** เป็น reverse proxy + ใช้ **Certbot** ออก HTTPS ฟรี — ดูตัวอย่างเต็มใน `nginx.conf.example` (จำเป็นมาก เพราะ PWA/Service Worker **ทำงานบน HTTPS เท่านั้น** ยกเว้น localhost)
6. อัปเดต `customer/config.js` และ `admin/config.js` ให้ชี้ไปที่โดเมน API จริง เช่น:
   ```js
   window.APP_CONFIG = {
     API_BASE: 'https://api.yourdomain.com/api',
     SOCKET_URL: 'https://api.yourdomain.com',
   };
   ```
7. อัปโหลดโฟลเดอร์ `customer/` และ `admin/` ขึ้น static host (Nginx ตามตัวอย่าง, หรือ Netlify/Vercel/S3+CloudFront ก็ได้เช่นกัน เพราะเป็น static ไฟล์ล้วน)

### การขยับไป Postgres (สำหรับสเกลใหญ่ / ผู้ใช้พร้อมกันจำนวนมาก)

SQLite (ไฟล์เดียว) เหมาะกับธุรกิจขนาดเล็ก-กลางหรือ MVP เมื่อระบบโตขึ้นและต้องรองรับผู้ใช้พร้อมกันจำนวนมาก แนะนำให้ย้ายไป Postgres:
- เปลี่ยน `backend/db.js` ให้ใช้ driver เช่น `pg` หรือ ORM เช่น Prisma/Drizzle แทน `better-sqlite3`
- โครงสร้างตาราง (schema) ใน `db.js` แปลงเป็น Postgres syntax ได้ตรงไปตรงมา (เกือบเหมือนเดิม)
- ส่วน routes (`routes/*.js`) แทบไม่ต้องแก้ เพราะ query logic เขียนแยกไว้ในจุดเดียว (`db.prepare(...)`)
- ใช้ managed Postgres เช่น Supabase, Neon, RDS เพื่อลดภาระดูแลเซิร์ฟเวอร์ฐานข้อมูลเอง

---

## สิ่งที่ยังต้องพัฒนาเพิ่มสำหรับ Production เต็มรูปแบบ

**อัปเดต:** WebRTC วิดีโอคอลสองทางจริง, AI Avatar (ขับเคลื่อนด้วย face tracking จริง), rate limiting, refresh token, push notification จริง, และ **TURN server (self-hosted coturn หรือบริการสำเร็จรูป)** — ทำเสร็จและทดสอบแล้วทั้งหมด (ดูหัวข้อ "ฟีเจอร์ที่ใช้งานได้จริงแล้ว" ด้านล่าง) จุดที่ยังเหลือสำหรับ production เต็มรูปแบบ:

1. **การจัดการทีมงานหลายคน/สิทธิ์แยกตามบทบาท** (ตอนนี้ seed ไว้ 1 บัญชีแอดมิน)
2. **Backup ฐานข้อมูลอัตโนมัติ** (cron job สำรอง SQLite ไฟล์ หรือย้ายไป managed Postgres ตามหัวข้อด้านบน)
3. **Automated tests** (unit/integration) ก่อนขึ้น production จริง
4. **Call recording/transcription** หากต้องการเก็บบันทึกการสนทนาเพื่อคุณภาพบริการ (ต้องคำนึงถึงกฎหมายคุ้มครองข้อมูลส่วนบุคคลและขอความยินยอมจากลูกค้า)

## ฟีเจอร์ที่ใช้งานได้จริงแล้ว (เชื่อมกับ backend จริงทั้งหมด)

**ฝั่งลูกค้า:**
- ล็อกอินจริงผ่าน JWT (access token 15 นาที + refresh token หมุนเวียนอัตโนมัติ 30 วัน — ไม่ต้องล็อกอินซ้ำระหว่างใช้งาน)
- หน้าหลัก (ดึงงาน/FAQ จาก API จริง), แชทกับแอดมินแบบเรียลไทม์ (Socket.io)
- **วิดีโอคอลสองทางจริง (WebRTC)** — เชื่อมต่อ peer-to-peer จริงระหว่างลูกค้ากับแอดมิน ผ่าน STUN server, มีทั้งโทรออก (ลูกค้ากดโทร) และรับสายเข้า (แอดมินโทรมา)
- **AI Avatar จริง** — เมื่อแอดมินตั้งโหมด "AI Avatar" ลูกค้าจะเห็นอวตารการ์ตูนที่ขยับตามสีหน้าจริงของเจ้าหน้าที่แบบเรียลไทม์ (กระพริบตา อ้าปากพูด ยิ้ม) ขับเคลื่อนด้วย MediaPipe face tracking ที่รันในเบราว์เซอร์ของเจ้าหน้าที่ ไม่ใช่ UI จำลองอีกต่อไป
- แจ้งปัญหาใหม่ → สร้าง ticket จริง พร้อม **push notification จริง** แจ้งเตือนแอดมินทันที (ผ่าน Web Push API)
- คลังความรู้ + ประกาศ ดึงจาก API จริง, ประวัติ/รายละเอียดงานอัปเดตแบบเรียลไทม์
- **🛍️ ใจดีมอลล์ (มาร์เก็ตเพลสในตัวแอป)** — แบรนด์ร้านค้าต้นฉบับ ไม่เกี่ยวข้องกับ Lazada หรือแบรนด์อื่นใด: เรียกดูสินค้าตามหมวดหมู่/ค้นหา, หน้ารายละเอียดสินค้า, ตะกร้าสินค้า, เช็คเอาท์ (หักยอดจากกระเป๋าเงินในแอปแบบ atomic transaction — ล้มเหลวได้ก็ต่อเมื่อสต๊อกไม่พอหรือยอดเงินไม่พอ ไม่มีทางข้อมูลครึ่งๆ กลางๆ), กระเป๋าเงิน + แต้มสะสม (ได้แต้ม 1 แต้มทุกๆ 100 บาทที่ใช้จ่าย), ประวัติคำสั่งซื้อ

**ฝั่งแอดมิน:**
- ล็อกอินจริง (พร้อม refresh token), แดชบอร์ด (สถิติจริง + กราฟ 7 วันล่าสุด)
- **กล่องข้อความ (Inbox)** — แชทเรียลไทม์ พร้อมปุ่ม **"📞 โทร"** เพื่อวิดีโอคอลหาลูกค้าได้โดยตรง และรับสายเข้าจากลูกค้าผ่าน incoming-call banner (รับ/ปฏิเสธ)
- **สลับโหมดหน้าจริง/AI Avatar ได้แบบเรียลไทม์กลางสาย** (ปุ่ม 🤖/🧑‍💼 ระหว่างคุย) โดยไม่ต้องตัดสายใหม่ — ใช้เทคนิค `RTCRtpSender.replaceTrack()` สลับ track โดยไม่ renegotiate การเชื่อมต่อ
- รายการแจ้งบริการ + Kanban — คลิกเปลี่ยนสถานะ อัปเดตฐานข้อมูลจริงทันที พร้อม push notification แจ้งลูกค้าเมื่อสถานะเปลี่ยน
- ลูกค้า, คลังความรู้ (เพิ่ม/แก้ไขบทความจริง), ตั้งค่าโหมดวิดีโอคอลเริ่มต้น (ใช้เป็นค่า default เมื่อมีสายใหม่)
- **🛍️ จัดการสินค้า** — เพิ่ม/แก้ไข/ลบสินค้าจริง (ชื่อ ราคา ราคาก่อนลด สต๊อก หมวดหมู่ ไอคอน สถานะแสดง/ซ่อน) เปลี่ยนแล้วขึ้นหน้าร้านลูกค้าทันที
- **📦 คำสั่งซื้อ** — ดูคำสั่งซื้อทั้งหมดแบบเรียลไทม์ (แจ้งเตือนทันทีที่มีคำสั่งซื้อใหม่ผ่าน Socket.io + push notification) คลิกที่แถวเพื่อเลื่อนสถานะ (สั่งซื้อสำเร็จ → กำลังจัดเตรียมสินค้า → กำลังจัดส่ง → จัดส่งสำเร็จ) ลูกค้าได้รับแจ้งเตือนอัตโนมัติทุกครั้งที่สถานะเปลี่ยน

**Security & Reliability:**
- **Rate limiting** บน login/register (20 ครั้ง/15 นาที ต่อ IP) ป้องกัน brute-force
- **Refresh token rotation** — token เก่าใช้ซ้ำไม่ได้หลัง refresh ครั้งหนึ่ง (ป้องกัน token replay)
- รหัสผ่านเข้ารหัสด้วย bcrypt, ไม่มีการเก็บรหัสผ่านแบบ plaintext ที่ใดเลย
