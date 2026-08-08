# Deploy บน Render + Vercel — คู่มือละเอียดทุกขั้นตอน

คู่มือนี้เจาะจงสำหรับสองผู้ให้บริการนี้โดยเฉพาะ อธิบายทุกช่องตั้งค่าที่เจอในหน้าจอจริง ใช้เวลาทำตามประมาณ 30-40 นาที

**ภาพรวมสถาปัตยกรรม:**
```
┌─────────────────┐         ┌──────────────────────┐
│  Vercel          │  HTTPS  │  Render                │
│  (2 โปรเจกต์)     │────────▶│  (1 Web Service)       │
│  - customer app  │         │  - Node.js + Express   │
│  - admin app     │         │  - Socket.io            │
│  (static files)  │         │  - SQLite (Disk mount)  │
└─────────────────┘         └──────────────────────┘
```

---

## สารบัญ
1. [เตรียมตัวก่อนเริ่ม](#1-เตรียมตัวก่อนเริ่ม)
2. [ส่วนที่ 1: Deploy Backend บน Render](#2-ส่วนที่-1-deploy-backend-บน-render)
3. [ส่วนที่ 2: Deploy Frontend บน Vercel](#3-ส่วนที่-2-deploy-frontend-บน-vercel)
4. [เชื่อมสองฝั่งเข้าด้วยกัน (CORS)](#4-เชื่อมสองฝั่งเข้าด้วยกัน-cors)
5. [ตั้งค่า Custom Domain (ไม่บังคับ)](#5-ตั้งค่า-custom-domain-ไม่บังคับ)
6. [ตารางตัวแปร Environment ทั้งหมด](#6-ตารางตัวแปร-environment-ทั้งหมด)
7. [ทดสอบให้ครบ](#7-ทดสอบให้ครบ)
8. [Troubleshooting เฉพาะ Render/Vercel](#8-troubleshooting-เฉพาะ-rendervercel)

---

## 1) เตรียมตัวก่อนเริ่ม

### 1.1 ต้องมี Git repo
Render และ Vercel ทั้งคู่ทำงานได้ลื่นที่สุดเมื่อเชื่อมกับ Git repo (GitHub/GitLab/Bitbucket) ถ้ายังไม่มี:
```bash
cd support-system-pwa
git init
git add .
git commit -m "initial commit"
```
สร้าง repo ใหม่บน [github.com/new](https://github.com/new) (เลือก Private ถ้าไม่อยากให้คนอื่นเห็นโค้ด) แล้ว push:
```bash
git remote add origin https://github.com/<your-username>/support-system-pwa.git
git branch -M main
git push -u origin main
```

### 1.2 สร้าง secret ที่ต้องใช้ล่วงหน้า
เตรียมค่านี้ไว้ก่อน จะได้ใส่ตอนตั้งค่า Environment Variables ได้เลยไม่ต้องสลับหน้าจอไปมา:
```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
```
คัดลอกผลลัพธ์เก็บไว้ (เดี๋ยวใช้ในขั้นตอน 2.3)

### 1.3 สมัครบัญชี
- [render.com](https://render.com) — สมัครด้วยอีเมลหรือ **Sign up with GitHub** (แนะนำ เพราะจะเชื่อม repo ได้ทันทีไม่ต้องขอ permission แยก)
- [vercel.com](https://vercel.com) — เช่นเดียวกัน แนะนำ **Continue with GitHub**

---

## 2) ส่วนที่ 1: Deploy Backend บน Render

### 2.1 สร้าง Web Service
1. ล็อกอิน Render → กด **New +** (มุมขวาบน) → เลือก **Web Service**
2. หน้า **Connect a repository** — ถ้าเพิ่งสมัครด้วย GitHub จะเห็น repo ของคุณในลิสต์เลย ถ้าไม่เห็นกด **Configure account** เพื่อให้สิทธิ์ Render เข้าถึง repo นั้น
3. เลือก repo `support-system-pwa` (หรือชื่อที่คุณตั้ง) → กด **Connect**

### 2.2 ตั้งค่าฟอร์ม "Create a new Web Service" — อธิบายทุกช่อง

| ช่อง | ใส่ค่านี้ | คำอธิบาย |
|---|---|---|
| **Name** | `support-backend` (หรือชื่ออะไรก็ได้) | ใช้เป็นส่วนหนึ่งของ URL เริ่มต้น (`https://support-backend.onrender.com`) |
| **Region** | `Singapore` | ใกล้ผู้ใช้ในไทยที่สุดในบรรดา region ที่ Render มีให้ ลด latency |
| **Branch** | `main` | branch ที่จะ deploy — เปลี่ยน branch แล้ว push ใหม่จะ auto-deploy ตาม branch นี้ |
| **Root Directory** | `backend` | **สำคัญที่สุดในฟอร์มนี้** — บอก Render ว่าโค้ด backend อยู่ในโฟลเดอร์ย่อยนี้ ไม่ใช่ root ของ repo (ถ้าเผลอเว้นว่างไว้ build จะหา `Dockerfile` ไม่เจอ) |
| **Runtime** | `Docker` | Render จะเจอ `Dockerfile` ในโฟลเดอร์ backend อัตโนมัติแล้วเลือกให้เองถ้า Root Directory ถูกต้อง |
| **Instance Type** | `Free` เพื่อทดสอบก่อน หรือ `Starter` ($7/เดือน) ถ้าจะใช้จริง | Free มีปัญหา sleep หลัง 15 นาทีไม่มีคนใช้ (ดูหัวข้อ Troubleshooting) |

**อย่าเพิ่งกด Create Web Service** — เลื่อนลงไปตั้งค่าเพิ่มก่อนตามขั้นตอน 2.3-2.5

### 2.3 ตั้งค่า Environment Variables
เลื่อนหาส่วน **Environment Variables** ในฟอร์มเดียวกัน (หรือถ้าพลาดกดสร้างไปแล้ว ไปที่แท็บ **Environment** ทีหลังได้) กด **Add Environment Variable** ทีละแถว:

| Key | Value | หมายเหตุ |
|---|---|---|
| `NODE_ENV` | `production` | เปิดใช้งาน fail-fast security checks (ดู SECURITY.md) |
| `JWT_SECRET` | (ค่าที่สุ่มไว้ในขั้นตอน 1.2) | ห้ามใช้ค่าตัวอย่างเด็ดขาด |
| `CORS_ORIGINS` | `https://placeholder.vercel.app` | ใส่ placeholder ไปก่อน จะกลับมาแก้เป็นค่าจริงในขั้นตอน 4 |
| `DATABASE_URL` | connection string จาก Neon (ดูขั้นตอน 2.4) | **นี่คือตัวแปรที่สำคัญที่สุด** — ต้องใส่ที่ Render (ฝั่ง backend) เท่านั้น **ไม่ต้องใส่ที่ Vercel** เพราะ Vercel รันแค่ frontend (ไฟล์ static) ไม่ได้เชื่อมฐานข้อมูลเอง |
| `PORT` | `4000` | Render จะ inject `PORT` ของตัวเองมาให้อัตโนมัติจริงๆ แต่ใส่ไว้ไม่มีผลเสีย |

**ตัวแปรไม่บังคับ (ใส่ทีหลังได้เมื่อพร้อม):**
| Key | ใส่เมื่อไหร่ |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | ตอนจะเปิด push notification — วิธีสร้างอยู่ใน `DEPLOYMENT.md` หัวข้อ 6 |
| `TURN_URL` / `TURN_SECRET` | ตอนจะเปิด TURN server — วิธีสร้างอยู่ใน `DEPLOYMENT.md` หัวข้อ 7 |

### 2.4 สร้างฐานข้อมูล Neon แล้วเอา connection string มาใส่ `DATABASE_URL`
ระบบเปลี่ยนจาก SQLite (ไฟล์บนดิสก์) มาเป็น Postgres แล้ว — **ไม่ต้องสร้าง Persistent Disk บน Render อีกต่อไป** เพราะข้อมูลทั้งหมด (รวมถึงรูปภาพที่อัปโหลด) จะถูกเก็บบน Neon แทน ไม่ใช่ดิสก์ของ Render:
1. ไปที่ [neon.tech](https://neon.tech) → สมัครสมาชิก (ฟรี) → กด **Create a project**
2. หลังสร้างโปรเจกต์เสร็จ หน้า Dashboard จะโชว์ **Connection string** ให้ทันที — เลือกแบบ **Pooled connection** (แนะนำสำหรับ backend ที่รันแบบ web service ทั่วไปแบบนี้)
3. คัดลอกค่าที่ได้ (จะมีรูปแบบ `postgres://USER:PASSWORD@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require`)
4. กลับไปที่ Render → **Environment** → วางค่านี้ในช่อง `DATABASE_URL` (ตามตารางขั้นตอน 2.3 ด้านบน)
5. ไม่ต้องรันคำสั่งสร้างตารางเองแยกต่างหาก — backend จะสร้างตาราง + ข้อมูลตัวอย่าง + บัญชีทดสอบให้อัตโนมัติทุกครั้งที่สตาร์ท (ปลอดภัย รันซ้ำได้ไม่จำกัด)

### 2.5 ไม่ต้องตั้งค่า Start Command / Pre-Deploy Command เพิ่ม
เวอร์ชันล่าสุดของโค้ดสร้างฐานข้อมูล + บัญชีทดสอบให้อัตโนมัติทุกครั้งที่เซิร์ฟเวอร์เริ่มทำงาน (ปลอดภัย รันซ้ำได้ไม่จำกัด ไม่ทำข้อมูลเดิมหาย) — ปล่อยให้ **Docker Command** และ **Pre-Deploy Command** เป็นค่าว่างเปล่าตามค่า default ได้เลย ใช้แค่ `CMD` เดิมจาก Dockerfile (`node server.js`) ก็พอ

> 💡 ทำแบบนี้เพราะ **Pre-Deploy Command เป็นฟีเจอร์ที่ Render ล็อกไว้เฉพาะแพลนเสียเงิน** ใช้บน Free tier ไม่ได้ — การย้าย logic เข้าไปอยู่ในโค้ดแทนทำให้ deploy ได้บน Free tier เหมือนกัน และยังพกพาไปใช้กับผู้ให้บริการอื่น (Railway, Fly.io, VPS ธรรมดา) ได้โดยไม่ต้องตั้งค่าอะไรเพิ่มด้วย

### 2.6 ตั้งค่า Health Check Path (แนะนำ)
1. แท็บ **Settings** → หา **Health Check Path**
2. ใส่ `/api/health`
3. Render จะใช้ endpoint นี้เช็คว่า service ยังทำงานปกติไหม ถ้า deploy ใหม่แล้ว health check ไม่ผ่าน Render จะไม่สลับ traffic ไปเวอร์ชันใหม่ (ป้องกัน downtime จาก deploy ที่พัง)

### 2.7 กด Deploy
กด **Create Web Service** (หรือ **Save Changes** ถ้าแก้ค่าทีหลัง) — Render จะเริ่ม build ทันที ดูความคืบหน้าได้ที่แท็บ **Logs** (ครั้งแรกใช้เวลาประมาณ 3-5 นาที เพราะต้อง build Docker image)

เมื่อ log ขึ้นว่า:
```
✅ Support system API listening on http://localhost:4000
```
แปลว่าสำเร็จ ไปที่แท็บ **Settings** จะเห็น URL ด้านบนแบบ `https://support-backend.onrender.com`

### 2.8 ทดสอบ
```bash
curl https://support-backend.onrender.com/api/health
```
ควรได้ `{"ok":true,"time":"..."}`

---

## 3) ส่วนที่ 2: Deploy Frontend บน Vercel

โปรเจกต์นี้มี `vercel.json` เตรียมไว้ให้แล้วทั้งในโฟลเดอร์ `customer/` และ `admin/` ที่ทำสิ่งสำคัญ 2 อย่างอัตโนมัติ:
1. **สร้าง `config.js` จาก Environment Variables ตอน build** — ไม่ต้องแก้ไฟล์ `config.js` ด้วยมือแล้ว commit ทุกครั้งที่ backend URL เปลี่ยน
2. **ตั้ง `Cache-Control: no-cache` ให้ `sw.js`** — กันปัญหา browser แคช service worker เก่าค้างจนอัปเดตแอปใหม่ไม่ขึ้น

### วิธีที่ 1 — ผ่าน Vercel Dashboard (แนะนำ เห็นทุกช่องตั้งค่าชัดเจน)

**Deploy โปรเจกต์ customer:**
1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → เลือก repo ของคุณ
2. หน้าตั้งค่าโปรเจกต์:

| ช่อง | ใส่ค่านี้ |
|---|---|
| **Project Name** | `support-customer` |
| **Framework Preset** | `Other` (คลิก dropdown แล้วเลือก — สำคัญ ถ้าปล่อย auto-detect อาจเดาผิดเป็น framework อื่น) |
| **Root Directory** | กด **Edit** → เลือก `customer` |
| **Build and Output Settings** | ปล่อยเป็นค่า default — `vercel.json` ที่มีอยู่แล้วจะสั่ง build command และ output directory ให้เองอัตโนมัติ |

3. เลื่อนหา **Environment Variables** เพิ่ม 2 ตัว:

| Key | Value |
|---|---|
| `API_BASE` | `https://support-backend.onrender.com/api` |
| `SOCKET_URL` | `https://support-backend.onrender.com` |

   (ใส่ URL จริงจาก Render ขั้นตอน 2.8 — **ต้องมี `/api` ต่อท้าย `API_BASE` แต่ `SOCKET_URL` ไม่ต้องมี**)

4. กด **Deploy** — รอประมาณ 30 วินาที (ไม่มี build จริงจัง แค่รัน echo command)
5. เสร็จแล้วจะได้ URL แบบ `https://support-customer.vercel.app`

**Deploy โปรเจกต์ admin — ทำซ้ำเหมือนเดิมทุกอย่าง แต่:**
- **Project Name**: `support-admin`
- **Root Directory**: เลือก `admin`
- **Environment Variables**: ใส่ `API_BASE`/`SOCKET_URL` ชุดเดียวกับข้างบน (backend ตัวเดียวกัน)

### วิธีที่ 2 — ผ่าน Vercel CLI (เร็วกว่าถ้าถนัด terminal)

```bash
npm install -g vercel
vercel login
```

```bash
cd customer
vercel env add API_BASE production
# ระบบจะถามค่า — วางค่า https://support-backend.onrender.com/api
vercel env add SOCKET_URL production
# วางค่า https://support-backend.onrender.com

vercel --prod
```
ตอบคำถามที่ CLI ถาม:
```
? Set up and deploy "customer"? [Y/n] y
? Which scope do you want to deploy to? <เลือกบัญชีของคุณ>
? Link to existing project? [y/N] n
? What's your project's name? support-customer
? In which directory is your code located? ./
```

ทำซ้ำกับ `admin/`:
```bash
cd ../admin
vercel env add API_BASE production      # ค่าเดียวกับข้างบน
vercel env add SOCKET_URL production    # ค่าเดียวกับข้างบน
vercel --prod
```

### ตรวจสอบว่า config.js ถูกสร้างถูกต้อง
```bash
curl https://support-customer.vercel.app/config.js
```
ควรเห็น:
```js
window.APP_CONFIG = { API_BASE: 'https://support-backend.onrender.com/api', SOCKET_URL: 'https://support-backend.onrender.com' };
```
ถ้าเห็นค่า `http://localhost:4000/...` แทน แปลว่ายังไม่ได้ตั้ง Environment Variables ใน Vercel หรือสะกดชื่อตัวแปรผิด (ต้องเป็น `API_BASE`/`SOCKET_URL` ตัวพิมพ์ใหญ่ตรงตามนี้เป๊ะ)

---

## 4) เชื่อมสองฝั่งเข้าด้วยกัน (CORS)

ตอนนี้ frontend รู้จัก backend แล้ว (ผ่าน `config.js`) แต่ backend ยังไม่รู้จัก frontend — ต้องกลับไปแก้ `CORS_ORIGINS` ที่ Render:

1. กลับไปที่ Render → service `support-backend` → แท็บ **Environment**
2. แก้ `CORS_ORIGINS` จาก placeholder เป็นค่าจริง:
   ```
   CORS_ORIGINS=https://support-customer.vercel.app,https://support-admin.vercel.app
   ```
3. กด **Save Changes** — Render จะ redeploy service ให้อัตโนมัติทันที (ใช้เวลาประมาณ 1 นาที เพราะแค่รีสตาร์ท ไม่ต้อง build ใหม่)

---

## 5) ตั้งค่า Custom Domain (ไม่บังคับ)

ถ้าไม่อยากใช้ `.onrender.com`/`.vercel.app`:

**Render:**
1. แท็บ **Settings** → **Custom Domains** → **Add Custom Domain**
2. ใส่โดเมนเช่น `api.yourdomain.com` → Render จะให้ค่า CNAME มา
3. ไปตั้งที่ DNS provider ของคุณ: เพิ่ม CNAME record ชี้ค่าที่ Render ให้มา
4. รอ DNS propagate (5-30 นาที) Render จะออก HTTPS certificate ให้อัตโนมัติ

**Vercel:**
1. โปรเจกต์ → แท็บ **Settings** → **Domains** → ใส่โดเมนเช่น `app.yourdomain.com`
2. Vercel จะบอกว่าต้องเพิ่ม record อะไรที่ DNS (ปกติเป็น CNAME ชี้ไป `cname.vercel-dns.com`)
3. ทำเหมือนกันสำหรับโปรเจกต์ admin ด้วยโดเมนอื่น เช่น `admin.yourdomain.com`

**อย่าลืม:** ถ้าเปลี่ยนไปใช้ custom domain ต้องกลับไปแก้ `CORS_ORIGINS` ที่ Render ให้เป็นโดเมนใหม่ด้วย (ทำซ้ำขั้นตอนที่ 4)

---

## 6) ตารางตัวแปร Environment ทั้งหมด

### ฝั่ง Render (backend)
เหมือนตารางในหัวข้อ 2.3 ด้านบน — ดูรายละเอียดเต็มของทุกตัวแปรที่มีได้ใน `DEPLOYMENT.md` หัวข้อ 5

### ฝั่ง Vercel (ทั้งสองโปรเจกต์ customer และ admin)
| ตัวแปร | ตัวอย่างค่า | ใช้ทำอะไร |
|---|---|---|
| `API_BASE` | `https://support-backend.onrender.com/api` | ให้ `vercel.json`'s build command เขียนลง `config.js` — ต้องมี `/api` ต่อท้าย |
| `SOCKET_URL` | `https://support-backend.onrender.com` | เหมือนกัน แต่**ไม่มี** `/api` ต่อท้าย (Socket.io เชื่อมที่ root ของ origin) |

> 💡 ข้อดีของวิธีนี้เทียบกับแก้ `config.js` ด้วยมือ: เปลี่ยน backend URL ทีหลัง (เช่นย้ายจาก Render ไปที่อื่น) แค่แก้ค่าตัวแปร 2 ตัวใน Vercel แล้วกด **Redeploy** — ไม่ต้องแก้โค้ด ไม่ต้อง commit ใหม่

---

## 7) ทดสอบให้ครบ

- [ ] `curl https://support-backend.onrender.com/api/health` → `{"ok":true,...}`
- [ ] `curl https://support-customer.vercel.app/config.js` → เห็น URL ของ Render ถูกต้อง (ไม่ใช่ localhost)
- [ ] เปิด `https://support-customer.vercel.app` → หน้าล็อกอินขึ้น, ไม่มี error สีแดงใน Console (F12)
- [ ] ล็อกอินด้วย `customer`/`customer1234` → เข้าหน้าหลักได้ เห็นข้อมูลจริงจาก backend (ไม่ใช่หน้าขาว/loading ค้าง)
- [ ] เปิด `https://support-admin.vercel.app` → ล็อกอินด้วย `admin`/`admin1234` → เห็นแดชบอร์ด
- [ ] ทดสอบแชท: ส่งข้อความจากฝั่งลูกค้า → เห็นในกล่องข้อความแอดมินแบบเรียลไทม์ (ยืนยันว่า Socket.io เชื่อมผ่าน CORS ได้ถูกต้อง)
- [ ] ทดสอบวิดีโอคอลเบื้องต้น (ขอสิทธิ์กล้อง/ไมค์ได้ปกติ)
- [ ] **เปลี่ยนรหัสผ่านบัญชีทดสอบ** ก่อนเปิดใช้งานจริง (ดู `SECURITY.md`)

---

## 8) Troubleshooting เฉพาะ Render/Vercel

**Push โค้ดขึ้น GitHub แล้ว Vercel ขึ้น "All checks have failed" ทั้ง `support-admin` และ `support-customer` ทันที:**
→ สาเหตุที่พบบ่อยที่สุด: **Root Directory** ที่ตั้งไว้ในแต่ละ Vercel project (`customer` / `admin` — ดูขั้นตอน 3 ด้านบน) ไม่ตรงกับโครงสร้างจริงของ repo ที่ push ขึ้นไป เช่น push แค่ไฟล์ของ customer ไปที่ root ของ repo ตรงๆ โดยไม่มีโฟลเดอร์ `customer/`/`admin/`/`backend/` ครอบอยู่ Vercel จะหา path ที่ตั้งไว้ไม่เจอแล้ว fail ทันทีทั้งสองโปรเจกต์แบบนี้

เช็คก่อน: เปิด repo บน GitHub แล้วดูว่ามีโฟลเดอร์ `customer/`, `admin/`, `backend/` จริงไหม (ไม่ใช่ไฟล์ลอยอยู่ที่ root) ถ้าไม่มี ให้จัดโครงสร้างใหม่ให้ตรงกับโปรเจกต์นี้แล้ว push ทับ:

```bash
cd your-repo
mkdir customer
# ตัวอย่างกรณีไฟล์ customer ลอยอยู่ที่ root อยู่ก่อนแล้ว — ย้ายเข้าโฟลเดอร์ customer/
git mv app.js avatar-renderer.js config.js index.html manifest.json style.css sw.js vercel.json icons customer/
# คัดลอกโฟลเดอร์ admin/ และ backend/ จากโปรเจกต์นี้เข้ามาเพิ่มให้ครบ 3 โฟลเดอร์
git add -A
git commit -m "restructure: monorepo layout (customer/admin/backend)"
git push
```

Push เสร็จแล้วไม่ต้องสร้าง Vercel project ใหม่ — แค่ไปที่แต่ละ project → แท็บ **Deployments** → เมนูจุดสามจุดของ deployment ล่าสุด → **Redeploy** ก็พอ (Root Directory ที่ตั้งไว้เดิมจะหาโฟลเดอร์เจอแล้ว)

ถ้าโครงสร้างโฟลเดอร์ถูกต้องอยู่แล้วแต่ยัง fail ให้กด **Details** ที่ deployment (ตามรูป error ที่เห็น) เพื่อดู build log เต็ม จะบอก error ชัดเจนกว่านี้ — มักเป็นเรื่อง Framework Preset ไม่ได้ตั้งเป็น `Other` (ปล่อย auto-detect แล้วเดาผิด) เป็นอันดับสองรองจากเรื่อง Root Directory

**Vercel build สำเร็จ แต่ `config.js` ยังเป็นค่า localhost:**
→ ไม่ได้ตั้ง Environment Variables ใน Vercel หรือชื่อตัวแปรสะกดผิด ไปที่โปรเจกต์ → **Settings** → **Environment Variables** เช็คว่ามี `API_BASE`/`SOCKET_URL` ครบทั้งคู่ และตั้งไว้ที่ environment **Production** (ไม่ใช่แค่ Preview/Development) แล้วกด **Redeploy** (แก้ env var ไม่ trigger redeploy อัตโนมัติเหมือน Render — ต้องกดเองที่แท็บ **Deployments** → จุดสามจุด → **Redeploy**)

**เปิดแอปแล้วเห็น CORS error ใน Console:**
→ `CORS_ORIGINS` ที่ Render ยังไม่ตรงกับ URL จริงของ Vercel (เช็คว่าเป็น `https://` ไม่ใช่ `http://`, ไม่มี `/` ท้าย URL, สะกด `.vercel.app` ถูกต้อง) แก้แล้วรอ Render redeploy เสร็จ (ดู progress ที่แท็บ Events)

**Render service ค้างที่ "Deploying" นานผิดปกติ / build fail:**
→ ดู **Logs** ทันที มักเป็นเพราะ Root Directory ตั้งผิด (ต้องเป็น `backend` ไม่ใช่เว้นว่างหรือ `/backend`) หรือลืมตั้ง Disk ทำให้ `DB_PATH` เขียนไฟล์ไม่ได้

**Request แรกหลังไม่มีคนใช้นานช้ามาก (10-30 วินาที):**
→ Render free tier sleep หลัง 15 นาที เป็นพฤติกรรมปกติของ free tier ไม่ใช่ bug — ทางแก้ดู `DEPLOYMENT.md` หัวข้อ "ข้อควรระวังเฉพาะแนวทางนี้" (อัปเกรด Starter tier หรือใช้ `.github/workflows/keep-alive.yml` ที่เตรียมไว้ให้)

**แชท/วิดีโอคอลหลุดเป็นระยะๆ:**
→ ถ้าใช้ Render free tier มักเกิดจาก sleep กลางคัน (ดูข้อข้างบน) ถ้าใช้ Starter tier แล้วยังเจอ ให้เช็ค Render **Logs** ช่วงเวลาที่หลุดว่ามี error หรือ restart เกิดขึ้นไหม

**อัปเดตโค้ดแล้วเว็บยังเป็นเวอร์ชันเก่า (โดยเฉพาะ Service Worker):**
→ `vercel.json` ตั้ง no-cache ให้ `sw.js` ไว้แล้ว แต่ถ้ายังเจอ ให้ลอง hard refresh (Ctrl+Shift+R) หรือปิด-เปิด DevTools → Application → Service Workers → **Unregister** แล้วโหลดหน้าใหม่
