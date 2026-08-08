// db.js — Postgres database layer (works with Neon serverless Postgres, or any
// standard Postgres server). Replaces the old better-sqlite3 file-based setup.
//
// Why this matters for deployment: platforms like Vercel/Render run your backend in
// ephemeral containers/functions with NO persistent local disk — every redeploy (or
// even every cold start on serverless) wiped the old SQLite file and any uploaded
// images, which is why the app "reset" and had to be reconfigured after each deploy.
// Neon is a real, always-on Postgres database reached over the network, so data
// (and, see routes/upload.js, uploaded images too) survive redeploys automatically.
//
// The rest of the app calls `db.get(sql, params)`, `db.all(sql, params)`, and
// `db.run(sql, params)` — same query text style as before (SQLite's `?` positional
// and `@name` named placeholders both still work; they're translated to Postgres's
// `$1, $2...` automatically below), but now they return Promises, so every call site
// uses `await`.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. This app now requires a Postgres connection string ' +
    '(a free Neon database works great — see backend/.env.example for setup steps).'
  );
}

// Neon (and most managed Postgres hosts) require TLS. Local/self-hosted Postgres
// (e.g. DATABASE_URL containing "localhost" or "127.0.0.1") usually does not have a
// TLS-enabled listener, so we only force `ssl` on for non-local hosts.
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 5),
});

pool.on('error', (err) => {
  // Idle client errors (e.g. Neon closing a connection after inactivity) must not
  // crash the whole process — the pool reconnects on the next query automatically.
  console.error('[db] idle client error', err.message);
});

// ---------- ? / @name  ->  $1, $2...  translation ----------
function compile(sql, params) {
  if (params === undefined || params === null) {
    return { text: sql, values: [] };
  }
  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    return { text, values: params };
  }
  // Named-parameter object, e.g. `@title` / `@id`.
  const values = [];
  const seen = {};
  const text = sql.replace(/@(\w+)/g, (m, name) => {
    if (!(name in seen)) {
      values.push(params[name]);
      seen[name] = values.length; // 1-based $n index
    }
    return `$${seen[name]}`;
  });
  return { text, values };
}

async function all(sql, params) {
  const { text, values } = compile(sql, params);
  const { rows } = await pool.query(text, values);
  return rows;
}

async function get(sql, params) {
  const rows = await all(sql, params);
  return rows[0];
}

// Emulates better-sqlite3's `.run()` return shape ({ lastInsertRowid, changes }) so
// existing call sites that only touched .run()'s return value need no changes beyond
// adding `await`. Every table in this app uses `id` as its primary key column name,
// so INSERTs automatically get `RETURNING id` appended (harmless no-op for statements
// that already specify one, e.g. text primary keys for tickets/orders).
async function run(sql, params) {
  const { text, values } = compile(sql, params);
  const isInsert = /^\s*insert/i.test(text);
  const hasReturning = /returning/i.test(text);
  let finalText = isInsert && !hasReturning ? `${text} RETURNING id` : text;
  let result;
  try {
    result = await pool.query(finalText, values);
  } catch (err) {
    // A handful of tables (e.g. "settings") use a non-"id" primary key, so the
    // auto-appended "RETURNING id" above fails for them — fall back to running the
    // original statement without it rather than making every call site special-case
    // its own table's primary key column name.
    if (isInsert && !hasReturning && /column "id" does not exist/i.test(err.message)) {
      result = await pool.query(text, values);
    } else {
      throw err;
    }
  }
  return {
    lastInsertRowid: result.rows[0]?.id,
    changes: result.rowCount,
    rows: result.rows,
  };
}

// Runs several statements as one transaction. Callback receives a `txDb` with the
// same get/all/run shape, all bound to the same client connection.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txDb = {
      get: async (sql, params) => { const { text, values } = compile(sql, params); const r = await client.query(text, values); return r.rows[0]; },
      all: async (sql, params) => { const { text, values } = compile(sql, params); const r = await client.query(text, values); return r.rows; },
      run: async (sql, params) => {
        const { text, values } = compile(sql, params);
        const isInsert = /^\s*insert/i.test(text);
        const hasReturning = /returning/i.test(text);
        const finalText = isInsert && !hasReturning ? `${text} RETURNING id` : text;
        let r;
        if (isInsert && !hasReturning) {
          // Use a SAVEPOINT so a failed "RETURNING id" guess (tables whose primary
          // key isn't named "id", e.g. settings) can be retried without poisoning
          // the rest of the transaction.
          await client.query('SAVEPOINT db_run_sp');
          try {
            r = await client.query(finalText, values);
            await client.query('RELEASE SAVEPOINT db_run_sp');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT db_run_sp');
            if (/column "id" does not exist/i.test(err.message)) {
              r = await client.query(text, values);
            } else {
              throw err;
            }
          }
        } else {
          r = await client.query(finalText, values);
        }
        return { lastInsertRowid: r.rows[0]?.id, changes: r.rowCount, rows: r.rows };
      },
    };
    const result = await fn(txDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const NOW_EXPR = `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('customer','admin')),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      position TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT,
      channel TEXT DEFAULT 'เว็บไซต์',
      priority TEXT DEFAULT 'ปานกลาง',
      status TEXT DEFAULT 'รอดำเนินการ',
      assigned_admin_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT ${NOW_EXPR},
      updated_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      sender_role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER UNIQUE NOT NULL REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS kb_articles (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tag TEXT DEFAULT 'ทั่วไป',
      views INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      icon TEXT DEFAULT '📢',
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    -- ---------- Lazmall storefront ----------
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      parent_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL,
      icon TEXT DEFAULT '🛍️',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES categories(id),
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      compare_at_price REAL,
      icon TEXT DEFAULT '📦',
      image_url TEXT,
      stock INTEGER DEFAULT 0,
      sold_count INTEGER DEFAULT 0,
      rating REAL DEFAULT 4.8,
      review_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','hidden')),
      flash_price REAL,
      flash_ends_at TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR},
      updated_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT ${NOW_EXPR},
      UNIQUE(customer_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES users(id),
      subtotal REAL,
      discount_amount REAL DEFAULT 0,
      coupon_code TEXT,
      total REAL NOT NULL,
      points_earned INTEGER DEFAULT 0,
      status TEXT DEFAULT 'สั่งซื้อสำเร็จ',
      payment_method TEXT DEFAULT 'กระเป๋าเงิน',
      payment_status TEXT DEFAULT 'ชำระเงินแล้ว' CHECK(payment_status IN ('ชำระเงินแล้ว','รอตรวจสอบการชำระเงิน')),
      shipping_method TEXT DEFAULT 'ส่งด่วน',
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id INTEGER,
      product_name TEXT NOT NULL,
      product_icon TEXT,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('topup','purchase','refund','points_earned','referral_bonus')),
      amount REAL DEFAULT 0,
      points INTEGER DEFAULT 0,
      description TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
      discount_value REAL NOT NULL,
      min_purchase REAL DEFAULT 0,
      max_discount REAL,
      usage_limit INTEGER,
      used_count INTEGER DEFAULT 0,
      expires_at TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      customer_id INTEGER NOT NULL REFERENCES users(id),
      order_id TEXT NOT NULL REFERENCES orders(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR},
      UNIQUE(product_id, order_id)
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL REFERENCES users(id),
      referred_user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
      reward_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'สมัครสำเร็จ' CHECK(status IN ('สมัครสำเร็จ','ได้รับรางวัลแล้ว')),
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS store_notifications (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      icon TEXT DEFAULT '🛍️',
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
      bank_name TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_number TEXT NOT NULL,
      verified INTEGER DEFAULT 1,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      status TEXT DEFAULT 'รอดำเนินการ' CHECK(status IN ('รอดำเนินการ','โอนเงินแล้ว','ปฏิเสธ')),
      bank_name TEXT,
      account_number TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR},
      processed_at TEXT
    );

    -- ---------- Uploaded files (product images, branding, payment slips) ----------
    -- Stored as real rows in Postgres/Neon (not local disk) so they survive redeploys
    -- and work the same whether the backend runs on one server or many (serverless).
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      data BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );

    -- ---------- Personal / transactional notification center ----------
    -- Distinct from store_notifications (admin-authored marketing broadcasts):
    -- these are system-generated alerts about something that happened to a
    -- specific person's own stuff (their order, their wallet, their account,
    -- their ticket) — or, for admin, a log of activity across the store.
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id), -- NULL = broadcast to every admin
      audience TEXT NOT NULL CHECK(audience IN ('customer','admin')),
      category TEXT NOT NULL, -- 'order','payment','wallet','shipping','account_status','ticket','coupon'
      title TEXT NOT NULL,
      body TEXT,
      icon TEXT DEFAULT '🔔',
      link TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT ${NOW_EXPR}
    );
  `);

  // Postgres supports "ADD COLUMN IF NOT EXISTS" directly, so upgrading an existing
  // database (adding a column introduced by a later version of this app) is a single
  // statement per column instead of the manual guard-checks SQLite needed.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance REAL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS points_balance INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_id TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS flash_price REAL;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS flash_ends_at TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal REAL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount REAL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'ชำระเงินแล้ว';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method TEXT DEFAULT 'ส่งด่วน';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_slip_url TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_by_admin BOOLEAN DEFAULT FALSE;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS seen_by_admin BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'ปกติ';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS store_notif_seen_at TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_seen_at TEXT;
  `);

  // One row per (provider, provider-user-id) — prevents two local accounts from ever
  // being created for the same Google/Facebook/LINE identity.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id) WHERE oauth_provider IS NOT NULL`
  );

  // Backfill store_notif_seen_at to "now" for any user who doesn't have it yet
  // (i.e. everyone, right after the column above is first added) — otherwise every
  // existing store announcement would suddenly count as "unread" for every customer
  // the moment this feature ships. Only announcements posted *after* this point in
  // time will show up as unread until each customer opens the notifications page.
  await run(`UPDATE users SET store_notif_seen_at = ${NOW_EXPR} WHERE store_notif_seen_at IS NULL`);
  // Same treatment for the new personal/transactional notification center.
  await run(`UPDATE users SET notif_seen_at = ${NOW_EXPR} WHERE notif_seen_at IS NULL`);

  // Every admin needs SOME permissions to see anything once the team/permissions
  // system ships — grant full access to admins that don't have any set yet, so an
  // existing deployment's admin accounts aren't suddenly locked out of their own
  // back office. New admins created after this point start with whatever the
  // owner explicitly assigns them instead (see routes/team.js).
  const ALL_PERMISSIONS = ['dashboard','inbox','products','categories','storeOrders','reviews','marketing','tickets','tasks','customers','finance','channels','kb','reports','settings'];
  await run(
    `UPDATE users SET permissions = ? WHERE role = 'admin' AND (permissions IS NULL OR permissions = '[]')`,
    [JSON.stringify(ALL_PERMISSIONS)]
  );
  // Exactly one "owner" account is required to manage the team/permissions screen
  // itself (see routes/team.js) — if no admin is marked as owner yet, promote the
  // earliest-created admin automatically rather than leaving nobody able to grant
  // permissions to anyone else.
  const hasOwner = await get(`SELECT id FROM users WHERE role = 'admin' AND is_owner = TRUE LIMIT 1`);
  if (!hasOwner) {
    const earliestAdmin = await get(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1`);
    if (earliestAdmin) await run(`UPDATE users SET is_owner = TRUE WHERE id = ?`, [earliestAdmin.id]);
  }

  // Widen wallet_transactions.type to also allow admin-initiated wallet adjustments
  // (top-ups, commission, bonus, deductions the admin applies from the back office —
  // see routes/customers.js "wallet" endpoint). Postgres has no "ADD CONSTRAINT IF NOT
  // EXISTS", so this drops the old CHECK (if present) and re-adds the widened one —
  // safe to run on every boot, including a brand-new database.
  await pool.query(`ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check`);
  await pool.query(`
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
    CHECK (type IN ('topup','purchase','refund','points_earned','referral_bonus','admin_credit','admin_debit'))
  `);

  // Same treatment for users.account_status — keeps it to the two values the admin
  // UI understands ('ปกติ' = normal, 'แช่แข็ง' = frozen).
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check`);
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_account_status_check
    CHECK (account_status IN ('ปกติ','แช่แข็ง'))
  `);

  // Backfill a unique 5-digit numeric referral code for any user that doesn't have
  // one yet, OR still has one in the old 8-character format (e.g. "JD2U611S" from
  // before referral codes were switched to 5 digits) — this runs once per account
  // and then leaves it alone, so it's safe to run on every boot.
  const usersWithOldCode = await all(`SELECT id FROM users WHERE referral_code IS NULL OR referral_code !~ '^[0-9]{5}$'`);
  for (const u of usersWithOldCode) {
    let code;
    let clash;
    do {
      code = String(Math.floor(10000 + Math.random() * 90000));
      clash = await get('SELECT id FROM users WHERE referral_code = ?', [code]);
    } while (clash);
    await run('UPDATE users SET referral_code = ? WHERE id = ?', [code, u.id]);
  }

  // Backfill "รหัสผู้แนะนำ" (referred_by_user_id) for any customer that doesn't
  // have one — e.g. the seeded demo account, or any account created before this
  // relationship was required. Same random-assignment approach as new admin-
  // created accounts (routes/customers.js POST /) — no reward is paid out, this
  // is just backfilling the relationship so the field shows a real code instead
  // of "ไม่มี".
  const customersMissingReferrer = await all(
    `SELECT id FROM users WHERE role = 'customer' AND referred_by_user_id IS NULL`
  );
  for (const u of customersMissingReferrer) {
    const candidate = await get(
      `SELECT id FROM users WHERE role = 'customer' AND id != ? ORDER BY RANDOM() LIMIT 1`,
      [u.id]
    );
    if (candidate) await run('UPDATE users SET referred_by_user_id = ? WHERE id = ?', [candidate.id, u.id]);
  }

  const settingDefaults = {
    call_mode: 'ai',
    agent_name: 'ธนกร วงศ์ดี',
    auto_switch: 'on',
    avatar_skin_tone: '#F0C8A0',
    avatar_hair_color: '#3A2A20',
    avatar_uniform_color: '#6C3CE9',
    store_name: 'Lazmall',
    app_logo_url: '',
    home_logo_url: '',
    theme_primary_color: '#4F46E5',
    theme_secondary_color: '#7C3AED',
    theme_font: 'Noto Sans Thai',
    payment_logos: '[]',
    promptpay_id: '',
    promptpay_name: '',
    oauth_google_client_id: '',
    oauth_google_client_secret: '',
    oauth_facebook_client_id: '',
    oauth_facebook_client_secret: '',
    oauth_line_client_id: '',
    oauth_line_client_secret: '',
    oauth_frontend_url: '',
    home_banners: JSON.stringify([
      { imageUrl: '', linkUrl: '' },
    ]),
    agent_title: 'เจ้าหน้าที่ฝ่ายบริการลูกค้า',
    agent_greeting: 'ยินดีให้บริการค่ะ มีอะไรให้ช่วยเหลือสอบถามได้เลยนะคะ',
    agent_avatar_url: '',
    chat_header_stats: JSON.stringify([
      { icon: '📋', label: 'งานที่ทำสำเร็จ', value: '4,871', sub: 'งาน', color: '#3B82F6' },
      { icon: '💰', label: 'รอถอนเงิน', value: '1,148', sub: 'รายการ', color: '#F59E0B' },
      { icon: '🏦', label: 'ถอนสำเร็จแล้ว', value: '5,734', sub: 'รายการ', color: '#16A34A' },
    ]),
    chat_welcome_messages: JSON.stringify([
      { text: 'สวัสดีค่ะ ยินดีต้อนรับสู่ร้านค้าของเรา 🙏 มีอะไรให้ช่วยสอบถามได้เลยนะคะ', imageUrl: '' },
    ]),
    promo_image_cards: JSON.stringify([
      { imageUrl: '', linkUrl: '', title: 'สินค้าแนะนำ' },
      { imageUrl: '', linkUrl: '', title: 'ของแต่งบ้าน' },
    ]),
    home_stats: JSON.stringify([
      { icon: 'store', value: '5,000+', label: 'ร้านค้าทางการ' },
      { icon: 'tag', value: '1M+', label: 'สินค้าลดราคา' },
      { icon: 'star', value: '50K+', label: 'รีวิวจริง' },
      { icon: 'users', value: '98%', label: 'ลูกค้าพึงพอใจ' },
    ]),
    home_category_tabs: JSON.stringify([
      { iconUrl: '', emoji: '🚚', label: 'ส่งฟรี' },
      { iconUrl: '', emoji: '🔥', label: 'เทรนด์ดี' },
      { iconUrl: '', emoji: '🏬', label: 'มอลล์' },
      { iconUrl: '', emoji: '✅', label: 'ถูกชัวร์' },
      { iconUrl: '', emoji: '🏠', label: 'โฮม' },
    ]),
    home_cta_title: 'เปิดประสบการณ์ช้อปปิ้งออนไลน์',
    home_cta_subtitle: 'ช้อปง่าย สะดวก รวดเร็ว และปลอดภัย พร้อมโปรโมชั่น โค้ดส่วนลด และส่งฟรีสุดปังทุกวัน',
    home_seo_html: '',
    shipping_logos: '[]',
    footer_about_title: 'เปิดประสบการณ์ช้อปปิ้งออนไลน์ แค่สั่งซื้อออนไลน์กับเรา',
    footer_about_sections: JSON.stringify([
      { heading: 'ช้อปสินค้าออนไลน์ได้ง่ายกว่าที่เคย', body: 'เลือกชมสินค้าได้ทุกหมวดหมู่ พร้อมโปรโมชั่นและส่วนลดที่คัดสรรมาเพื่อคุณโดยเฉพาะ ชำระเงินได้หลายช่องทาง ปลอดภัย และตรวจสอบสถานะคำสั่งซื้อได้ตลอดเวลา' },
      { heading: 'คัดสรรสินค้าคุณภาพทุกหมวดหมู่', body: 'ตั้งแต่แฟชั่น ความงาม ของใช้ในบ้าน ไปจนถึงอิเล็กทรอนิกส์ ทุกสินค้าผ่านการคัดเลือกจากร้านค้าที่เชื่อถือได้ พร้อมรีวิวจริงจากลูกค้าที่เคยสั่งซื้อ' },
      { heading: 'ช้อปง่าย จ่ายสะดวก ส่งเร็วทันใจ', body: 'รองรับการชำระเงินหลายรูปแบบ ทั้งกระเป๋าเงินในแอป บัตรเครดิต และโอนผ่านธนาคาร พร้อมบริการจัดส่งจากพันธมิตรขนส่งชั้นนำให้เลือกตามความสะดวก' },
      { heading: 'โปรโมชั่นพิเศษทุกเดือน', body: 'พบกับแคมเปญลดราคาประจำเดือนและแฟลชเซลสุดคุ้ม อัปเดตใหม่อย่างต่อเนื่อง ติดตามเพื่อไม่พลาดดีลเด็ด' },
    ]),
    footer_campaign_dates: JSON.stringify([
      { label: '2.2' }, { label: '3.3' }, { label: '4.4' }, { label: '5.5' },
      { label: '6.6' }, { label: '7.7' }, { label: '8.8' }, { label: '9.9' },
      { label: '10.10', highlight: true }, { label: '11.11', highlight: true }, { label: '12.12', highlight: true },
    ]),
    footer_nav_columns: JSON.stringify([
      { title: 'ศูนย์ช่วยเหลือ', links: [
        { label: 'Help Centre', url: '' },
        { label: 'วิธีการสั่งซื้อสินค้า', url: '' },
        { label: 'วิธีการเปลี่ยน/คืนสินค้า', url: '' },
        { label: 'ติดต่อเรา', url: '' },
      ] },
      { title: 'เกี่ยวกับเรา', links: [
        { label: 'เกี่ยวกับร้านค้า', url: '' },
        { label: 'ร่วมเป็นพาร์ทเนอร์', url: '' },
        { label: 'ชวนเพื่อน รับรางวัล', url: '' },
      ] },
      { title: 'นโยบาย', links: [
        { label: 'นโยบายความเป็นส่วนตัว', url: '' },
        { label: 'ข้อกำหนดการใช้งาน', url: '' },
      ] },
    ]),
    // Every category on by default — the admin turns specific ones off from
    // Settings > การแจ้งเตือน rather than opting in from a blank slate.
    notif_categories_enabled: JSON.stringify({
      order: true, payment: true, wallet: true, shipping: true, account_status: true, ticket: true, coupon: true,
    }),
  };
  for (const [k, v] of Object.entries(settingDefaults)) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}

// Exported as `db` (not individual functions) so existing `const { db } = require('../db')`
// imports across the app keep working — only the call sites (`db.prepare(sql).get(x)` ->
// `await db.get(sql, [x])`) needed to change, not every import statement.
const db = { get, all, run, transaction, pool };

module.exports = { db, migrate, pool };
