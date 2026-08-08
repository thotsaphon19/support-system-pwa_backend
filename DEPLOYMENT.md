# คู่มือ Deploy ระบบฝ่ายบริการ — ฉบับละเอียด

คู่มือนี้ครอบคลุมการ deploy ระบบขึ้นใช้งานจริง 3 แนวทาง เลือกแนวทางที่เหมาะกับคุณ:

| แนวทาง | เหมาะกับ | ความยาก |
|---|---|---|
| **A. Docker Compose** | อยากเริ่มเร็วที่สุด มี VPS อยู่แล้ว | ง่าย |
| **B. Manual VPS (ทีละขั้นตอน)** | อยากควบคุมทุกจุด เข้าใจระบบลึก | ปานกลาง-ยาก |
| **C. Split deployment (บริการสำเร็จรูป)** | ไม่อยากดูแลเซิร์ฟเวอร์เอง | ง่าย-ปานกลาง |

**ข้อกำหนดร่วมที่สำคัญที่สุด:** PWA (Service Worker), Push Notification, และ `getUserMedia` (กล้อง/ไมค์สำหรับวิดีโอคอล) **ทำงานบน HTTPS เท่านั้น** (ยกเว้น `localhost` ตอน dev) ไม่ว่าจะเลือกแนวทางไหน ปลายทางต้องมี HTTPS จริงเสมอ

---

## สารบัญ
1. [เตรียมโดเมนและ DNS](#1-เตรียมโดเมนและ-dns)
2. [แนวทาง A: Docker Compose](#2-แนวทาง-a-docker-compose)
3. [แนวทาง B: Manual VPS แบบละเอียดทุกขั้นตอน](#3-แนวทาง-b-manual-vps-แบบละเอียดทุกขั้นตอน)
4. [แนวทาง C: Split Deployment](#4-แนวทาง-c-split-deployment)
5. [ตัวแปร Environment ทั้งหมด (อธิบายทีละตัว)](#5-ตัวแปร-environment-ทั้งหมด)
6. [ตั้งค่า Push Notifications (VAPID)](#6-ตั้งค่า-push-notifications-vapid)
7. [ตั้งค่า TURN Server](#7-ตั้งค่า-turn-server)
8. [Checklist ทดสอบหลัง Deploy](#8-checklist-ทดสอบหลัง-deploy)
9. [การบำรุงรักษา: Backup, อัปเดต, Logs](#9-การบำรุงรักษา)
10. [แก้ปัญหาที่พบบ่อย (Troubleshooting)](#10-troubleshooting)

---

## 1) เตรียมโดเมนและ DNS

ต้องมีโดเมนอย่างน้อย 1 โดเมน แนะนำแยกเป็น 3 subdomain ชี้ไปยัง IP เซิร์ฟเวอร์เดียวกัน (สำหรับแนวทาง A/B):

```
app.yourdomain.com     → ลูกค้าใช้งาน (customer PWA)
admin.yourdomain.com   → แอดมินใช้งาน (admin PWA)
api.yourdomain.com     → backend API + Socket.io
```

ไปที่ผู้ให้บริการโดเมน (Cloudflare, Namecheap, GoDaddy ฯลฯ) แล้วเพิ่ม **A Record** ทั้ง 3 รายการชี้ไปยัง IP เซิร์ฟเวอร์ของคุณ รอ propagate ประมาณ 5-30 นาที ตรวจสอบด้วย:
```bash
nslookup app.yourdomain.com
nslookup admin.yourdomain.com
nslookup api.yourdomain.com
```

> ทำไมต้องแยก subdomain ให้ apps อยู่คนละพาธ (`/app`, `/admin`) แทนได้ไหม? ได้ครับ (ดูออปชัน `SERVE_FRONTENDS=true` ในหัวข้อที่ 5) แต่แยก subdomain จะตั้งค่า Nginx/certbot ง่ายกว่าและแยกปัญหาได้ง่ายกว่าเวลา debug

---

## 2) แนวทาง A: Docker Compose

เหมาะกับคนมี VPS อยู่แล้วและอยากรันให้เร็วที่สุด ใช้เวลาประมาณ 20-30 นาที

### ขั้นตอนที่ 1 — เตรียมเซิร์ฟเวอร์
เช่า VPS (DigitalOcean, Vultr, AWS Lightsail, Linode ฯลฯ) สเปกขั้นต่ำแนะนำ: **1 vCPU, 1GB RAM, Ubuntu 22.04** (ระบบนี้เบามาก ใช้ SQLite ไม่ใช่ Postgres จึงไม่กิน RAM มาก)

SSH เข้าเซิร์ฟเวอร์:
```bash
ssh root@your-server-ip
```

### ขั้นตอนที่ 2 — ติดตั้ง Docker
```bash
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin
docker --version
docker compose version
```

### ขั้นตอนที่ 3 — อัปโหลดโปรเจกต์ขึ้นเซิร์ฟเวอร์
จากเครื่องคุณ (ไม่ใช่บนเซิร์ฟเวอร์):
```bash
scp -r support-system-pwa root@your-server-ip:/opt/
ssh root@your-server-ip
cd /opt/support-system-pwa
```
(หรือถ้าใช้ Git: `git clone <your-repo-url> /opt/support-system-pwa`)

### ขั้นตอนที่ 4 — ตั้งค่า Environment
```bash
cp backend/.env.example backend/.env
nano backend/.env
```
แก้อย่างน้อย:
- `JWT_SECRET` — สุ่มค่าใหม่ (วิธีสุ่มดูหัวข้อ 5)
- `CORS_ORIGINS=https://app.yourdomain.com,https://admin.yourdomain.com`

สร้างไฟล์ `.env` ที่ root ของโปรเจกต์ (สำหรับ docker-compose อ่านค่า) ด้วยค่าเดียวกัน:
```bash
cat > .env << 'EOF'
JWT_SECRET=<ค่าที่สุ่มได้จากขั้นตอนก่อนหน้า>
CORS_ORIGINS=https://app.yourdomain.com,https://admin.yourdomain.com
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@yourdomain.com
TURN_URL=
TURN_SECRET=
EOF
```
(ดูวิธีสร้างค่า VAPID ในหัวข้อ 6 — ใส่ทีหลังได้ ไม่บังคับตอนเริ่มต้น)

### ขั้นตอนที่ 5 — แก้ config.js ของทั้งสองแอปให้ชี้ไปยังโดเมนจริง
```bash
nano customer/config.js
```
```js
window.APP_CONFIG = {
  API_BASE: 'https://api.yourdomain.com/api',
  SOCKET_URL: 'https://api.yourdomain.com',
};
```
ทำเหมือนกันกับ `admin/config.js`

### ขั้นตอนที่ 6 — รัน
```bash
docker compose up -d --build
docker compose logs -f backend   # ดู log ว่า seed สำเร็จและเซิร์ฟเวอร์ start แล้ว
```
ตอนนี้ backend รันที่พอร์ต 4000, customer-app ที่พอร์ต 8080, admin-app ที่พอร์ต 8081 (ยังเป็น HTTP ธรรมดา ไม่มี TLS — ขั้นต่อไปคือใส่ Nginx + HTTPS ครอบไว้ด้านหน้า)

### ขั้นตอนที่ 7 — ติดตั้ง Nginx + HTTPS ครอบหน้า Docker
```bash
apt install -y nginx certbot python3-certbot-nginx
cp nginx.conf.example /etc/nginx/sites-available/support-system
```
แก้ไฟล์ที่คัดลอกไป ให้ `proxy_pass` ชี้เข้า container แทนไฟล์ static โดยตรง (เพราะตอนนี้ frontend รันอยู่ใน Docker แล้ว ไม่ใช่ไฟล์บนดิสก์):
```bash
nano /etc/nginx/sites-available/support-system
```
เปลี่ยนบล็อก `app.yourdomain.com` และ `admin.yourdomain.com` จาก `root ...; location { try_files ... }` เป็น:
```nginx
server {
    listen 80;
    server_name app.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
server {
    listen 80;
    server_name admin.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
    }
}
```
บล็อก `api.yourdomain.com` ใช้ตามไฟล์ตัวอย่างได้เลย (proxy_pass ไป `127.0.0.1:4000` อยู่แล้ว)

เปิดใช้งานและออก HTTPS:
```bash
ln -s /etc/nginx/sites-available/support-system /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d app.yourdomain.com -d admin.yourdomain.com -d api.yourdomain.com
```
Certbot จะถามอีเมลและตั้งค่า HTTPS อัตโนมัติ (รวมถึงตั้ง auto-renew ให้แล้ว)

### ขั้นตอนที่ 8 — ทดสอบ
เปิด `https://app.yourdomain.com` และ `https://admin.yourdomain.com` — ดู [checklist ทดสอบ](#8-checklist-ทดสอบหลัง-deploy) ด้านล่าง

---

## 3) แนวทาง B: Manual VPS แบบละเอียดทุกขั้นตอน

เหมาะกับคนอยากเข้าใจ/ควบคุมทุกจุด ไม่ผ่าน Docker

### ขั้นตอนที่ 1 — เช่าเซิร์ฟเวอร์และเข้าถึง
เช่า VPS Ubuntu 22.04 (สเปกเท่าแนวทาง A พอ) แล้ว SSH เข้าไป:
```bash
ssh root@your-server-ip
apt update && apt upgrade -y
```

### ขั้นตอนที่ 2 — สร้าง user แยกสำหรับรันแอป (ไม่ควรรันด้วย root)
```bash
adduser supportapp
usermod -aG sudo supportapp
su - supportapp
```

### ขั้นตอนที่ 3 — ติดตั้ง Node.js 20 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v   # ควรเป็น v20.x
npm -v
```
(`build-essential` จำเป็นสำหรับ compile `better-sqlite3` ถ้าไม่มี prebuilt binary ให้ตรงกับ platform ของเซิร์ฟเวอร์คุณพอดี)

### ขั้นตอนที่ 4 — อัปโหลดโค้ด
```bash
# จากเครื่องคุณ
scp -r support-system-pwa supportapp@your-server-ip:/home/supportapp/

# หรือบนเซิร์ฟเวอร์ ถ้าใช้ Git
git clone <your-repo-url> /home/supportapp/support-system-pwa
```

### ขั้นตอนที่ 5 — ติดตั้งและตั้งค่า Backend
```bash
cd ~/support-system-pwa/backend
npm install
cp .env.example .env
nano .env
```
ตั้งค่าอย่างน้อย `JWT_SECRET` (สุ่มด้วย `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) และ `CORS_ORIGINS`

```bash
npm run seed     # สร้างฐานข้อมูล + บัญชีทดสอบ
node server.js   # ทดสอบรันตรงๆ ก่อน ดูว่า error ไหม แล้วกด Ctrl+C ออก
```

### ขั้นตอนที่ 6 — ติดตั้ง PM2 (process manager ให้ backend รันค้างและ auto-restart)
```bash
sudo npm install -g pm2
pm2 start server.js --name support-backend
pm2 save
pm2 startup    # จะพิมพ์คำสั่งออกมา 1 บรรทัด ให้ copy ไปรันด้วย sudo
```
ตรวจสอบสถานะ:
```bash
pm2 status
pm2 logs support-backend
```

### ขั้นตอนที่ 7 — ติดตั้ง Nginx + Certbot
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### ขั้นตอนที่ 8 — วางไฟล์ frontend ไว้ให้ Nginx เสิร์ฟโดยตรง
```bash
sudo mkdir -p /var/www/support-system
sudo cp -r ~/support-system-pwa/customer /var/www/support-system/customer
sudo cp -r ~/support-system-pwa/admin /var/www/support-system/admin
sudo chown -R www-data:www-data /var/www/support-system
```

### ขั้นตอนที่ 9 — แก้ config.js ให้ชี้โดเมนจริง (ก่อน deploy หรือแก้ตรงบนเซิร์ฟเวอร์ก็ได้)
```bash
sudo nano /var/www/support-system/customer/config.js
sudo nano /var/www/support-system/admin/config.js
```
ใส่ `API_BASE` / `SOCKET_URL` เป็น `https://api.yourdomain.com/...` ตามตัวอย่างในแนวทาง A ขั้นตอนที่ 5

### ขั้นตอนที่ 10 — ตั้งค่า Nginx site config
```bash
sudo cp ~/support-system-pwa/nginx.conf.example /etc/nginx/sites-available/support-system
sudo nano /etc/nginx/sites-available/support-system
```
แก้ `root /var/www/support-system/customer;` และ `root /var/www/support-system/admin;` ให้ตรงกับพาธที่วางไฟล์ไว้จริง (ไฟล์ตัวอย่างมีค่านี้ให้แล้ว แค่เช็คให้ตรง) จากนั้น:
```bash
sudo ln -s /etc/nginx/sites-available/support-system /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### ขั้นตอนที่ 11 — ออก HTTPS
```bash
sudo certbot --nginx -d app.yourdomain.com -d admin.yourdomain.com -d api.yourdomain.com
```
เลือก redirect HTTP→HTTPS อัตโนมัติเมื่อ certbot ถาม (แนะนำเลือก "yes")

### ขั้นตอนที่ 12 — ตั้ง Firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # เปิดพอร์ต 80, 443
sudo ufw enable
sudo ufw status
```

### ขั้นตอนที่ 13 — ทดสอบ
เปิด `https://app.yourdomain.com` และ `https://admin.yourdomain.com` — ดู [checklist ทดสอบ](#8-checklist-ทดสอบหลัง-deploy)

---

## 4) แนวทาง C: Split Deployment

ไม่อยากดูแลเซิร์ฟเวอร์เอง ใช้บริการสำเร็จรูปแทน — ไม่ต้องตั้ง Nginx/certbot/firewall/PM2 เอง เพราะผู้ให้บริการทำ HTTPS + infrastructure ให้หมด เดินตามขั้นตอนนี้ใช้เวลาประมาณ 20-30 นาที

ตัวอย่างนี้ใช้ **Railway** (backend) + **Netlify** (frontend) เป็นหลักเพราะตั้งค่าง่ายที่สุด ส่วนทางเลือกอื่น (Render, Fly.io, Vercel, Cloudflare Pages) สรุปความต่างไว้ท้ายหัวข้อ

### ขั้นตอนที่ 1 — เตรียมโค้ดให้พร้อม deploy
ถ้ายังไม่มี Git repo ให้สร้างก่อน (Railway/Netlify ทำงานกับ Git repo ได้ลื่นที่สุด แม้จะมีวิธี deploy แบบไม่ใช้ Git ก็ตาม):
```bash
cd support-system-pwa
git init
git add .
git commit -m "initial commit"
```
สร้าง repo บน GitHub แล้ว push ขึ้นไป (หรือใช้ GitLab/Bitbucket ก็ได้ ทั้งสองผู้ให้บริการรองรับ)

### ขั้นตอนที่ 2 — Deploy Backend ขึ้น Railway

1. ไปที่ [railway.app](https://railway.app) → สมัคร/ล็อกอินด้วย GitHub
2. **New Project** → **Deploy from GitHub repo** → เลือก repo ที่ push ไว้
3. Railway จะถามหา service — เลือก **Add variables** ทีหลังได้ ตอนนี้ไปที่ **Settings** ของ service ก่อน:
   - **Root Directory**: ใส่ `backend` (สำคัญมาก — บอก Railway ว่าโปรเจกต์ backend อยู่ในโฟลเดอร์ย่อยนี้ ไม่ใช่ root ของ repo)
   - Railway จะเจอ `Dockerfile` อัตโนมัติแล้ว build ด้วย Docker ให้เอง (ไม่ต้องตั้งค่า build command เพิ่ม)
4. ไปที่แท็บ **Variables** เพิ่มตัวแปรทั้งหมดนี้ (อธิบายละเอียดในหัวข้อ 5):
   ```
   NODE_ENV=production
   JWT_SECRET=<สุ่มด้วย node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
   CORS_ORIGINS=https://placeholder.netlify.app
   DB_PATH=/app/data/support.db
   ```
   (ค่า `CORS_ORIGINS` ใส่ placeholder ไปก่อน จะกลับมาแก้เป็นค่าจริงในขั้นตอนที่ 5 หลังได้ URL ของ frontend แล้ว)
5. **สำคัญมาก — ตั้งค่า Persistent Volume** ไม่งั้นฐานข้อมูล SQLite จะหายทุกครั้งที่ redeploy:
   - ไปที่แท็บ **Settings** → เลื่อนหา **Volumes** → **New Volume**
   - Mount path: `/app/data`
   - ขนาด 1GB ก็เกินพอสำหรับ SQLite
6. Railway จะ deploy อัตโนมัติ รอสัก 1-2 นาที ดู log ในแท็บ **Deployments**
7. หลัง deploy สำเร็จ ไปที่แท็บ **Settings** → **Networking** → **Generate Domain** จะได้ URL แบบ `https://your-app.up.railway.app` (มี HTTPS ให้พร้อมอัตโนมัติ)
8. **ไม่ต้องตั้งค่าอะไรเพิ่มสำหรับสร้างฐานข้อมูล** — โค้ดสร้างฐานข้อมูล + บัญชีทดสอบให้อัตโนมัติทุกครั้งที่เซิร์ฟเวอร์เริ่มทำงาน (ปลอดภัย รันซ้ำได้ไม่จำกัด ไม่ทำข้อมูลเดิมหาย) ปล่อยให้ Railway ใช้ `CMD` เดิมจาก Dockerfile (`node server.js`) ได้เลย ไม่ต้องแก้ Custom Start Command
9. ทดสอบ: `curl https://your-app.up.railway.app/api/health` ควรเห็น `{"ok":true,...}`

### ขั้นตอนที่ 3 — แก้ config.js ให้ชี้ไปที่ Railway URL
```bash
nano customer/config.js
```
```js
window.APP_CONFIG = {
  API_BASE: 'https://your-app.up.railway.app/api',
  SOCKET_URL: 'https://your-app.up.railway.app',
};
```
ทำเหมือนกันกับ `admin/config.js` แล้ว commit + push การเปลี่ยนแปลงนี้ขึ้น Git (Netlify จะ build จากโค้ดล่าสุดใน repo)

### ขั้นตอนที่ 4 — Deploy Frontend ขึ้น Netlify (ทำ 2 รอบ แยกไซต์กันสำหรับ customer และ admin)

**วิธีที่ง่ายที่สุด — ลาก-วาง (ไม่ต้องใช้ CLI):**
1. ไปที่ [app.netlify.com](https://app.netlify.com) → สมัคร/ล็อกอิน
2. หน้า Dashboard → ลากโฟลเดอร์ `customer` ทั้งโฟลเดอร์ไปวางในกล่อง "Drag and drop your site output folder here"
3. รอสักครู่ จะได้ URL แบบ `https://random-name-123.netlify.app` ทันที (มี HTTPS ให้แล้ว)
4. (แนะนำ) เปลี่ยนชื่อไซต์ให้จำง่าย: **Site settings** → **Change site name** → ใส่ชื่อเช่น `mycompany-support-app`
5. ทำซ้ำขั้นตอน 2-4 กับโฟลเดอร์ `admin` — **ต้องเป็นไซต์ใหม่แยกต่างหาก** ไม่ใช่ไซต์เดียวกัน

**หรือใช้ Netlify CLI (เชื่อมกับ Git ได้ ทำให้ redeploy อัตโนมัติทุกครั้งที่ push):**
```bash
npm install -g netlify-cli
netlify login

cd customer
netlify deploy --prod   # ครั้งแรกจะถามให้สร้างไซต์ใหม่ — เลือก "Create & configure a new site"

cd ../admin
netlify deploy --prod   # สร้างเป็นอีกไซต์แยกต่างหาก
```

จะได้ URL 2 อัน เช่น:
```
https://support-customer.netlify.app
https://support-admin.netlify.app
```

### ขั้นตอนที่ 5 — กลับไปแก้ CORS_ORIGINS ที่ Railway ให้ตรงกับ URL จริง

กลับไปที่ Railway → service backend → แท็บ **Variables** → แก้ `CORS_ORIGINS`:
```
CORS_ORIGINS=https://support-customer.netlify.app,https://support-admin.netlify.app
```
Railway จะ redeploy service ให้อัตโนมัติทันทีที่บันทึกค่าตัวแปร (ไม่ต้องกดอะไรเพิ่ม)

### ขั้นตอนที่ 6 — ทดสอบ
เปิด `https://support-customer.netlify.app` และ `https://support-admin.netlify.app` — ดู [checklist ทดสอบ](#8-checklist-ทดสอบหลัง-deploy) แล้วเช็ค DevTools Console (F12) ว่าไม่มี CORS error สีแดงตอนล็อกอิน/โหลดข้อมูล

### ⚠️ ข้อควรระวังเฉพาะแนวทางนี้

**Render มีปัญหา "cold start":** ถ้าเลือกใช้ Render แทน Railway บน free tier บริการจะ sleep หลังไม่มีคนใช้ 15 นาที ทำให้ request แรกช้า (10-30 วินาที) และ **Socket.io connection จะหลุดเวลา sleep** — ถ้าจะใช้ Render จริงจัง ควรอัปเกรดเป็น paid tier (ไม่ sleep) หรือใช้ Railway/Fly.io แทนสำหรับ backend ที่ต้องมี WebSocket ค้างสายตลอดเวลาแบบนี้

**Persistent volume คือสิ่งที่ลืมบ่อยที่สุด:** ถ้าลืมตั้งค่า Volume ตามขั้นตอนที่ 2.5 ข้อมูลทั้งหมด (ผู้ใช้, ticket, ข้อความแชท) จะ**หายทุกครั้งที่ backend redeploy** (เช่นตอน push โค้ดใหม่) — เช็คให้แน่ใจว่าตั้งไว้แล้วก่อนใช้งานจริง

**Custom domain:** ทั้ง Railway และ Netlify ให้ผูก custom domain ของคุณเองได้ฟรีในหน้า Settings ถ้าไม่อยากใช้ `.up.railway.app`/`.netlify.app` — วิธีการต่างกันเล็กน้อยตามแต่ละผู้ให้บริการ ดูเอกสารของแต่ละเจ้าประกอบ

### ตัวอย่างที่ 2 — Backend บน Render + Frontend บน Vercel

ขั้นตอนแบบเดียวกับ Railway + Netlify ทุกประการ แค่หน้าตา dashboard ต่างกัน — คู่มือฉบับเต็มแบบละเอียดทุกช่องตั้งค่า (พร้อมตัวอย่างการตั้งค่า `config.js` ให้สร้างอัตโนมัติจาก Environment Variables ตอน build แทนการแก้ไฟล์ด้วยมือ) แยกไว้ต่างหากที่ **[`DEPLOY_RENDER_VERCEL.md`](./DEPLOY_RENDER_VERCEL.md)** เพราะมีรายละเอียดค่อนข้างเยอะ

สรุปสั้นๆ ถ้าคุ้นกับ Railway/Netlify แล้ว: Render ตั้งค่าคล้าย Railway มาก (เชื่อม repo → Root Directory `backend` → Persistent Disk ที่ `/app/data` → Environment Variables ชุดเดียวกัน) ส่วน Vercel ก็คล้าย Netlify (เชื่อม repo หรือใช้ CLI, Root Directory ชี้ไปที่ `customer`/`admin` แยกกัน 2 โปรเจกต์) — ความต่างหลักคือ Render มีปัญหา cold start บน free tier (ดูหัวข้อคำเตือนด้านล่าง) และ Vercel ในคู่มือฉบับเต็มใช้เทคนิค build-time env var แทนการแก้ `config.js` ด้วยมือ

### ทางเลือกอื่นนอกจาก Railway/Netlify/Render/Vercel

| ต้องการ | ทางเลือก | ข้อแตกต่าง |
|---|---|---|
| Backend | **Fly.io** | ใช้ CLI (`flyctl launch` ในโฟลเดอร์ `backend/`) แทน dashboard, ต้องสร้าง volume ด้วย `fly volumes create`, เหมาะถ้าอยากได้ performance ดีและ region ใกล้ผู้ใช้ในไทย (มี region สิงคโปร์) |
| Frontend | **Cloudflare Pages** | เชื่อม repo แล้วตั้ง build output directory เป็น `customer` หรือ `admin` ตามแต่ละไซต์, มี CDN ที่เร็วมากในไทยเพราะ Cloudflare มี edge server ในประเทศ |

---

## 5) ตัวแปร Environment ทั้งหมด

ไฟล์ `backend/.env` (คัดลอกจาก `.env.example`):

| ตัวแปร | คำอธิบาย | ค่าเริ่มต้น/ตัวอย่าง |
|---|---|---|
| `PORT` | พอร์ตที่ backend รัน | `4000` |
| `CORS_ORIGINS` | โดเมนที่อนุญาตให้เรียก API ได้ (คั่นด้วยจุลภาค) | `https://app.yourdomain.com,https://admin.yourdomain.com` |
| `JWT_SECRET` | กุญแจเซ็น JWT — **ต้องสุ่มใหม่เสมอ ห้ามใช้ค่าตัวอย่าง** | สุ่มด้วย `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ACCESS_TOKEN_TTL` | อายุ access token | `15m` |
| `REFRESH_TOKEN_DAYS` | อายุ refresh token (วัน) | `30` |
| `DB_PATH` | ตำแหน่งไฟล์ SQLite — ต้องอยู่บน disk ที่ persist ได้ | `./data/support.db` |
| `SERVE_FRONTENDS` | ถ้า `true` จะให้ backend เสิร์ฟไฟล์ frontend เองที่ `/app` และ `/admin` (ทางเลือกแทนการแยก subdomain) | `false` |
| `TURN_URL` | URL ของ TURN server (ไม่บังคับ) | ว่างไว้ = ใช้ STUN อย่างเดียว |
| `TURN_SECRET` | secret ของ TURN server (ต้องตรงกับ `turnserver.conf`) | ว่างไว้ = ปิด TURN |
| `TURN_CREDENTIAL_TTL` | อายุ credential ของ TURN (วินาที) | `3600` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | กุญแจสำหรับ push notification จริง | ว่างไว้ = ปิด push (ดูหัวข้อ 6) |
| `VAPID_SUBJECT` | อีเมลติดต่อสำหรับ push service | `mailto:admin@example.com` |

**ไฟล์ `customer/config.js` และ `admin/config.js`** (ไม่ใช่ `.env` — เป็น JS ธรรมดาที่โหลดในเบราว์เซอร์):
```js
window.APP_CONFIG = {
  API_BASE: 'https://api.yourdomain.com/api',   // ต้องมี /api ต่อท้าย
  SOCKET_URL: 'https://api.yourdomain.com',      // ไม่ต้องมี /api
};
```

---

## 6) ตั้งค่า Push Notifications (VAPID)

ไม่บังคับ — ถ้าข้ามขั้นตอนนี้ ระบบยังทำงานปกติทุกอย่าง เพียงแต่จะไม่มี native push notification ตอนแอปไม่ได้เปิดอยู่ (แจ้งเตือนแบบเรียลไทม์ผ่าน Socket.io ตอนแอปเปิดอยู่ยังทำงานตามปกติ)

```bash
cd backend
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys(),null,2))"
```
จะได้ผลลัพธ์แบบนี้:
```json
{
  "publicKey": "BGRpPZP...",
  "privateKey": "zyuR7Y..."
}
```
คัดลอกไปใส่ใน `.env`:
```
VAPID_PUBLIC_KEY=BGRpPZP...
VAPID_PRIVATE_KEY=zyuR7Y...
VAPID_SUBJECT=mailto:you@yourdomain.com
```
รีสตาร์ท backend (`pm2 restart support-backend` หรือ `docker compose restart backend`) เท่านี้ก็เปิดใช้งานแล้ว — ทั้งสองแอปจะขอสิทธิ์แจ้งเตือนจากผู้ใช้อัตโนมัติหลังล็อกอิน

---

## 7) ตั้งค่า TURN Server

ไม่บังคับเช่นกัน — STUN (ค่าเริ่มต้น) พอสำหรับเครือข่ายทั่วไป ใส่ TURN เพิ่มถ้าลูกค้า/แอดมินของคุณมักอยู่หลังเครือข่ายองค์กรที่บล็อก peer-to-peer

**Self-host ด้วย coturn** (มี service ให้พร้อมใน `docker-compose.yml`):
```bash
# 1. สุ่ม secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. ใส่ค่าเดียวกันในสองที่:
nano turnserver.conf     # แก้บรรทัด static-auth-secret=...
nano backend/.env        # แก้ TURN_SECRET=...

# 3. ตั้ง TURN_URL ใน backend/.env
TURN_URL=turn:<IP เซิร์ฟเวอร์ของคุณ>:3478

# 4. เปิดพอร์ตในไฟร์วอลล์ (สำคัญมาก ถ้าลืมขั้นนี้ TURN จะใช้งานไม่ได้)
sudo ufw allow 3478
sudo ufw allow 49152:65535/udp

# 5. รีสตาร์ท
docker compose up -d turn backend    # ถ้าใช้แนวทาง A
```

ถ้าไม่ใช้ Docker (แนวทาง B) ต้องติดตั้ง coturn เองด้วย `apt install coturn` แล้วใช้ `turnserver.conf` ที่ให้มาเป็น config

**หรือใช้บริการสำเร็จรูป** (ไม่ต้องดูแลเซิร์ฟเวอร์เอง): Twilio Network Traversal Service, Xirsys, Cloudflare Calls, Metered.ca — สมัครแล้วนำ URL/secret ที่ได้ไปใส่ `TURN_URL`/`TURN_SECRET` ตามรูปแบบที่แต่ละเจ้ากำหนด

---

## 8) Checklist ทดสอบหลัง Deploy

> 🔒 ก่อนอ่าน checklist ด้านล่าง แนะนำให้ทำตาม **[`SECURITY.md`](./SECURITY.md)** ให้ครบก่อน (เปลี่ยนบัญชีทดสอบ, สุ่ม secret, ตั้ง firewall ฯลฯ) — checklist ด้านล่างนี้เน้นตรวจสอบว่า "ระบบทำงานถูกต้อง" ส่วน SECURITY.md เน้น "ระบบปลอดภัย" ทั้งสองไฟล์ควรทำคู่กัน

ทำตามลำดับนี้หลัง deploy เสร็จ:

- [ ] เปิด `https://api.yourdomain.com/api/health` — ต้องเห็น `{"ok":true,...}`
- [ ] เปิด `https://app.yourdomain.com` — หน้าล็อกอินขึ้นถูกต้อง ไม่มี error ใน Console (กด F12)
- [ ] ล็อกอินด้วย `customer` / `customer1234` (หรือบัญชีจริงที่สร้างไว้) — เข้าหน้าหลักได้
- [ ] เปิด `https://admin.yourdomain.com` แล้วล็อกอินด้วย `admin` / `admin1234` — เห็นแดชบอร์ด
- [ ] **เปลี่ยนรหัสผ่านบัญชีทดสอบทั้งสองทันที** หรือลบทิ้งแล้วสร้างบัญชีจริง (ดูหมายเหตุด้านล่าง)
- [ ] ทดสอบแชท: ส่งข้อความจากฝั่งลูกค้า แล้วเช็คว่าขึ้นในกล่องข้อความฝั่งแอดมินแบบเรียลไทม์
- [ ] ทดสอบวิดีโอคอล: กดโทรจากฝั่งลูกค้า เบราว์เซอร์ขอสิทธิ์กล้อง/ไมค์ → รับสายฝั่งแอดมิน → เห็นภาพ/เสียงทั้งสองฝั่ง
- [ ] ทดสอบสลับโหมด AI Avatar ↔ หน้าจริง ระหว่างสายจากฝั่งแอดมิน
- [ ] ทดสอบติดตั้งเป็นแอป: บนมือถือ เปิดเว็บ → "เพิ่มไปยังหน้าจอโฮม" → เปิดจากไอคอนแล้วทำงานแบบ standalone (ไม่มีแถบ URL)
- [ ] ถ้าตั้งค่า Push ไว้: อนุญาต notification แล้วลองส่ง ticket ใหม่ ดูว่าแอดมินได้รับแจ้งเตือนแม้ปิดแอปอยู่

> ⚠️ **สำคัญด้านความปลอดภัย:** บัญชี `admin`/`admin1234` และ `customer`/`customer1234` เป็นบัญชีตัวอย่างจาก `npm run seed` เท่านั้น **ต้องเปลี่ยนรหัสผ่านหรือลบทิ้งก่อนเปิดให้ใช้งานจริงเด็ดขาด** มิเช่นนั้นใครก็เข้าระบบแอดมินได้

---

## 9) การบำรุงรักษา

### อัปเดตโค้ดเวอร์ชันใหม่ (Docker)
```bash
cd /opt/support-system-pwa
git pull   # หรืออัปโหลดไฟล์ใหม่ทับ
docker compose up -d --build
```

### อัปเดตโค้ดเวอร์ชันใหม่ (Manual/PM2)
```bash
cd ~/support-system-pwa
git pull
cd backend && npm install
pm2 restart support-backend
sudo cp -r ../customer/* /var/www/support-system/customer/
sudo cp -r ../admin/* /var/www/support-system/admin/
```

### Backup ฐานข้อมูล
SQLite คือไฟล์เดียว สำรองง่ายมาก:
```bash
# Docker
docker compose exec backend cp /app/data/support.db /app/data/backup-$(date +%Y%m%d).db

# Manual
cp ~/support-system-pwa/backend/data/support.db ~/backups/support-$(date +%Y%m%d).db
```
แนะนำตั้ง cron job รันทุกวัน แล้ว sync ไฟล์ backup ไปเก็บที่อื่น (S3, Google Drive ฯลฯ) ด้วย ไม่ใช่เก็บไว้เครื่องเดียวกับต้นฉบับ

### ดู Logs
```bash
# Docker
docker compose logs -f backend

# PM2
pm2 logs support-backend
pm2 monit    # ดู CPU/memory แบบ real-time
```

---

## 10) Troubleshooting

**ปัญหา: เปิดแอปแล้วขึ้นหน้าขาว/error ใน console ว่า "Failed to fetch"**
→ `config.js` ยังชี้ไปที่ `localhost` อยู่ หรือ `CORS_ORIGINS` ใน backend ไม่ตรงกับโดเมนจริง เช็คทั้งสองจุด

**ปัญหา: ติดตั้งเป็นแอปบนมือถือไม่ได้ (ไม่มีตัวเลือก "เพิ่มไปยังหน้าจอโฮม")**
→ ต้องเป็น HTTPS เท่านั้น เช็คว่า certbot ออก certificate สำเร็จหรือยัง (`sudo certbot certificates`)

**ปัญหา: วิดีโอคอลไม่ติด ขึ้นค้างที่ "กำลังเชื่อมต่อ..."**
→ มักเป็นเพราะเครือข่ายฝั่งใดฝั่งหนึ่งบล็อก peer-to-peer และไม่มี TURN server ตั้งไว้ ดูหัวข้อ 7

**ปัญหา: `npm install` ใน backend ล้มเหลวที่ `better-sqlite3`**
→ เซิร์ฟเวอร์ไม่มี prebuilt binary ให้ตรง platform ติดตั้ง build tools แล้วลองใหม่:
```bash
sudo apt install -y build-essential python3
npm install
```

**ปัญหา: Push notification ไม่ทำงาน**
→ เช็คว่าใส่ `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` ครบและรีสตาร์ท backend แล้ว, เช็คว่าเบราว์เซอร์อนุญาต Notification permission (ไอคอนกุญแจข้าง URL bar)

**ปัญหา: PM2 ไม่ auto-start หลัง reboot เซิร์ฟเวอร์**
→ ลืมรันคำสั่งที่ `pm2 startup` พิมพ์ออกมา (ต้อง copy ไปรันด้วย `sudo` อีกที) หรือลืม `pm2 save` หลัง start

**ยังแก้ไม่ได้?** เช็ค log ทั้งฝั่ง Nginx (`sudo tail -f /var/log/nginx/error.log`) และฝั่ง backend (`pm2 logs` หรือ `docker compose logs backend`) เกือบทุกปัญหาจะเห็นสาเหตุชัดเจนใน log สองจุดนี้
