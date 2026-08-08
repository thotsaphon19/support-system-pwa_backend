// seed.js — populates demo data (users, tickets, KB, announcements) on first run.
// Exports an async function so server.js can call it automatically on every startup
// (safe — every insert below checks first and skips if data already exists, so it
// never duplicates or wipes real data on later deploys/restarts).
//
// Can still be run standalone too: `npm run seed` / `node seed.js`
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, migrate } = require('./db');

async function seed() {
  await migrate();

  async function upsertUser({ role, username, password, name, phone, position }) {
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return existing.id;
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.run(
      'INSERT INTO users (role, username, password_hash, name, phone, position) VALUES (?,?,?,?,?,?)',
      [role, username, hash, name, phone || null, position || null]
    );
    return info.lastInsertRowid;
  }

  const adminId = await upsertUser({ role: 'admin', username: 'admin', password: 'admin1234', name: 'นภัสรา ใจดี', position: 'เจ้าหน้าที่ฝ่ายบริการ' });
  const customerId = await upsertUser({ role: 'customer', username: 'customer', password: 'customer1234', name: 'ลูกค้า สมชาย', phone: '081-234-5678' });

  // conversation for the demo customer — messages are no longer pre-seeded here; the first
  // real welcome message is generated dynamically by GET /api/chat/me (see routes/chat.js),
  // sourced from the admin-configurable "chat_welcome_messages" setting.
  const existingConv = await db.get('SELECT id FROM conversations WHERE customer_id = ?', [customerId]);
  if (!existingConv) await db.run('INSERT INTO conversations (customer_id) VALUES (?)', [customerId]);

  // One-time cleanup: earlier versions of this seed script hardcoded a fixed greeting
  // message into the demo conversation, which blocked the dynamic/admin-configurable
  // welcome message above from ever running (that logic only fires on an empty
  // conversation). Remove it so already-seeded installs pick up the new behavior too.
  await db.run("DELETE FROM messages WHERE sender_role = 'admin' AND text = 'สวัสดีค่ะ 😊 ยินดีให้บริการค่ะ มีอะไรให้ช่วยไหมคะ'");

  const ticketCount = Number((await db.get('SELECT COUNT(*) c FROM tickets')).c);
  if (ticketCount === 0) {
    const now = new Date();
    const demoTickets = [
      { title: 'ไม่สามารถเข้าสู่ระบบได้', description: 'ลูกค้าแจ้งไม่สามารถเข้าสู่ระบบได้หลังอัปเดตแอปเวอร์ชันล่าสุด', channel: 'โทรศัพท์', priority: 'สูง', status: 'รอดำเนินการ' },
      { title: 'สอบถามการใช้งานระบบ', description: 'สอบถามวิธีการรีเซ็ตรหัสผ่านและการตั้งค่าบัญชีผู้ใช้งานใหม่', channel: 'ไลน์', priority: 'ปานกลาง', status: 'กำลังดำเนินการ' },
      { title: 'ขอรีเซ็ตรหัสผ่าน', description: 'รีเซ็ตรหัสผ่านเรียบร้อยแล้ว ลูกค้ายืนยันเข้าสู่ระบบได้ปกติ', channel: 'เว็บไซต์', priority: 'ปานกลาง', status: 'เสร็จสิ้น' },
    ];
    for (let i = 0; i < demoTickets.length; i++) {
      const t = demoTickets[i];
      const d = new Date(now.getTime() - i * 86400000);
      await db.run(`INSERT INTO tickets
        (id, customer_id, title, description, channel, priority, status, assigned_admin_id, created_at, updated_at)
        VALUES (@id,@customer_id,@title,@description,@channel,@priority,@status,@assigned_admin_id,@created_at,@updated_at)`, {
        id: 'TK-' + d.toISOString().slice(0,10).replace(/-/g,'') + '-' + String(i+1).padStart(3,'0'),
        customer_id: customerId,
        title: t.title,
        description: t.description,
        channel: t.channel,
        priority: t.priority,
        status: t.status,
        assigned_admin_id: adminId,
        created_at: d.toISOString(),
        updated_at: d.toISOString(),
      });
    }
  }

  const kbCount = Number((await db.get('SELECT COUNT(*) c FROM kb_articles')).c);
  if (kbCount === 0) {
    await db.run('INSERT INTO kb_articles (title, body, tag, views) VALUES (?,?,?,?)',
      ['วิธีการรีเซ็ตรหัสผ่าน', 'กดปุ่ม "ลืมรหัสผ่าน" บนหน้าเข้าสู่ระบบ กรอกอีเมลที่ลงทะเบียนไว้ ตรวจสอบอีเมลและกดลิงก์สำหรับรีเซ็ต จากนั้นตั้งรหัสผ่านใหม่และเข้าสู่ระบบอีกครั้ง', 'บัญชีผู้ใช้', 1240]);
    await db.run('INSERT INTO kb_articles (title, body, tag, views) VALUES (?,?,?,?)',
      ['การใช้งานระบบสำหรับผู้ใช้ใหม่', 'เมื่อเข้าสู่ระบบครั้งแรก แนะนำให้ตั้งค่าโปรไฟล์ให้ครบถ้วน จากนั้นสามารถเริ่มใช้เมนูหลักได้จากหน้าแรก หากมีข้อสงสัยสามารถแชทสอบถามแอดมินได้ตลอดเวลา', 'เริ่มต้นใช้งาน', 980]);
    await db.run('INSERT INTO kb_articles (title, body, tag, views) VALUES (?,?,?,?)',
      ['การอัปโหลดเอกสารไม่สำเร็จ แก้ไขอย่างไร', 'ตรวจสอบว่าไฟล์มีขนาดไม่เกิน 10MB และเป็นไฟล์นามสกุล PDF, JPG หรือ PNG หากยังอัปโหลดไม่สำเร็จ ลองรีเฟรชหน้าเว็บหรือติดต่อแอดมินเพื่อขอความช่วยเหลือ', 'เอกสาร', 754]);
  }

  const annCount = Number((await db.get('SELECT COUNT(*) c FROM announcements')).c);
  if (annCount === 0) {
    await db.run('INSERT INTO announcements (title, body, icon) VALUES (?,?,?)',
      ['แจ้งปรับปรุงระบบชั่วคราว', 'ระบบจะปิดให้บริการเพื่อปรับปรุงประสิทธิภาพ วันที่ 25 พ.ค. 2569 เวลา 00:00 - 02:00 น.', '📢']);
    await db.run('INSERT INTO announcements (title, body, icon) VALUES (?,?,?)',
      ['แบบประเมินความพึงพอใจ', 'ขอความร่วมมือลูกค้าทุกท่านทำแบบประเมินความพึงพอใจในการให้บริการ เพื่อนำไปพัฒนาปรับปรุงต่อไป', '🎁']);
  }

  // ---------- Lazmall storefront demo data ----------
  const catCount = Number((await db.get('SELECT COUNT(*) c FROM categories')).c);
  if (catCount === 0) {
    const cats = [
      ['อิเล็กทรอนิกส์', '🔌', 1], ['แฟชั่น', '👕', 2], ['ของใช้ในบ้าน', '🏠', 3],
      ['ความงาม', '💄', 4], ['อาหาร & เครื่องดื่ม', '🍱', 5], ['ทั่วไป', '🗂️', 6],
    ];
    for (const [name, icon, sort] of cats) {
      await db.run('INSERT INTO categories (name, icon, sort_order) VALUES (?,?,?)', [name, icon, sort]);
    }
  } else {
    // Runs on every startup (not just first seed) so stores that were already seeded before
    // "ทั่วไป" existed still get it added — the products page's หมวดหมู่ทั่วไป section needs
    // a real, admin-manageable category to assign products to.
    const generalCat = await db.get("SELECT id FROM categories WHERE name = 'ทั่วไป'");
    if (!generalCat) {
      const maxSort = Number((await db.get('SELECT COALESCE(MAX(sort_order), 0) m FROM categories')).m);
      await db.run('INSERT INTO categories (name, icon, sort_order) VALUES (?,?,?)', ['ทั่วไป', '🗂️', maxSort + 1]);
    }
  }

  const productCount = Number((await db.get('SELECT COUNT(*) c FROM products')).c);
  if (productCount === 0) {
    const cats = await db.all('SELECT id, name FROM categories');
    const catId = (name) => (cats.find(c => c.name === name) || {}).id || null;
    // image: real product photos (via LoremFlickr keyword search) so the storefront shows
    // actual photography instead of cartoon emoji icons. Admins can replace these with real
    // photos of their own products any time from the "จัดการสินค้า" screen.
    const demoProducts = [
      { cat: 'อิเล็กทรอนิกส์', name: 'หูฟังไร้สายตัดเสียงรบกวน', desc: 'เสียงคมชัด แบตอึด 30 ชม. ตัดเสียงรบกวนรอบข้างได้ดีเยี่ยม เหมาะสำหรับทำงานและเดินทาง', price: 1290, compare: 1990, icon: '🎧', image: 'https://loremflickr.com/600/600/headphones?lock=101', stock: 42, sold: 318, rating: 4.8 },
      { cat: 'อิเล็กทรอนิกส์', name: 'สายชาร์จ USB-C ถัก 2 เมตร', desc: 'ทนทาน ชาร์จเร็ว รองรับ Fast Charge ทุกรุ่นที่ใช้ USB-C', price: 129, compare: 199, icon: '🔌', image: 'https://loremflickr.com/600/600/usbcable?lock=102', stock: 150, sold: 892, rating: 4.6 },
      { cat: 'แฟชั่น', name: 'เสื้อยืดคอตตอน 100%', desc: 'ผ้านุ่ม ใส่สบาย ไม่ยืดย้วยหลังซัก มีให้เลือกหลายสี', price: 259, compare: 390, icon: '👕', image: 'https://loremflickr.com/600/600/tshirt,fashion?lock=103', stock: 80, sold: 445, rating: 4.7 },
      { cat: 'แฟชั่น', name: 'กระเป๋าสะพายผ้าแคนวาส', desc: 'ดีไซน์เรียบง่าย จุของได้เยอะ เหมาะกับการใช้งานประจำวัน', price: 450, compare: 650, icon: '👜', image: 'https://loremflickr.com/600/600/totebag?lock=104', stock: 35, sold: 156, rating: 4.9 },
      { cat: 'ของใช้ในบ้าน', name: 'แก้วเก็บความเย็น 500ml', desc: 'เก็บความเย็นได้นาน 12 ชม. ผนัง 2 ชั้น กันควบแน่น', price: 199, compare: 299, icon: '🥤', image: 'https://loremflickr.com/600/600/tumbler?lock=105', stock: 120, sold: 678, rating: 4.8 },
      { cat: 'ของใช้ในบ้าน', name: 'ผ้าปูที่นอนไมโครไฟเบอร์', desc: 'นุ่มลื่น ระบายอากาศดี ไม่ลอกลาย ซักเครื่องได้', price: 690, compare: 990, icon: '🛏️', image: 'https://loremflickr.com/600/600/bedsheet,bedroom?lock=106', stock: 25, sold: 89, rating: 4.7 },
      { cat: 'ความงาม', name: 'เซรั่มวิตามินซี 30ml', desc: 'ช่วยให้ผิวกระจ่างใส ลดเลือนจุดด่างดำ เนื้อบางเบาซึมไว', price: 390, compare: 590, icon: '🧴', image: 'https://loremflickr.com/600/600/skincare,serum?lock=107', stock: 60, sold: 512, rating: 4.6 },
      { cat: 'ความงาม', name: 'ลิปสติกแมทท์ติดทนนาน', desc: 'สีสวยคมชัด ติดทนตลอดวัน ไม่ทำให้ปากแห้ง', price: 259, compare: 350, icon: '💄', image: 'https://loremflickr.com/600/600/lipstick,cosmetics?lock=108', stock: 90, sold: 723, rating: 4.9 },
      { cat: 'อาหาร & เครื่องดื่ม', name: 'กาแฟคั่วบด 250g', desc: 'คั่วสดใหม่ทุกสัปดาห์ กลิ่นหอม รสชาติเข้มข้นกำลังดี', price: 189, compare: 259, icon: '☕', image: 'https://loremflickr.com/600/600/coffeebeans?lock=109', stock: 70, sold: 334, rating: 4.8 },
      { cat: 'อาหาร & เครื่องดื่ม', name: 'ขนมขบเคี้ยวสุขภาพรวม', desc: 'อบไม่ทอด แคลอรี่ต่ำ ทานเพลิน เหมาะเป็นของว่าง', price: 149, compare: null, icon: '🥨', image: 'https://loremflickr.com/600/600/healthysnacks?lock=110', stock: 100, sold: 201, rating: 4.5 },
    ];
    for (const p of demoProducts) {
      await db.run(`
        INSERT INTO products (category_id, name, description, price, compare_at_price, icon, image_url, stock, sold_count, rating)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `, [catId(p.cat), p.name, p.desc, p.price, p.compare, p.icon, p.image, p.stock, p.sold, p.rating]);
    }
  }

  // Give the demo customer a starting wallet balance + points so checkout is testable immediately.
  const demoCustomer = await db.get("SELECT id, wallet_balance FROM users WHERE username = 'customer'");
  if (demoCustomer && Number(demoCustomer.wallet_balance) === 0) {
    await db.run('UPDATE users SET wallet_balance = 5000, points_balance = 120 WHERE id = ?', [demoCustomer.id]);
    await db.run('INSERT INTO wallet_transactions (user_id, type, amount, description) VALUES (?,?,?,?)',
      [demoCustomer.id, 'topup', 5000, 'ยอดเงินเริ่มต้นสำหรับบัญชีทดสอบ']);
  }

  // Demo coupons
  const couponCount = Number((await db.get('SELECT COUNT(*) c FROM coupons')).c);
  if (couponCount === 0) {
    const in30days = new Date(Date.now() + 30 * 86400000).toISOString();
    await db.run(`INSERT INTO coupons (code, discount_type, discount_value, min_purchase, max_discount, usage_limit, expires_at, active) VALUES (?,?,?,?,?,?,?,1)`,
      ['JAIDEE50', 'fixed', 50, 300, null, 100, in30days]);
    await db.run(`INSERT INTO coupons (code, discount_type, discount_value, min_purchase, max_discount, usage_limit, expires_at, active) VALUES (?,?,?,?,?,?,?,1)`,
      ['SALE10', 'percent', 10, 200, 200, 200, in30days]);
    await db.run(`INSERT INTO coupons (code, discount_type, discount_value, min_purchase, max_discount, usage_limit, expires_at, active) VALUES (?,?,?,?,?,?,?,1)`,
      ['WELCOME20', 'percent', 20, 0, 100, 500, in30days]);
  }

  // Flash-sale a couple of demo products so the countdown UI has something to show
  const flashCount = Number((await db.get('SELECT COUNT(*) c FROM products WHERE flash_price IS NOT NULL')).c);
  if (flashCount === 0) {
    const flashEnd = new Date(Date.now() + 6 * 3600000).toISOString(); // 6 hours from now
    const flashTargets = await db.all('SELECT id, price FROM products ORDER BY id ASC LIMIT 3');
    for (const p of flashTargets) {
      await db.run('UPDATE products SET flash_price = ?, flash_ends_at = ? WHERE id = ?', [Math.round(p.price * 0.7), flashEnd, p.id]);
    }
  }

  // Store notifications (shop-specific feed, separate from support announcements)
  const storeNotifCount = Number((await db.get('SELECT COUNT(*) c FROM store_notifications')).c);
  if (storeNotifCount === 0) {
    await db.run('INSERT INTO store_notifications (title, body, icon) VALUES (?,?,?)',
      ['⚡ แฟลชเซลวันนี้', 'สินค้าคัดสรรลดสูงสุด 30% วันนี้เท่านั้น รีบเลย!', '⚡']);
    await db.run('INSERT INTO store_notifications (title, body, icon) VALUES (?,?,?)',
      ['🎉 ยินดีต้อนรับสู่ Lazmall', 'ใช้โค้ด WELCOME20 รับส่วนลด 20% สำหรับคำสั่งซื้อแรก', '🎁']);
  }

  console.log('Seed check complete (created demo data only if it was missing).');
  console.log('Admin login    → username: admin     password: admin1234');
  console.log('Customer login → username: customer  password: customer1234');

  // migrate() is idempotent and its referral-code backfill only fills in NULLs, so
  // calling it again here picks up any users just created above that don't have one yet.
  await migrate();
}

module.exports = seed;

// Allow running directly too: `node seed.js` / `npm run seed`
if (require.main === module) {
  seed().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
