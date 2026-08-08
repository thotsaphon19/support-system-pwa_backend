# คู่มือความปลอดภัย (Security Hardening Guide)

เอกสารนี้รวมทุกจุดที่ควรทำเพื่อ deploy ระบบนี้อย่างปลอดภัย ทั้งสิ่งที่ **ทำไว้ให้แล้วในโค้ด** (ตรวจสอบ/ทดสอบแล้ว) และสิ่งที่ **คุณต้องทำเองตอน deploy** (ระดับเซิร์ฟเวอร์/โครงสร้างพื้นฐาน ซึ่งอยู่นอกเหนือขอบเขตของโค้ดแอปพลิเคชัน)

---

## ✅ สิ่งที่มีอยู่ในโค้ดแล้ว (ทดสอบแล้ว)

| หัวข้อ | รายละเอียด |
|---|---|
| **Fail-fast บน insecure config** | ถ้ารันด้วย `NODE_ENV=production` แล้ว `JWT_SECRET` หรือ `CORS_ORIGINS` ยังเป็นค่าเริ่มต้น/placeholder เซิร์ฟเวอร์จะ**ปฏิเสธการ start ทันที** พร้อม error ชัดเจน — ป้องกันการ deploy ทับด้วยความเผลอ |
| **Security headers (Helmet)** | ทุก response จาก backend มี `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `X-DNS-Prefetch-Control` เป็นต้น |
| **Rate limiting หลายชั้น** | Login/register (20 ครั้ง/15 นาที), สร้างงานแจ้งใหม่ (15 ครั้ง/10 นาที), สั่งซื้อสินค้า/เช็คเอาท์ (20 ครั้ง/10 นาที), ทุก endpoint ของ API (300 ครั้ง/นาที) และแชท (20 ข้อความ/10 วินาทีต่อ connection) |
| **Password hashing** | bcrypt (ไม่มีการเก็บรหัสผ่าน plaintext ที่ใดเลย) |
| **JWT แบบ short-lived + refresh token rotation** | access token อายุ 15 นาที, refresh token หมุนเวียนทุกครั้งที่ใช้ (ใช้ซ้ำไม่ได้ ป้องกัน token replay) |
| **SQL Injection protection** | ทุก query ใช้ prepared statements (`db.prepare(...).run(...)`) ไม่มีการต่อ string SQL จาก input ผู้ใช้เลย |
| **Input validation** | ความยาว title/description, ค่า enum ของ status/priority ถูกตรวจสอบทั้งฝั่ง POST และ PATCH |
| **Authorization checks** | ลูกค้าเห็น/แก้ได้แค่ข้อมูลของตัวเอง (บังคับที่ระดับ query ไม่ใช่แค่ UI), Socket.io บังคับ `customer_id` จาก JWT เสมอสำหรับ role ลูกค้า (ปลอมเป็นคนอื่นไม่ได้) |
| **CORS ที่ตั้งค่าได้** | ไม่เปิดกว้างแบบ `*` โดย default ในโหมด production (ถูก fail-fast บล็อกไว้) |
| **Docker รันด้วย non-root user** | Container รันโปรเซส Node ด้วย user `node` ไม่ใช่ `root` |
| **`.gitignore`** | ป้องกัน `.env`, ไฟล์ฐานข้อมูล, และ `node_modules` หลุดเข้า git repo โดยไม่ตั้งใจ |
| **Nginx security headers ตัวอย่าง** | `nginx.conf.example` มี `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS (เปิดอัตโนมัติหลัง certbot), rate limiting ระดับ Nginx เป็นชั้นป้องกันเพิ่มจากระดับแอป |

---

## ⚠️ สิ่งที่คุณต้องทำเองตอน Deploy (สำคัญมาก — ห้ามข้าม)

### 1. เปลี่ยนบัญชีทดสอบทันที
`npm run seed` สร้างบัญชี `admin`/`admin1234` และ `customer`/`customer1234` ไว้สำหรับทดสอบเท่านั้น **ต้องเปลี่ยนรหัสผ่านหรือลบทิ้งก่อนเปิดใช้งานจริงเด็ดขาด** วิธีลบ/แก้ไข:
```bash
cd backend
node -e "
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const hash = bcrypt.hashSync('รหัสผ่านใหม่ที่ปลอดภัย', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
console.log('เปลี่ยนรหัสผ่านแล้ว');
"
```

### 2. สุ่ม secret ทุกตัวใหม่ — ห้ามใช้ค่าตัวอย่าง
```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# TURN_SECRET (ถ้าใช้ TURN)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
ใส่ค่าที่สุ่มได้ลงใน `.env` — ห้ามใช้ค่า `change-this-...` ที่มากับไฟล์ตัวอย่างเด็ดขาด (ระบบจะ fail-fast บล็อกไว้ให้อยู่แล้วถ้าเผลอ แต่ควรตั้งใจทำให้ถูกตั้งแต่แรก)

### 3. `CORS_ORIGINS` ต้องระบุโดเมนจริงเท่านั้น
```
CORS_ORIGINS=https://app.yourdomain.com,https://admin.yourdomain.com
```
ห้ามใช้ `*` ในการใช้งานจริง (ระบบ fail-fast บล็อกไว้แล้วเช่นกัน)

### 4. HTTPS บังคับเสมอ — ห้าม deploy ด้วย HTTP
PWA, Push Notification, และกล้อง/ไมค์ (`getUserMedia`) ใช้งานไม่ได้เลยถ้าไม่ใช่ HTTPS (ยกเว้น `localhost`) ใช้ certbot ตามที่อธิบายใน `DEPLOYMENT.md` — ฟรีและ auto-renew ให้อัตโนมัติ

### 5. Firewall — เปิดเฉพาะพอร์ตที่จำเป็น
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 80, 443
# เปิดเพิ่มเฉพาะถ้าใช้ TURN self-hosted:
# sudo ufw allow 3478
# sudo ufw allow 49152:65535/udp
sudo ufw enable
```
**อย่าเปิดพอร์ต 4000 (backend) ออกสู่อินเทอร์เน็ตโดยตรง** — ให้ Nginx เป็นตัวกลางเสมอ (`proxy_pass` ไปยัง `127.0.0.1:4000` ซึ่งเป็น localhost เท่านั้น ไม่ expose ออกนอก)

### 6. SSH — ปิดการล็อกอินด้วยรหัสผ่าน ใช้ key เท่านั้น
```bash
sudo nano /etc/ssh/sshd_config
```
ตั้งค่า:
```
PasswordAuthentication no
PermitRootLogin no
```
```bash
sudo systemctl restart sshd
```
(ทำหลังจากตั้งค่า SSH key login และทดสอบเข้าได้แล้วเท่านั้น ไม่งั้นจะล็อกตัวเองออกจากเซิร์ฟเวอร์)

### 7. ติดตั้ง Fail2ban (ป้องกัน brute-force ที่ระดับ SSH/Nginx)
```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

### 8. เปิด Auto security updates
```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

### 9. Backup ฐานข้อมูล + เก็บนอกเซิร์ฟเวอร์
ดูวิธีใน `DEPLOYMENT.md` หัวข้อ "การบำรุงรักษา" — **สำรองไว้เครื่องเดียวกับต้นฉบับไม่นับเป็น backup จริง** ต้อง sync ไปที่อื่น (S3, อีกเซิร์ฟเวอร์ ฯลฯ) ด้วย

### 10. จำกัดผู้เข้าถึงหน้าแอดมิน (แนะนำ)
ถ้าทีมงานเข้าถึงจากที่อยู่ IP คงที่หรือผ่าน VPN บริษัท เพิ่มการจำกัด IP ที่ Nginx (มีตัวอย่าง comment ไว้ใน `nginx.conf.example` แล้ว — เอา `#` ออกแล้วใส่ IP/CIDR ของคุณ) เป็นชั้นป้องกันเพิ่มเหนือ JWT auth ปกติ

### 11. ตรวจสอบ dependency vulnerabilities สม่ำเสมอ
```bash
cd backend
npm audit
npm audit fix   # แก้ให้อัตโนมัติเท่าที่ทำได้โดยไม่ breaking change
```
รันเป็นประจำ (แนะนำตั้ง reminder รายเดือน หรือใช้ Dependabot ถ้าใช้ GitHub)

---

## 🔒 ข้อจำกัดที่ควรรู้ (Known Limitations)

**Token เก็บใน localStorage:** access/refresh token เก็บใน `localStorage` ของเบราว์เซอร์ ซึ่งหมายความว่าถ้าเว็บแอปมีช่องโหว่ XSS (เช่น ถูกฉีด script ที่เป็นอันตราย) token จะถูกขโมยได้ — โค้ดทั้งหมดใน UI ใช้ `escapeHtml()`/`textContent` ในจุดที่แสดงข้อความจากผู้ใช้ (ไม่ใช้ `innerHTML` กับข้อมูลดิบ) เพื่อลดความเสี่ยงนี้ แต่ถ้าจะให้ปลอดภัยยิ่งขึ้นในระดับ enterprise ควรพิจารณาย้ายไปใช้ HttpOnly cookie + CSRF token แทน localStorage — เป็นการเปลี่ยนสถาปัตยกรรม auth ที่ใหญ่กว่านี้ ไม่ได้ทำไว้ในเวอร์ชันนี้

**SQLite ไม่รองรับ concurrent writes จำนวนมาก:** เหมาะกับธุรกิจขนาดเล็ก-กลาง ถ้าจะสเกลใหญ่ (ผู้ใช้พร้อมกันหลักพัน) ต้องย้ายไป Postgres (ดู `README.md` หัวข้อ "การขยับไป Postgres")

**ไม่มี 2FA:** ระบบยืนยันตัวตนด้วย username/password + JWT เท่านั้น ยังไม่มี two-factor authentication ถ้าต้องการระดับความปลอดภัยสูงกว่านี้สำหรับบัญชีแอดมิน ควรเพิ่มเข้าไป (เช่น TOTP ผ่าน `speakeasy`/`otplib`)

**ไม่มี audit log:** การกระทำของแอดมิน (เปลี่ยนสถานะงาน, แก้ไขบทความ ฯลฯ) ไม่ได้ถูกบันทึกเป็น audit trail แยกต่างหาก ถ้าต้องการตรวจสอบย้อนหลังว่าใครทำอะไรเมื่อไหร่ ควรเพิ่มตาราง `audit_log` และบันทึกทุก mutation

---

## สรุป Checklist ก่อนเปิดใช้งานจริง

- [ ] เปลี่ยน/ลบบัญชีทดสอบ `admin`/`customer`
- [ ] สุ่ม `JWT_SECRET` ใหม่ (และ `TURN_SECRET` ถ้าใช้)
- [ ] ตั้ง `CORS_ORIGINS` เป็นโดเมนจริง ไม่ใช่ `*`
- [ ] มี HTTPS ทำงานถูกต้องทั้ง 3 โดเมน (app/admin/api)
- [ ] Firewall เปิดเฉพาะ 22 (SSH), 80, 443 (และ 3478+49152-65535/udp ถ้าใช้ TURN)
- [ ] SSH ปิด password login แล้ว
- [ ] ติดตั้ง fail2ban แล้ว
- [ ] เปิด auto security updates แล้ว
- [ ] ตั้ง backup อัตโนมัติ + เก็บนอกเซิร์ฟเวอร์แล้ว
- [ ] รัน `npm audit` แล้วไม่มีช่องโหว่ระดับ high/critical ค้างอยู่
- [ ] ทดสอบตาม checklist ใน `DEPLOYMENT.md` หัวข้อ 8 ครบทุกข้อ
