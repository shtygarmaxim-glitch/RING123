const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const { beginCell } = require("@ton/core");
const { createCompressedStatic } = require("./static-cache");

const PORT = Number(process.env.PORT || 10000);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const staticCache = createCompressedStatic(path.join(__dirname, "public"));
app.disable("x-powered-by");

app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false }));

// Runtime maintenance lock: administrators can still use the app/admin API,
// while normal users receive a clean 503 with a maintenance flag.
app.use('/api', async (req, res, next) => {
  if (!maintenanceMode || req.method === 'OPTIONS' || isPublicMaintenanceBypass(req.path)) return next();
  try {
    const checked = validateTelegramInitData(req.headers['x-telegram-init-data']);
    if (checked.ok && isAdmin(checked.user.id)) return next();
  } catch {}
  return res.status(503).json({ error: maintenanceMessage(), maintenance: true });
});

app.get("/tonconnect-manifest.json", (req, res) => {
  const base = String(process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.json({
    url: base,
    name: "RING",
    iconUrl: `${base}/assets/group-6-nav.svg`
  });
});

// html/js/css/json/svg — со сжатием и ETag (static-cache.js); остальное (картинки, mp3) — с кэшем браузера на сутки.
app.use(staticCache.middleware);
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

app.get("/api/tonconnect/config", async (req, res) => {
  try {
    await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const rawTonConnect = String(process.env.TON_CONNECT || "").trim();
    const manifestUrl = String(
      process.env.TON_CONNECT_MANIFEST_URL ||
      process.env.TON_CONNECT_MANIFEST ||
      process.env.TON_CONNECT_URL ||
      (rawTonConnect.startsWith("http://") || rawTonConnect.startsWith("https://") ? rawTonConnect : "") ||
      `${base}/tonconnect-manifest.json`
    ).trim();
    if (!manifestUrl) return res.status(503).json({ error: "Укажите TON_CONNECT_MANIFEST_URL на Render." });
    res.json({ manifestUrl });
  } catch (e) {
    res.status(401).json({ error: e.message || "Авторизация не выполнена." });
  }
});


const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 15,
      min: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    })
  : null;

// Short-lived caches remove duplicate PostgreSQL round trips when the Mini App opens.
const USER_CACHE_TTL = 15000;
const userCache = new Map();
const adminAuthCache = new Map();

function getCachedUser(userId) {
  const key = String(userId);
  const hit = userCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > USER_CACHE_TTL) {
    userCache.delete(key);
    return null;
  }
  return hit.user;
}

function cacheUser(user) {
  if (user?.telegram_id) userCache.set(String(user.telegram_id), { user, at: Date.now() });
  return user;
}

function invalidateUserCache(userId) {
  userCache.delete(String(userId));
}

const COLORS = [
  "#19e58f", "#ff19b9", "#ffd11a", "#32a8ff", "#a95cff",
  "#ff7a18", "#00d9ff", "#ff4d6d", "#8dff3f", "#b7a2ff",
  "#ff5ce1", "#35e0d0", "#ffb347", "#5b7cfa", "#e6ff4f",
  "#7dffce", "#f15cff", "#ffde59", "#6ca7ff", "#ff8d6b"
];

let maintenanceMode = false;

const state = {
  roomId: crypto.randomUUID(),
  status: "WAITING",
  countdownEndsAt: null,
  players: new Map(),
  winnerId: null,
  commission: 0,
  payout: 0,
  spinTargetAngle: 0
};

let timerHandle = null;

function safeName(name) {
  const s = String(name || "").trim();
  return s ? s.slice(0, 32) : "Игрок";
}

function getAdminIds() {
  return String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(/[\s,;]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return getAdminIds().includes(String(userId));
}

function requireDatabase() {
  if (!pool) throw new Error("DATABASE_URL не настроен на Render.");
}

function availableColor() {
  const used = new Set([...state.players.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || null;
}

function totalBank() {
  return Number([...state.players.values()]
    .reduce((sum, p) => sum + Number(p.bet || 0), 0)
    .toFixed(2));
}

function publicState() {
  const bank = totalBank();
  const rawPlayers = [...state.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    bet: p.bet,
    percentage: bank ? Number(((p.bet / bank) * 100).toFixed(4)) : 0,
    status: p.status || "active"
  }));

  const revealWinner = state.status === "RESULT";
  const players = revealWinner
    ? rawPlayers
    : rawPlayers.map(p => ({ ...p, status: "active" }));

  const winnerPlayer = revealWinner && state.winnerId
    ? state.players.get(state.winnerId)
    : null;

  const winner = winnerPlayer ? {
    id: winnerPlayer.id,
    name: winnerPlayer.name,
    avatar: winnerPlayer.avatar,
    color: winnerPlayer.color,
    bet: Number(winnerPlayer.bet || 0),
    percentage: bank ? Number(((winnerPlayer.bet / bank) * 100).toFixed(4)) : 0,
    payout: Number(state.payout || 0)
  } : null;

  return {
    roomId: state.roomId,
    status: state.status,
    countdownEndsAt: state.countdownEndsAt,
    bank,
    players,
    // Winner is not exposed until the pointer has stopped and RESULT is active.
    winnerId: revealWinner ? state.winnerId : null,
    winner,
    // Only the pointer's target angle is sent during SPINNING.
    spinTargetAngle: state.status === "SPINNING" ? Number(state.spinTargetAngle || 0) : null,
    commission: revealWinner ? state.commission : 0,
    payout: revealWinner ? state.payout : 0
  };
}
function broadcast() {
  io.emit("room_state", publicState());
}

// Turns a server seed (+ a purpose "salt") into a deterministic float in
// [0,1). Reusing the same seed with different salts for the winner pick and
// the spin angle keeps both derived from one committed value, so the whole
// round can be re-derived and checked later from the seed alone.
function seededFloat(seed, salt) {
  const h = crypto.createHash("sha256").update(`${seed}:${salt}`).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

function weightedWinner(players, target) {
  const funded = players.filter(p => Number(p.bet) > 0);
  const bank = funded.reduce((sum, p) => sum + Number(p.bet), 0);
  if (!bank) return null;

  let cumulative = 0;
  for (const p of funded) {
    cumulative += Number(p.bet) / bank;
    if (target < cumulative) return p;
  }
  return funded[funded.length - 1];
}

function validateTelegramInitData(initData) {
  if (!initData) return { ok: false, reason: "missing" };
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: "bot_token_missing" };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, reason: "hash_missing" };

    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key !== "hash") pairs.push([key, value]);
    }
    pairs.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const a = Buffer.from(calculated, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "hash_invalid" };
    }

    const authDate = Number(params.get("auth_date") || 0);
    const maxAge = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE || 86400);
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAge) {
      return { ok: false, reason: "expired" };
    }

    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id) return { ok: false, reason: "user_missing" };

    return {
      ok: true,
      user: {
        id: String(user.id),
        first_name: safeName(user.first_name || "Игрок"),
        last_name: safeName(user.last_name || ""),
        username: String(user.username || ""),
        photo_url: String(user.photo_url || "")
      }
    };
  } catch (e) {
    return { ok: false, reason: "parse_error" };
  }
}

function telegramUserFromRequest(req) {
  const raw = req.headers["x-telegram-init-data"];
  return validateTelegramInitData(raw);
}

async function initDb() {
  requireDatabase();

  // Each statement runs as its own query instead of one giant batch, so a
  // failure partway through (e.g. an index that can't be created) can't
  // silently roll back migrations that already succeeded, such as the
  // ALTER TABLE ... ADD COLUMN statements further down.
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT 'Игрок',
      avatar_url TEXT NOT NULL DEFAULT '',
      balance NUMERIC(20,2) NOT NULL DEFAULT 0,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      referred_by TEXT,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      total_wagered NUMERIC(20,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id UUID PRIMARY KEY,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      closed_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets(telegram_user_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS account_security_signals (
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      fingerprint_hash TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      user_agent_hash TEXT NOT NULL DEFAULT '',
      telegram_platform TEXT NOT NULL DEFAULT '',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hits INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (telegram_user_id, fingerprint_hash, ip_hash)
    )`,
    `CREATE INDEX IF NOT EXISTS account_security_fingerprint_idx ON account_security_signals(fingerprint_hash, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS account_security_ip_idx ON account_security_signals(ip_hash, last_seen_at DESC)`,
    `CREATE INDEX IF NOT EXISTS account_security_user_idx ON account_security_signals(telegram_user_id, last_seen_at DESC)`,
    `CREATE TABLE IF NOT EXISTS account_security_flags (
      telegram_user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      risk_score INTEGER NOT NULL DEFAULT 0,
      linked_accounts INTEGER NOT NULL DEFAULT 0,
      exact_device_matches INTEGER NOT NULL DEFAULT 0,
      shared_ip_matches INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      telegram_payment_charge_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL,
      payload TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS balance_transactions (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL,
      balance_after NUMERIC(20,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      admin_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pvp_rounds (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bank NUMERIC(20,2) NOT NULL,
      winner_id TEXT,
      winner_bet NUMERIC(20,2),
      payout NUMERIC(20,2),
      commission NUMERIC(20,2),
      players JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ice_rounds (
      id BIGINT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pool NUMERIC(20,2) NOT NULL,
      winner_id TEXT,
      seed TEXT NOT NULL,
      seed_hash TEXT NOT NULL,
      anomaly TEXT,
      players JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS referral_earnings (
      id BIGSERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL,
      telegram_payment_charge_id TEXT UNIQUE NOT NULL,
      deposit_amount NUMERIC(20,2) NOT NULL,
      reward_amount NUMERIC(20,2) NOT NULL,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS promo_codes (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      bonus NUMERIC(20,2) NOT NULL CHECK (bonus > 0),
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
      uses_count INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS promo_redemptions (
      promo_code_id BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      bonus NUMERIC(20,2) NOT NULL,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (promo_code_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS freebets (
      id UUID PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      bonus NUMERIC(20,2) NOT NULL CHECK (bonus > 0),
      max_uses INTEGER NOT NULL CHECK (max_uses > 0),
      uses_count INTEGER NOT NULL DEFAULT 0,
      wager NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (wager >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS freebet_claims (
      freebet_id UUID NOT NULL REFERENCES freebets(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      bonus NUMERIC(20,2) NOT NULL,
      wager NUMERIC(10,2) NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (freebet_id, telegram_user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS freebets_active_idx ON freebets(active, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS freebet_claims_user_idx ON freebet_claims(telegram_user_id, claimed_at DESC)`,
    `CREATE TABLE IF NOT EXISTS raffles (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      raffle_type TEXT NOT NULL CHECK (raffle_type IN ('free','paid')),
      ticket_price NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (ticket_price >= 0),
      prize_pool NUMERIC(20,2) NOT NULL CHECK (prize_pool > 0),
      prize_title TEXT NOT NULL DEFAULT 'Stars',
      winners_count INTEGER NOT NULL CHECK (winners_count > 0),
      ends_at TIMESTAMPTZ NOT NULL,
      channel_id TEXT NOT NULL,
      channel_username TEXT NOT NULL,
      channel_title TEXT NOT NULL DEFAULT '',
      post_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','settling','finished','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_entries (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      tickets INTEGER NOT NULL DEFAULT 0 CHECK (tickets >= 0),
      paid_amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_referrals (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      referrer_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      referred_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, referred_user_id),
      UNIQUE (raffle_id, referrer_id, referred_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_boost_claims (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      boost_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, telegram_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS raffle_winners (
      raffle_id TEXT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      place INTEGER NOT NULL,
      payout NUMERIC(20,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (raffle_id, place),
      UNIQUE (raffle_id, telegram_user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS raffles_active_idx ON raffles(status, ends_at)`,
    `CREATE INDEX IF NOT EXISTS raffle_entries_user_idx ON raffle_entries(telegram_user_id, joined_at DESC)`,
    `CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      currency TEXT NOT NULL CHECK (currency IN ('STAR','GRAM','TON')),
      amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
      wallet_address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS ton_topup_intents (
      id UUID PRIMARY KEY,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      expected_nano_ton NUMERIC(30,0) NOT NULL,
      stars INTEGER NOT NULL CHECK (stars > 0),
      comment TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      transaction_hash TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      credited_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      task_type TEXT NOT NULL CHECK (task_type IN ('channel_subscription','bot_start')),
      target_username TEXT NOT NULL,
      target_chat_id TEXT NOT NULL DEFAULT '',
      reward NUMERIC(20,2) NOT NULL CHECK (reward > 0),
      max_activations INTEGER NOT NULL CHECK (max_activations > 0),
      completions INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(20,2) NOT NULL CHECK (price >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS task_completions (
      task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, telegram_user_id)
    )`,

    // Migrate an already-existing database without wiping users.
    `ALTER TABLE ice_rounds ADD COLUMN IF NOT EXISTS payout NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE ice_rounds ADD COLUMN IF NOT EXISTS commission NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS games_won INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_wagered NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS wager_remaining NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS required_deposit NUMERIC(20,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS wager NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS wallet_address TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS decline_reason TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS round_number SERIAL`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS server_seed TEXT`,
    `ALTER TABLE pvp_rounds ADD COLUMN IF NOT EXISTS server_seed_hash TEXT`,
    `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_price_check`,
    `ALTER TABLE tasks ADD CONSTRAINT tasks_price_check CHECK (price >= 0)`,
    `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check`,
    `ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('pending','active','finished','cancelled'))`,

    `CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes(active, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON promo_redemptions(telegram_user_id, redeemed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS users_username_idx ON users(username)`,
    `CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users(referred_by)`,
    `CREATE INDEX IF NOT EXISTS tx_user_idx ON balance_transactions(telegram_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS referral_referrer_idx ON referral_earnings(referrer_id, claimed, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawal_requests_user_idx ON withdrawal_requests(telegram_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx ON withdrawal_requests(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ton_topup_intents_pending_idx ON ton_topup_intents(status, created_at)`,
    `CREATE INDEX IF NOT EXISTS tasks_active_idx ON tasks(status, created_at DESC)`,
    `DO $$ BEGIN
       ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_currency_check;
       ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_currency_check CHECK (currency IN ('STAR','GRAM','TON'));
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.error("DB migration statement failed:", e.message, "\nSQL:", sql.split("\n")[0].trim());
    }
  }
  try {
    await pool.query(`
      UPDATE users u
      SET total_deposited = COALESCE((
        SELECT SUM(bt.amount)
        FROM balance_transactions bt
        WHERE bt.telegram_user_id=u.telegram_id
          AND bt.type IN ('stars_topup','ton_topup')
          AND bt.amount > 0
      ), 0)
      WHERE COALESCE(u.total_deposited, 0) = 0
    `);
  } catch (e) {
    console.error("Deposit total backfill failed:", e.message);
  }
}

async function loadMaintenanceMode() {
  if (!pool) return;
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key='maintenance_mode'`);
    maintenanceMode = String(r.rows[0]?.value || '').toLowerCase() === 'true';
  } catch (e) {
    console.error("Maintenance state load failed:", e.message);
    maintenanceMode = false;
  }
}

async function setMaintenanceMode(enabled, adminId) {
  requireDatabase();
  const value = enabled ? 'true' : 'false';
  await pool.query(
    `INSERT INTO app_settings(key,value,updated_at) VALUES ('maintenance_mode',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [value]
  );
  maintenanceMode = !!enabled;
  io.emit('maintenance_changed', { enabled: maintenanceMode });
  return { enabled: maintenanceMode, changedBy: String(adminId || '') };
}

async function maintenanceStatusForRequest(req) {
  let admin = false;
  const raw = req.headers['x-telegram-init-data'] || '';
  if (raw) {
    const checked = validateTelegramInitData(raw);
    admin = !!(checked.ok && isAdmin(checked.user.id));
  }
  return { enabled: maintenanceMode, isAdmin: admin };
}

function isPublicMaintenanceBypass(pathname) {
  return [
    '/system/status',
    '/support/webhook',
    '/support/config',
    '/telegram/webhook',
    '/telegram/status',
    '/telegram/webhook-status'
  ].includes(pathname) || pathname.startsWith('/admin/');
}

function maintenanceMessage() {
  return 'Приложение временно закрыто на технические работы. Попробуйте зайти позже.';
}

function hashSecurityValue(value) {
  const salt = String(process.env.SECURITY_FINGERPRINT_SALT || process.env.TELEGRAM_BOT_TOKEN || 'ring-security').trim();
  return crypto.createHmac('sha256', salt).update(String(value || '')).digest('hex');
}

function getRequestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req?.ip || req?.socket?.remoteAddress || '');
}

async function recordSecuritySignal(userId, { fingerprint = '', ip = '', userAgent = '', platform = '' } = {}) {
  if (!pool) return { riskScore: 0, linkedAccounts: 0, exactDeviceMatches: 0, sharedIpMatches: 0 };
  const uid = String(userId);
  const fp = String(fingerprint || '').trim().slice(0, 512);
  const ua = String(userAgent || '').trim().slice(0, 1024);
  const ipRaw = String(ip || '').trim().slice(0, 128);
  const fingerprintHash = fp ? hashSecurityValue(`fp:${fp}`) : '';
  const ipHash = ipRaw ? hashSecurityValue(`ip:${ipRaw}`) : '';
  const uaHash = ua ? hashSecurityValue(`ua:${ua}`) : '';

  // Never store raw fingerprint/IP/UA. Only keyed hashes are persisted.
  await pool.query(
    `INSERT INTO account_security_signals
       (telegram_user_id, fingerprint_hash, ip_hash, user_agent_hash, telegram_platform, hits, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,1,NOW())
     ON CONFLICT (telegram_user_id, fingerprint_hash, ip_hash) DO UPDATE SET
       user_agent_hash=EXCLUDED.user_agent_hash,
       telegram_platform=EXCLUDED.telegram_platform,
       hits=account_security_signals.hits+1,
       last_seen_at=NOW()`,
    [uid, fingerprintHash, ipHash, uaHash, String(platform || '').slice(0, 64)]
  );

  const byFingerprint = fingerprintHash ? await pool.query(
    `SELECT COUNT(DISTINCT telegram_user_id)::int AS count
     FROM account_security_signals
     WHERE fingerprint_hash=$1 AND telegram_user_id<>$2`,
    [fingerprintHash, uid]
  ) : { rows: [{ count: 0 }] };
  const byIp = ipHash ? await pool.query(
    `SELECT COUNT(DISTINCT telegram_user_id)::int AS count
     FROM account_security_signals
     WHERE ip_hash=$1 AND telegram_user_id<>$2`,
    [ipHash, uid]
  ) : { rows: [{ count: 0 }] };

  const exactDeviceMatches = Number(byFingerprint.rows[0]?.count || 0);
  const sharedIpMatches = Number(byIp.rows[0]?.count || 0);
  // Heuristic only: exact client fingerprint is a much stronger signal than
  // shared IP (families, schools, offices and VPNs can legitimately share IPs).
  const riskScore = Math.min(100,
    (exactDeviceMatches > 0 ? 70 : 0) +
    Math.min(20, sharedIpMatches * 10) +
    (exactDeviceMatches > 1 ? 10 : 0)
  );
  const linkedAccounts = Math.max(exactDeviceMatches, sharedIpMatches);

  await pool.query(
    `INSERT INTO account_security_flags
       (telegram_user_id, risk_score, linked_accounts, exact_device_matches, shared_ip_matches, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       risk_score=EXCLUDED.risk_score,
       linked_accounts=EXCLUDED.linked_accounts,
       exact_device_matches=EXCLUDED.exact_device_matches,
       shared_ip_matches=EXCLUDED.shared_ip_matches,
       updated_at=NOW()`,
    [uid, riskScore, linkedAccounts, exactDeviceMatches, sharedIpMatches]
  );

  return { riskScore, linkedAccounts, exactDeviceMatches, sharedIpMatches };
}

async function getSecuritySignalForUser(userId) {
  if (!pool) return { riskScore: 0, linkedAccounts: 0, exactDeviceMatches: 0, sharedIpMatches: 0 };
  const r = await pool.query(
    `SELECT risk_score, linked_accounts, exact_device_matches, shared_ip_matches
     FROM account_security_flags WHERE telegram_user_id=$1`,
    [String(userId)]
  );
  const row = r.rows[0] || {};
  return {
    riskScore: Number(row.risk_score || 0),
    linkedAccounts: Number(row.linked_accounts || 0),
    exactDeviceMatches: Number(row.exact_device_matches || 0),
    sharedIpMatches: Number(row.shared_ip_matches || 0)
  };
}

async function getUser(userId, { fresh = false } = {}) {
  requireDatabase();
  if (!fresh) {
    const cached = getCachedUser(userId);
    if (cached) return cached;
  }
  const r = await pool.query(
    `SELECT telegram_id, username, first_name, avatar_url, balance::float AS balance,
            banned, referred_by, games_played, games_won,
            total_wagered::float AS total_wagered, created_at, updated_at
     FROM users WHERE telegram_id=$1`,
    [String(userId)]
  );
  return cacheUser(r.rows[0] || null);
}

async function upsertUser(user, referralCode = null) {
  requireDatabase();
  const referral = String(referralCode || '').trim().replace(/^ref_/i, '');
  const referralOwner = (/^\d+$/.test(referral) && referral !== String(user.id)) ? referral : null;
  const r = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, avatar_url, referred_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::text IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE telegram_id=$5) THEN $5 ELSE NULL END)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=EXCLUDED.username,
       first_name=EXCLUDED.first_name,
       avatar_url=EXCLUDED.avatar_url,
       referred_by=COALESCE(users.referred_by, EXCLUDED.referred_by),
       updated_at=NOW()
     RETURNING telegram_id, username, first_name, avatar_url, balance::float AS balance,
               banned, referred_by, games_played, games_won,
               total_wagered::float AS total_wagered, created_at, updated_at`,
    [user.id, user.username || '', user.first_name || 'Игрок', user.photo_url || '', referralOwner]
  );
  return cacheUser(r.rows[0]);
}

async function getBalance(userId) {
  const u = await getUser(userId);
  return u ? Number(u.balance) : 0;
}

async function debitBalance(userId, amount, meta = {}) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE users
       SET balance = balance - $2, updated_at=NOW()
       WHERE telegram_id=$1 AND banned=false AND balance >= $2
       RETURNING balance::float AS balance`,
      [String(userId), amount]
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      throw new Error("Недостаточно Stars на балансе.");
    }
    const balanceAfter = Number(r.rows[0].balance);

    // Wagering: a real bet (PVP or Upgrade) works off any outstanding promo
    // wager requirement, stake-for-stake, win or lose. If the balance is
    // fully drained while a requirement is still open, the requirement is
    // cleared right away — there's nothing left of the bonus to protect,
    // and leaving it open would otherwise trap the player's later, unrelated
    // deposits behind a stale requirement.
    if (meta.countsAsWager) {
      await client.query(
        `UPDATE users SET wager_remaining = GREATEST(0, wager_remaining - $2) WHERE telegram_id=$1`,
        [String(userId), amount]
      );
      if (balanceAfter <= 0) {
        await client.query(`UPDATE users SET wager_remaining=0 WHERE telegram_id=$1`, [String(userId)]);
      }
    }

    await client.query(
      `INSERT INTO balance_transactions
       (telegram_user_id, type, amount, balance_after, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [String(userId), meta.type || "pvp_bet", -amount, balanceAfter, meta.description || "Ставка PVP"]
    );
    await client.query("COMMIT");
    invalidateUserCache(userId);
    cacheUser(await getUser(userId, { fresh: true }));
    return balanceAfter;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function creditBalance(userId, amount, client = pool, meta = {}) {
  if (!client) throw new Error("DATABASE_URL не настроен.");
  const r = await client.query(
    `UPDATE users SET balance = balance + $2, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
    [String(userId), amount]
  );
  if (!r.rowCount) throw new Error("Пользователь не найден.");
  const balanceAfter = Number(r.rows[0].balance);
  await client.query(
    `INSERT INTO balance_transactions
     (telegram_user_id, type, amount, balance_after, description, admin_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [String(userId), meta.type || "credit", amount, balanceAfter, meta.description || "", meta.adminId || null]
  );
  invalidateUserCache(userId);
  return balanceAfter;
}

async function adjustAdminBalance(targetId, delta, adminId, description, wagerMultiplier = 0) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT balance::float AS balance, banned FROM users WHERE telegram_id=$1 FOR UPDATE`,
      [String(targetId)]
    );
    if (!current.rowCount) throw new Error("Пользователь не найден.");
    const before = Number(current.rows[0].balance);
    const after = before + Number(delta);
    if (after < 0) throw new Error("Нельзя списать больше текущего баланса.");

    const updated = await client.query(
      `UPDATE users SET balance=$2, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
      [String(targetId), after]
    );
    const balanceAfter = Number(updated.rows[0].balance);
    const wagerX = Number(wagerMultiplier || 0);
    if (delta > 0 && wagerX > 0) {
      await client.query(
        `UPDATE users SET wager_remaining=wager_remaining+$2::numeric, updated_at=NOW() WHERE telegram_id=$1`,
        [String(targetId), Number(delta) * wagerX]
      );
    }
    await client.query(
      `INSERT INTO balance_transactions
       (telegram_user_id, type, amount, balance_after, description, admin_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [String(targetId), delta >= 0 ? "admin_credit" : "admin_debit", Number(delta), balanceAfter, `${description || "Изменение администратором"}${delta > 0 && Number(wagerMultiplier || 0) > 0 ? ` · вагер x${Number(wagerMultiplier)}` : ""}`, String(adminId)]
    );
    await client.query("COMMIT");
    invalidateUserCache(targetId);
    return balanceAfter;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function setBanned(targetId, banned, adminId) {
  requireDatabase();
  const r = await pool.query(
    `UPDATE users SET banned=$2, updated_at=NOW() WHERE telegram_id=$1 RETURNING telegram_id, banned`,
    [String(targetId), !!banned]
  );
  if (!r.rowCount) throw new Error("Пользователь не найден.");
  await pool.query(
    `INSERT INTO balance_transactions
     (telegram_user_id, type, amount, balance_after, description, admin_id)
     SELECT telegram_id, $2, 0, balance, $3, $4 FROM users WHERE telegram_id=$1`,
    [String(targetId), banned ? "admin_ban" : "admin_unban", banned ? "Бан администратором" : "Разбан администратором", String(adminId)]
  );
  if (banned) io.to(`user:${targetId}`).emit("force_banned");
  else io.to(`user:${targetId}`).emit("unbanned");
  return r.rows[0];
}

async function finishRound() {
  if (state.status !== "COUNTDOWN") return;
  state.status = "SPINNING";
  state.countdownEndsAt = null;

  const players = [...state.players.values()];

  // Provably-fair round seed: everything random about this round (who wins,
  // exactly where the pointer stops) is derived from this one seed, so the
  // seed + hash shown afterwards in the round history are enough for anyone
  // to recompute the exact same result.
  const roundSeed = crypto.randomBytes(16).toString("hex");
  const roundSeedHash = crypto.createHash("sha256").update(roundSeed).digest("hex");

  const winner = weightedWinner(players, seededFloat(roundSeed, "winner"));
  if (!winner) {
    state.status = "WAITING";
    broadcast();
    return;
  }

  state.winnerId = winner.id;
  let winnerBalanceAfter = null;
  const bank = totalBank();

  // The server settles the outcome, but the UI will not reveal the winner
  // until the pointer animation has fully stopped.
  let sectorStart = 0;
  for (const p of players) {
    const share = bank > 0 ? (Number(p.bet) / bank) * 100 : 0;
    if (p.id === winner.id) {
      // Stop at a random point INSIDE the winner's sector, not at its
      // center, so repeated wins land at different positions. Derived from
      // the same round seed as the winner pick (different salt).
      const edge = Math.min(0.75, share / 4);
      const usableStart = sectorStart + edge;
      const usableEnd = sectorStart + share - edge;
      const fraction = usableEnd > usableStart
        ? usableStart + seededFloat(roundSeed, "angle") * (usableEnd - usableStart)
        : sectorStart + share / 2;
      state.spinTargetAngle = fraction * 3.6;
      break;
    }
    sectorStart += share;
  }

  // Telegram Stars are whole Stars, so production payout is rounded down.
  // The winner still can never receive less than their original stake.
  const normalPayout = Math.floor(bank * 0.92);
  const payout = Math.max(Number(winner.bet), normalPayout);
  const commission = Math.max(0, Number((bank - payout).toFixed(2)));

  state.payout = payout;
  state.commission = commission;
  winner.status = "winner";
  for (const p of players) if (p.id !== winner.id) p.status = "lost";

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Winner's stake has already been debited when it was placed.
      const r = await client.query(
        `UPDATE users SET balance=balance+$2, updated_at=NOW()
         WHERE telegram_id=$1 RETURNING balance::float AS balance`,
        [String(winner.id), payout]
      );
      if (!r.rowCount) throw new Error("Победитель не найден при расчёте.");
      const balanceAfter = Number(r.rows[0].balance);
      await client.query(
        `INSERT INTO balance_transactions
         (telegram_user_id, type, amount, balance_after, description)
         VALUES ($1,'pvp_win',$2,$3,$4)`,
        [String(winner.id), payout, balanceAfter, `Победа PVP, раунд ${state.roomId}`]
      );

      // Update per-player profile statistics for every funded participant.
      for (const p of players) {
        await client.query(
          `UPDATE users
           SET games_played = games_played + 1,
               games_won = games_won + $2,
               total_wagered = total_wagered + $3,
               updated_at = NOW()
           WHERE telegram_id=$1`,
          [String(p.id), p.id === winner.id ? 1 : 0, Number(p.bet)]
        );
      }

      await client.query(
        `INSERT INTO pvp_rounds (id, bank, winner_id, winner_bet, payout, commission, players, server_seed, server_seed_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [state.roomId, bank, winner.id, winner.bet, payout, commission, JSON.stringify(publicState().players), roundSeed, roundSeedHash]
      );
      await client.query("COMMIT");
      winnerBalanceAfter = balanceAfter;
      invalidateUserCache(winner.id);
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Round settlement error:", e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Round settlement database error:", e.message);
  }

  broadcast();

  // Keep the final result on screen after the arrow animation completes.
  setTimeout(() => {
    if (state.status === "SPINNING") {
      state.status = "RESULT";
      broadcast();
      // Do not reveal the winner via their balance while the arrow is still
      // moving. Everyone receives this update only after the visible result.
      if (winnerBalanceAfter != null) {
        io.to(`user:${winner.id}`).emit("balance_updated", { balance: winnerBalanceAfter });
      }
    }
  }, 6350);

  setTimeout(resetRound, 11500);
}

function startCountdownIfNeeded() {
  const fundedPlayers = [...state.players.values()].filter(p => Number(p.bet) > 0);
  if (state.status === "WAITING" && fundedPlayers.length >= 2) {
    state.status = "COUNTDOWN";
    state.countdownEndsAt = Date.now() + 20000;
    broadcast();
    clearTimeout(timerHandle);
    timerHandle = setTimeout(finishRound, 20050);
  }
}

function resetRound() {
  clearTimeout(timerHandle);
  state.roomId = crypto.randomUUID();
  state.status = "WAITING";
  state.countdownEndsAt = null;
  state.players.clear();
  state.winnerId = null;
  state.commission = 0;
  state.payout = 0;

  // Tell all still-open Mini Apps to register themselves in the new room.
  io.emit("new_round", { roomId: state.roomId });
  broadcast();
}

function addOrUpdatePlayer({ id, name, avatar }) {
  const existing = state.players.get(id);
  if (existing) return existing;
  const color = availableColor();
  if (!color) throw new Error("В этой комнате закончились цвета.");
  const player = { id, name: safeName(name), avatar: avatar || "", color, bet: 0, status: "active", betLocked: false };
  state.players.set(id, player);
  return player;
}

async function placeBet(playerId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Ставка должна быть целым числом Stars больше 0.");
  if (state.status !== "WAITING" && state.status !== "COUNTDOWN") throw new Error("Ставки сейчас закрыты.");
  if (state.status === "COUNTDOWN" && state.countdownEndsAt && Date.now() >= state.countdownEndsAt) throw new Error("Время ставок закончилось.");

  let p = state.players.get(playerId);

  // A connected socket can survive the previous round while the in-memory
  // room is reset. Recreate that player's room record automatically instead
  // of returning the confusing "Игрок не найден" error.
  if (!p) {
    const dbUser = await getUser(playerId);
    if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
    if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");

    p = addOrUpdatePlayer({
      id: playerId,
      name: dbUser.username ? "@" + dbUser.username : dbUser.first_name,
      avatar: dbUser.avatar_url
    });
  }

  if (p.betLocked) throw new Error("Предыдущая ставка ещё обрабатывается.");

  p.betLocked = true;
  try {
    const balance = await debitBalance(playerId, amount, { countsAsWager: true });
    p.bet += amount;
    p.betLocked = false;
    broadcast();
    startCountdownIfNeeded();
    return { player: p, balance };
  } catch (e) {
    p.betLocked = false;
    throw e;
  }
}

// ---------- SOLO GAME RISK RULES ----------
// Solo outcomes stay random and are never selected by player identity/history.
// Upgrade uses a disclosed 8% house edge: actual win chance is 92% of the
// mathematically fair chance (stake / target). This gives the application a
// positive expected margin without rigging a particular player's outcome.
// The guarantee is mathematical expectation, not a promise that every finite
// sequence of rounds is profitable.
const SOLO_HOUSE_EDGE = (() => {
  const raw = Number(String(process.env.SOLO_HOUSE_EDGE ?? "0.08").replace(",", "."));
  return Number.isFinite(raw) ? Math.min(0.25, Math.max(0, raw)) : 0.08;
})();
const SOLO_RTP = 1 - SOLO_HOUSE_EDGE;

// ---------- UPGRADE (solo game) ----------
// Player picks a stake and a target amount (target > stake). The displayed
// chance is the fair chance (stake/target) reduced by the configured house
// edge. Win: balance receives `target`. Loss: the stake is already debited.

// ---------- ОТСКОК (solo game) ----------
// The client supplies only the stake and mode. The server debits the real
// PostgreSQL balance, determines the result with crypto randomness and
// credits the authoritative payout before sending the visual result.
const BOUNCE_MODES = [
  { key: "easy", name: "Лёгкий", step: 0.10, chance: 0.65 },
  { key: "medium", name: "Средний", step: 0.15, chance: 0.50 },
  { key: "hard", name: "Сложный", step: 0.20, chance: 0.35 }
];
const activeBounceGames = new Map();

function secureUnit() {
  return crypto.randomInt(0, 1_000_000_000) / 1_000_000_000;
}

function randomBounceCount() {
  // Most real trajectories finish after a relatively small number of hits,
  // while long runs stay possible. The cap keeps the payout bounded.
  const u = Math.max(Number.EPSILON, secureUnit());
  return Math.min(25, Math.max(1, 1 + Math.floor(-Math.log(u) * 5.5)));
}

async function playBounce(playerId, bet, modeIndex) {
  if (!Number.isFinite(bet) || bet < 0.1 || bet > 50000) {
    throw new Error("Ставка должна быть от 0.1 до 50 000 Stars.");
  }
  const normalizedBet = Number(bet.toFixed(2));
  const mode = BOUNCE_MODES[Number(modeIndex)] || BOUNCE_MODES[0];

  const dbUser = await getUser(playerId, { fresh: true });
  if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
  if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
  const activeKey = String(playerId);
  if (activeBounceGames.has(activeKey)) throw new Error("Предыдущий раунд «ОТСКОК» ещё не закончился.");
  activeBounceGames.set(activeKey, { startedAt: Date.now(), bet: normalizedBet });

  let balance;
  try {
    balance = await debitBalance(playerId, normalizedBet, {
    type: "bounce_bet",
    description: `ОТСКОК · ${mode.name} · ставка ${normalizedBet} ⭐`,
    countsAsWager: true
    });
  } catch (e) {
    activeBounceGames.delete(activeKey);
    throw e;
  }

  const win = secureUnit() < mode.chance;
  const bounces = randomBounceCount();
  const multiplier = Number((bounces * mode.step).toFixed(2));
  let payout = win ? Number((normalizedBet * multiplier).toFixed(2)) : 0;
  let balanceAfter = balance;

  if (payout > 0) {
    balanceAfter = await creditBalance(playerId, payout, pool, {
      type: "bounce_win",
      description: `ОТСКОК · ${multiplier.toFixed(2)}× · выплата ${payout.toFixed(2)} ⭐`
    });
  }

  try {
    await pool.query(
      `UPDATE users
       SET games_played = games_played + 1,
           games_won = games_won + $2,
           total_wagered = total_wagered + $3,
           updated_at = NOW()
       WHERE telegram_id=$1`,
      [String(playerId), win ? 1 : 0, normalizedBet]
    );
    invalidateUserCache(playerId);
  } catch (e) {
    console.error("Bounce stats update error:", e.message);
  }

  // Запасной таймер на случай обрыва связи; в норме блокировку снимает событие bounce_done,
  // которое клиент шлёт в момент, когда шар попал в зону и раунд реально закончился.
  setTimeout(() => activeBounceGames.delete(activeKey), 60000);

  return {
    win,
    mode: mode.key,
    modeIndex: BOUNCE_MODES.indexOf(mode),
    chance: Number((mode.chance * 100).toFixed(2)),
    step: mode.step,
    bet: normalizedBet,
    bounces,
    multiplier,
    payout,
    balance: balanceAfter,
    // Видимая длительность раунда (замедленная физика, шар живёт дольше). Клиент делит её на BSLOW.
    durationMs: Math.round(4500 + bounces * 800)
  };
}


// ---------- ДРОП (plinko) и ПЕНАЛЬТИ (solo, в стиле ОТСКОК) ----------
// Как и в ОТСКОКЕ: клиент присылает только ставку, режим (вкладку) и, для
// пенальти, выбранную зону. Списание, случайность и выплата — на сервере.
const PLINKO_ROWS = 10;
const PLINKO_SHAPES = [
  { key: "easy",   name: "Лёгкий",   shape: [5.6, 2.1, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 2.1, 5.6] },
  { key: "medium", name: "Средний",  shape: [18, 4, 1.7, 1.1, 0.6, 0.3, 0.6, 1.1, 1.7, 4, 18] },
  { key: "hard",   name: "Сложный",  shape: [40, 9, 2.6, 0.9, 0.3, 0.2, 0.3, 0.9, 2.6, 9, 40] }
];
// Множители нормируются так, чтобы ожидаемая отдача = SOLO_RTP (1 - комиссия).
const PLINKO_MODES = PLINKO_SHAPES.map(m => {
  const n = PLINKO_ROWS;
  let c = 1; const probs = [1];
  for (let k = 1; k <= n; k++) { c = c * (n - k + 1) / k; probs.push(c); }
  const total = 2 ** n;
  const raw = m.shape.reduce((a, x, k) => a + x * probs[k] / total, 0);
  const scale = SOLO_RTP / raw;
  return { key: m.key, name: m.name, mults: m.shape.map(x => Number((x * scale).toFixed(2))) };
});

const PENALTY_ZONES = 5;
const PENALTY_MODES = [
  { key: "easy",   name: "Лёгкий",  covered: 1 },
  { key: "medium", name: "Средний", covered: 2 },
  { key: "hard",   name: "Сложный", covered: 3 }
].map(m => {
  const chance = (PENALTY_ZONES - m.covered) / PENALTY_ZONES;
  return { ...m, chance, mult: Number((SOLO_RTP / chance).toFixed(2)) };
});

const SOLO_MODES_PUBLIC = {
  plinko: { rows: PLINKO_ROWS, modes: PLINKO_MODES, maxBalls: 20, staggerMs: 180 },
  penalty: { zones: PENALTY_ZONES, modes: PENALTY_MODES.map(m => ({ key: m.key, name: m.name, covered: m.covered, chance: m.chance, mult: m.mult })) }
};

const soloBusy = new Map();
async function playSoloRound(playerId, bet, key, title, durationMs, resolve) {
  if (!Number.isFinite(bet) || bet < 0.1 || bet > 50000) {
    throw new Error("Ставка должна быть от 0.1 до 50 000 Stars.");
  }
  const b = Number(bet.toFixed(2));
  const dbUser = await getUser(playerId, { fresh: true });
  if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
  if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
  const busyKey = `${key}:${playerId}`;
  if (soloBusy.has(busyKey)) throw new Error(`Предыдущий раунд «${title}» ещё не закончился.`);
  soloBusy.set(busyKey, Date.now());
  try {
    const balance = await debitBalance(playerId, b, {
      type: `${key}_bet`, description: `${title} · ставка ${b} ⭐`, countsAsWager: true
    });
    const r = resolve();
    const payout = r.payout != null ? Number(Number(r.payout).toFixed(2)) : Number((b * r.multiplier).toFixed(2));
    const win = payout >= b;
    let balanceAfter = balance;
    if (payout > 0) {
      balanceAfter = await creditBalance(playerId, payout, pool, {
        type: `${key}_win`,
        description: `${title} · ${r.multiplier.toFixed(2)}× · выплата ${payout.toFixed(2)} ⭐`
      });
    }
    try {
      await pool.query(
        `UPDATE users SET games_played = games_played + 1, games_won = games_won + $2,
           total_wagered = total_wagered + $3, updated_at = NOW() WHERE telegram_id=$1`,
        [String(playerId), win ? 1 : 0, b]
      );
      invalidateUserCache(playerId);
    } catch (e) { console.error(`${title} stats update error:`, e.message); }
    return { ...r, win, bet: b, payout, balance: balanceAfter, durationMs };
  } finally {
    setTimeout(() => soloBusy.delete(busyKey), durationMs + 450);
  }
}

const PLINKO_MAX_BALLS = 20;
const PLINKO_MAX_TOTAL_BET = 50000;
const PLINKO_RED_BOOST = 1.2;      // красные слоты (множитель < 1) выпадают в 1.2 раза чаще
const PLINKO_BALL_STAGGER_MS = 180; // задержка между шарами при массовом запуске

function plinkoBinomial(n) {
  let c = 1; const w = [1];
  for (let k = 1; k <= n; k++) { c = c * (n - k + 1) / k; w.push(c); }
  return w;
}
// Вероятность каждого слота с учётом усиления красных зон
function plinkoSlotWeights(mode) {
  const w = plinkoBinomial(PLINKO_ROWS).map((x, k) => x * (mode.mults[k] < 1 ? PLINKO_RED_BOOST : 1));
  const sum = w.reduce((a, x) => a + x, 0);
  return w.map(x => x / sum);
}
function plinkoRollBall(mode) {
  const probs = plinkoSlotWeights(mode);
  let u = secureUnit(), slot = probs.length - 1;
  for (let k = 0; k < probs.length; k++) { if (u < probs[k]) { slot = k; break; } u -= probs[k]; }
  // путь: ровно `slot` шагов вправо в случайном порядке
  const path = Array.from({ length: PLINKO_ROWS }, (_, i) => (i < slot ? 1 : 0));
  for (let i = path.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [path[i], path[j]] = [path[j], path[i]]; }
  return { path, slot, multiplier: mode.mults[slot] };
}

function playPlinko(playerId, bet, modeIndex, ballCount) {
  const idx = PLINKO_MODES[Number(modeIndex)] ? Number(modeIndex) : 0;
  const mode = PLINKO_MODES[idx];
  const count = Math.max(1, Math.min(PLINKO_MAX_BALLS, Math.floor(Number(ballCount) || 1)));
  if (!Number.isFinite(bet) || bet < 0.1 || bet > 50000) throw new Error("Ставка должна быть от 0.1 до 50 000 Stars.");
  const perBet = Number(bet.toFixed(2));
  const total = Number((perBet * count).toFixed(2));
  if (total > PLINKO_MAX_TOTAL_BET) throw new Error(`Общая ставка за раунд не может быть больше ${PLINKO_MAX_TOTAL_BET} Stars.`);
  const durationMs = 4700 + (count - 1) * PLINKO_BALL_STAGGER_MS;
  return playSoloRound(playerId, total, "plinko", "ДРОП", durationMs, () => {
    const balls = Array.from({ length: count }, () => plinkoRollBall(mode));
    const payout = balls.reduce((a, x) => a + perBet * x.multiplier, 0);
    const multiplier = Number((payout / total).toFixed(4)); // средний множитель по шарам
    return { modeIndex: idx, mode: mode.key, count, perBet, balls, path: balls[0].path, slot: balls[0].slot, multiplier, payout };
  });
}

// ---------- ПЕНАЛЬТИ: серия ударов (как в «Башне») ----------
// После гола можно бить дальше (множитель растёт) или забрать выигрыш.
// Множитель после n голов = SOLO_RTP / chance^n, поэтому отдача остаётся ≈ SOLO_RTP на любом шаге.
const PENALTY_MAX_STREAK = 6;          // максимум ударов в серии (после последнего гола выплата автоматическая)
const PENALTY_IDLE_MS = 120000;        // нет действий 2 минуты — выигрыш забирается автоматически
const penaltySessions = new Map();     // playerId -> { bet, idx, streak, mult, busy, timer, socketId }

function penaltyMultAt(mode, n) { return Number((SOLO_RTP / Math.pow(mode.chance, n)).toFixed(2)); }

function penaltyRollShot(mode, zone) {
  const zones = Array.from({ length: PENALTY_ZONES }, (_, i) => i);
  for (let i = zones.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [zones[i], zones[j]] = [zones[j], zones[i]]; }
  const covered = zones.slice(0, mode.covered).sort((a, b) => a - b);
  return { covered, saved: covered.includes(zone) };
}

async function penaltyFinishStats(playerId, bet, won) {
  try {
    await pool.query(
      `UPDATE users SET games_played = games_played + 1, games_won = games_won + $2,
         total_wagered = total_wagered + $3, updated_at = NOW() WHERE telegram_id=$1`,
      [String(playerId), won ? 1 : 0, bet]
    );
    invalidateUserCache(playerId);
  } catch (e) { console.error("ПЕНАЛЬТИ stats update error:", e.message); }
}

async function penaltyPayout(playerId, sess, reason) {
  const mode = PENALTY_MODES[sess.idx];
  const payout = Number((sess.bet * sess.mult).toFixed(2));
  const balance = await creditBalance(playerId, payout, pool, {
    type: "penalty_win",
    description: `ПЕНАЛЬТИ · серия ${sess.streak} · ${sess.mult.toFixed(2)}× · выплата ${payout.toFixed(2)} ⭐${reason ? " · " + reason : ""}`
  });
  await penaltyFinishStats(playerId, sess.bet, true);
  return { payout, balance, mode };
}

function penaltyArmTimer(playerId, sess) {
  clearTimeout(sess.timer);
  sess.timer = setTimeout(async () => {
    if (penaltySessions.get(String(playerId)) !== sess || sess.busy) return;
    penaltySessions.delete(String(playerId));
    try { if (sess.streak > 0) await penaltyPayout(playerId, sess, "авто-выплата"); } catch (e) { console.error("penalty auto cashout:", e.message); }
  }, PENALTY_IDLE_MS);
}

async function penaltyShoot(playerId, sess, zone) {
  const mode = PENALTY_MODES[sess.idx];
  const shot = penaltyRollShot(mode, zone);
  const base = { kind: "shot", modeIndex: sess.idx, mode: mode.key, pick: zone, covered: shot.covered, saved: shot.saved, bet: sess.bet, durationMs: 3400 };
  if (shot.saved) {
    penaltySessions.delete(String(playerId));
    clearTimeout(sess.timer);
    await penaltyFinishStats(playerId, sess.bet, false);
    const u = await getUser(playerId, { fresh: true });
    return { ...base, streak: sess.streak, multiplier: 0, payout: 0, win: false, over: true, canContinue: false, balance: Number(u?.balance ?? sess.balance) };
  }
  sess.streak += 1;
  sess.mult = penaltyMultAt(mode, sess.streak);
  if (sess.streak >= PENALTY_MAX_STREAK) {
    penaltySessions.delete(String(playerId));
    clearTimeout(sess.timer);
    const paid = await penaltyPayout(playerId, sess, "макс. серия");
    return { ...base, streak: sess.streak, multiplier: sess.mult, payout: paid.payout, win: true, over: true, canContinue: false, balance: paid.balance };
  }
  penaltyArmTimer(playerId, sess);
  return {
    ...base, streak: sess.streak, multiplier: sess.mult, payout: 0, potential: Number((sess.bet * sess.mult).toFixed(2)),
    nextMultiplier: penaltyMultAt(mode, sess.streak + 1), win: false, over: false, canContinue: true, balance: sess.balance
  };
}

async function playPenalty(playerId, bet, modeIndex, pick) {
  const idx = PENALTY_MODES[Number(modeIndex)] ? Number(modeIndex) : 0;
  const zone = Number(pick);
  if (!Number.isInteger(zone) || zone < 0 || zone >= PENALTY_ZONES) throw new Error("Выберите зону ворот.");
  if (!Number.isFinite(bet) || bet < 0.1 || bet > 50000) throw new Error("Ставка должна быть от 0.1 до 50 000 Stars.");
  const b = Number(bet.toFixed(2));
  const key = String(playerId);
  if (penaltySessions.has(key)) throw new Error("Серия «ПЕНАЛЬТИ» ещё не закончена: бейте дальше или заберите выигрыш.");
  const dbUser = await getUser(playerId, { fresh: true });
  if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
  if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
  const sess = { bet: b, idx, streak: 0, mult: 0, busy: true, timer: null, balance: 0 };
  penaltySessions.set(key, sess);
  try {
    sess.balance = await debitBalance(playerId, b, { type: "penalty_bet", description: `ПЕНАЛЬТИ · ставка ${b} ⭐`, countsAsWager: true });
    return await penaltyShoot(playerId, sess, zone);
  } catch (e) {
    if (sess.streak === 0) { penaltySessions.delete(key); clearTimeout(sess.timer); }
    throw e;
  } finally { sess.busy = false; }
}

async function penaltyNext(playerId, pick) {
  const key = String(playerId);
  const sess = penaltySessions.get(key);
  if (!sess || sess.streak < 1) throw new Error("Нет активной серии «ПЕНАЛЬТИ».");
  if (sess.busy) throw new Error("Удар ещё выполняется.");
  const zone = Number(pick);
  if (!Number.isInteger(zone) || zone < 0 || zone >= PENALTY_ZONES) throw new Error("Выберите зону ворот.");
  sess.busy = true;
  try { return await penaltyShoot(playerId, sess, zone); }
  finally { sess.busy = false; }
}

async function penaltyCashout(playerId) {
  const key = String(playerId);
  const sess = penaltySessions.get(key);
  if (!sess || sess.streak < 1) throw new Error("Нечего забирать.");
  if (sess.busy) throw new Error("Удар ещё выполняется.");
  sess.busy = true;
  penaltySessions.delete(key);
  clearTimeout(sess.timer);
  try {
    const paid = await penaltyPayout(playerId, sess, "забрал");
    return { kind: "cashout", modeIndex: sess.idx, streak: sess.streak, multiplier: sess.mult, payout: paid.payout, bet: sess.bet, win: true, over: true, canContinue: false, balance: paid.balance, durationMs: 0 };
  } catch (e) { penaltySessions.set(key, sess); throw e; }
  finally { sess.busy = false; }
}

async function playUpgrade(playerId, bet, target) {
  if (!Number.isInteger(bet) || bet <= 0) throw new Error("Ставка должна быть целым числом Stars больше 0.");
  if (!Number.isInteger(target) || target <= bet) throw new Error("Цель должна быть целым числом Stars больше ставки.");

  const dbUser = await getUser(playerId);
  if (!dbUser) throw new Error("Пользователь не найден в базе данных.");
  if (dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");

  const fairChance = (bet / target) * 100;
  const chance = fairChance * SOLO_RTP;

  let balance = await debitBalance(playerId, bet, {
    type: "upgrade_bet",
    description: `Апгрейд ${bet} → ${target} ⭐`,
    countsAsWager: true
  });

  // The random value is the position where the arrow will stop around the
  // circle. Yellow occupies [0, chance), therefore the result is determined
  // exclusively by the sector under that final arrow position.
  const max = 1_000_000_000;
  const r = Number(BigInt("0x" + crypto.randomBytes(8).toString("hex")) % BigInt(max));
  const rollPercent = Number(((r / max) * 100).toFixed(6));
  const win = rollPercent < chance;

  // The server is authoritative about both the outcome and the exact visual
  // landing point. The client uses this same roll percentage, so the pointer
  // can never land in yellow for a loss or in gray for a win.
  if (win) {
    try {
      balance = await creditBalance(playerId, target, pool, {
        type: "upgrade_win",
        description: `Выигрыш апгрейда ${bet} → ${target} ⭐`
      });
    } catch (e) {
      console.error("Upgrade payout error:", e.message);
    }
  }

  try {
    await pool.query(
      `UPDATE users
       SET games_played = games_played + 1,
           games_won = games_won + $2,
           total_wagered = total_wagered + $3,
           updated_at = NOW()
       WHERE telegram_id=$1`,
      [String(playerId), win ? 1 : 0, bet]
    );
    invalidateUserCache(playerId);
  } catch (e) {
    console.error("Upgrade stats update error:", e.message);
  }

  return {
    win,
    fairChance: Number(fairChance.toFixed(4)),
    chance: Number(chance.toFixed(4)),
    houseEdge: Number((SOLO_HOUSE_EDGE * 100).toFixed(2)),
    bet,
    target,
    rollPercent,
    payout: win ? target : 0,
    balance
  };
}

async function authenticatedUserFromInitData(initData, referralCode = null) {
  const checked = validateTelegramInitData(initData);
  if (!checked.ok) {
    const messages = {
      missing: "Откройте приложение через Telegram Mini App.",
      bot_token_missing: "TELEGRAM_BOT_TOKEN не настроен на Render.",
      hash_missing: "Telegram initData не содержит hash.",
      hash_invalid: "Авторизация Telegram недействительна. Проверьте TELEGRAM_BOT_TOKEN и URL Mini App.",
      expired: "Сессия Telegram устарела. Закройте и снова откройте Mini App.",
      user_missing: "Не удалось определить пользователя Telegram.",
      parse_error: "Не удалось прочитать данные Telegram."
    };
    throw new Error(messages[checked.reason] || "Авторизация Telegram не выполнена.");
  }
  const user = await upsertUser(checked.user, referralCode);
  if (user.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
  return { telegram: checked.user, db: user };
}

async function requireAdminRequest(req) {
  const raw = req.headers["x-telegram-init-data"] || "";
  const cacheKey = raw;
  const hit = adminAuthCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30000) return hit.user;

  const checked = validateTelegramInitData(raw);
  if (!checked.ok) throw new Error("Авторизация Telegram не выполнена.");
  const id = String(checked.user.id);
  if (!isAdmin(id)) throw new Error("Нет доступа к админ-панели.");
  adminAuthCache.set(cacheKey, { user: checked.user, at: Date.now() });
  return checked.user;
}

// ===================== ICE ARENA =====================
// Separate multiplayer mode: territory-conquest round, shared with the rest
// of the app's Postgres balance (debitBalance/creditBalance/getUser/isAdmin
// above), its own socket.io events (all prefixed "ice_") and its own
// in-memory round state so it never touches the PVP `state` object.
const ICE_COUNTDOWN = 10000, ICE_CLOSE = 1000, ICE_RUN_MS = 13600, ICE_RUN_MS_REDO = 26000, ICE_RESULT_MS = 4500;
const ICE_COLORS = ["#ffc61a", "#ff8a1f", "#f4c430", "#e8720c", "#ffe066", "#d4a017", "#ff7f11", "#ffb347"];
const ice_r3 = x => Math.round(x * 1000) / 1000;

const ICE_ANOMALY_WEIGHTS = { race: 0.08, mirage: 0.06, redo: 0.06 };
const ICE_ANOMALY_KEYS = Object.keys(ICE_ANOMALY_WEIGHTS);
function iceRollAnomaly() {
  const r = Math.random();
  let acc = 0;
  for (const k of ICE_ANOMALY_KEYS) { acc += ICE_ANOMALY_WEIGHTS[k]; if (r < acc) return k; }
  return null;
}
// Deterministic PRNG (mulberry32) seeded per round, so the winner pick can be
// re-derived and checked client-side from the revealed seed alone.
function iceRng(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const iceSha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");

let iceHistory = []; // finished rounds, newest first, capped at 200 (mirrored to ice_rounds)
let icePendingAnomaly = null;
let iceRoundSeq = 1;
let iceTimer = null;

function iceNewRound() {
  const seed = crypto.randomInt(0, 2 ** 31);
  const anomaly = icePendingAnomaly || iceRollAnomaly();
  icePendingAnomaly = null;
  return { id: iceRoundSeq++, status: "waiting", players: [], endsAt: 0, startAt: 0, seed, hash: iceSha256(seed), winnerId: null, anomaly, payout: 0, commission: 0 };
}
let iceRound = iceNewRound();

function iceSpot() {
  let best = [50, 50], bd = -1;
  for (let k = 0; k < 40; k++) {
    const x = 10 + Math.random() * 80, y = 10 + Math.random() * 80;
    const d = iceRound.players.reduce((m, o) => Math.min(m, (o.sx - x) ** 2 + (o.sy - y) ** 2), 1e9);
    if (d > bd) { bd = d; best = [x, y]; }
  }
  return best;
}

function icePickWinner() {
  const bank = ice_r3(iceRound.players.reduce((s, p) => s + p.stake, 0));
  let x = iceRng(iceRound.seed)() * bank, w = iceRound.players[0];
  for (const p of iceRound.players) { if (x < p.stake) { w = p; break; } x -= p.stake; }
  return w;
}

function iceStateMsg() {
  const revealed = iceRound.status === "running" || iceRound.status === "result";
  return {
    now: Date.now(), id: iceRound.id, status: iceRound.status, endsAt: iceRound.endsAt, startAt: iceRound.startAt,
    hash: iceRound.hash, seed: revealed ? iceRound.seed : null, winnerId: iceRound.winnerId,
    anomaly: revealed ? (iceRound.anomaly || null) : null,
    payout: iceRound.status === "result" ? Number(iceRound.payout || 0) : 0,
    commission: iceRound.status === "result" ? Number(iceRound.commission || 0) : 0,
    players: iceRound.players.map(p => ({ id: p.id, name: p.name, photo: p.photo, stake: p.stake, color: p.color, sx: p.sx, sy: p.sy }))
  };
}
function iceHistMsg() {
  return { last: iceHistory[0] || null, top: iceHistory.reduce((b, g) => (!b || g.pool > b.pool ? g : b), null), list: iceHistory.slice(0, 30) };
}
function iceBroadcast() { io.emit("ice_state", iceStateMsg()); }
function iceBroadcastHistory() { io.emit("ice_history", iceHistMsg()); }

async function icePersistRound(entry) {
  try {
    requireDatabase();
    await pool.query(
      `INSERT INTO ice_rounds (id, pool, winner_id, seed, seed_hash, anomaly, payout, commission, players)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.pool, entry.winnerId, String(entry.seed), entry.hash, entry.anomaly, Number(entry.payout || 0), Number(entry.commission || 0), JSON.stringify(entry.players)]
    );
  } catch (e) { console.error("ice_rounds persist error:", e.message); }
}

async function loadIceHistory() {
  try {
    requireDatabase();
    const r = await pool.query(`SELECT id, created_at, pool, winner_id, seed, seed_hash, anomaly, payout, commission, players FROM ice_rounds ORDER BY id DESC LIMIT 200`);
    iceHistory = r.rows.map(row => {
      const players = row.players || [];
      const wp = players.find(p => p.id === row.winner_id) || {};
      return {
        id: Number(row.id), ts: new Date(row.created_at).getTime(), pool: Number(row.pool),
        winnerId: row.winner_id, name: wp.name || "", photo: wp.photo || "", color: wp.color || "#ffc61a",
        payout: Number(row.payout || 0), commission: Number(row.commission || 0),
        seed: Number(row.seed), hash: row.seed_hash, anomaly: row.anomaly || null, players
      };
    });
    iceRoundSeq = (iceHistory[0]?.id || 0) + 1;
    iceRound = iceNewRound();
  } catch (e) { console.error("loadIceHistory failed:", e.message); }
}

async function icePlaceBet(playerId, amount, meta) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error("Ставка — целое число от 1 ⭐ (1, 2, 3…)");
  if (iceRound.status === "running" || iceRound.status === "result") throw new Error("Раунд уже идёт, дождитесь следующего.");
  if (iceRound.status === "countdown" && Date.now() > iceRound.endsAt - ICE_CLOSE) throw new Error("Приём ставок закрыт.");

  let p = iceRound.players.find(x => x.id === playerId);
  if (p && p.betLocked) throw new Error("Предыдущая ставка ещё обрабатывается.");
  if (p) p.betLocked = true;

  let balance;
  try {
    balance = await debitBalance(playerId, amount, { type: "ice_bet", description: `Ставка Ice Arena, раунд #${iceRound.id}` });
  } catch (e) {
    if (p) p.betLocked = false;
    throw e;
  }

  if (!p) {
    const [sx, sy] = iceSpot();
    p = { id: playerId, name: meta.name, photo: meta.photo || "", stake: 0, color: ICE_COLORS[iceRound.players.length % ICE_COLORS.length], sx, sy, betLocked: false };
    iceRound.players.push(p);
  }
  p.stake = ice_r3(p.stake + amount);
  p.betLocked = false;

  if (iceRound.status === "waiting" && iceRound.players.length >= 2) {
    iceRound.status = "countdown";
    iceRound.endsAt = Date.now() + ICE_COUNTDOWN;
    clearTimeout(iceTimer);
    iceTimer = setTimeout(iceStartRun, ICE_COUNTDOWN);
  }
  iceBroadcast();
  return balance;
}

function iceStartRun() {
  const w = icePickWinner();
  iceRound.status = "running";
  iceRound.winnerId = w ? w.id : null;
  iceRound.startAt = Date.now() + 500;
  iceBroadcast();
  clearTimeout(iceTimer);
  iceTimer = setTimeout(iceFinish, iceRound.anomaly === "redo" ? ICE_RUN_MS_REDO : ICE_RUN_MS);
}

async function iceFinish() {
  const poolAmount = ice_r3(iceRound.players.reduce((s, p) => s + p.stake, 0));
  const winner = iceRound.players.find(p => p.id === iceRound.winnerId);
  // Same settlement rule as the PVP roll: target 8% commission, while the
  // winner is never paid less than the original stake.
  const normalPayout = Number((poolAmount * 0.92).toFixed(2));
  const payout = Math.max(Number(winner?.stake || 0), normalPayout);
  const commission = Math.max(0, Number((poolAmount - payout).toFixed(2)));
  iceRound.payout = payout;
  iceRound.commission = commission;
  const entry = {
    id: iceRound.id, ts: Date.now(), pool: poolAmount, winnerId: iceRound.winnerId,
    name: winner?.name || "", photo: winner?.photo || "", color: winner?.color || "#ffc61a",
    payout, commission,
    seed: iceRound.seed, hash: iceRound.hash, anomaly: iceRound.anomaly || null,
    players: iceRound.players.map(p => ({ id: p.id, name: p.name, photo: p.photo, color: p.color, stake: p.stake }))
  };
  iceHistory.unshift(entry);
  if (iceHistory.length > 200) iceHistory.length = 200;
  icePersistRound(entry);

  if (winner) {
    try {
      requireDatabase();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const balanceAfter = await creditBalance(winner.id, payout, client, { type: "ice_win", description: `Победа Ice Arena, раунд #${entry.id} · ${payout.toFixed(2)} ⭐ · комиссия ${commission.toFixed(2)} ⭐` });
        for (const p of iceRound.players) {
          await client.query(
            `UPDATE users SET games_played = games_played + 1, games_won = games_won + $2, total_wagered = total_wagered + $3, updated_at = NOW() WHERE telegram_id = $1`,
            [String(p.id), p.id === winner.id ? 1 : 0, Number(p.stake)]
          );
        }
        await client.query("COMMIT");
        io.to(`user:${winner.id}`).emit("balance_updated", { balance: balanceAfter });
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        console.error("Ice Arena settlement error:", e.message);
      } finally {
        client.release();
      }
    } catch (e) { console.error("Ice Arena settlement database error:", e.message); }
  }

  iceBroadcastHistory();
  iceRound.status = "result";
  iceBroadcast();
  clearTimeout(iceTimer);
  iceTimer = setTimeout(() => { iceRound = iceNewRound(); iceBroadcast(); }, ICE_RESULT_MS);
}
// =================== END ICE ARENA STATE ===================

io.on("connection", socket => {
  socket.on("join_room", async data => {
    try {
      const session = await authenticatedUserFromInitData(data?.initData, data?.referralCode);
      const tgUser = session.telegram;
      if (maintenanceMode && !isAdmin(tgUser.id)) {
        socket.emit("maintenance", { enabled: true, message: maintenanceMessage() });
        return;
      }
      const socketIp = String(socket.handshake?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || String(socket.handshake?.address || '');
      recordSecuritySignal(tgUser.id, {
        fingerprint: data?.clientFingerprint,
        ip: socketIp,
        userAgent: socket.handshake?.headers?.['user-agent'],
        platform: data?.telegramPlatform
      }).catch(e => console.error('Security signal error:', e.message));
      const p = addOrUpdatePlayer({
        id: tgUser.id,
        name: tgUser.username ? "@" + tgUser.username : tgUser.first_name,
        avatar: tgUser.photo_url
      });
      socket.data.playerId = p.id;
      socket.join(`user:${p.id}`);
      socket.emit("joined", {
        playerId: p.id,
        color: p.color,
        balance: session.db.balance,
        user: tgUser,
        isAdmin: isAdmin(p.id)
      });
      socket.emit("room_state", publicState());
      broadcast();
      socket.emit("ice_state", iceStateMsg());
      socket.emit("ice_history", iceHistMsg());
    } catch (e) {
      socket.emit("error_message", e.message);
    }
  });

  socket.on("new_round_ack", () => {
    // Kept for client compatibility; server state is already reset.
  });

  // ---- Ice Arena ----
  socket.on("ice_bet", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const dbUser = await getUser(id);
      if (!dbUser || dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
      const amount = Math.round(Number(data?.amount));
      const name = dbUser.username ? "@" + dbUser.username : (dbUser.first_name || "Игрок");
      const balance = await icePlaceBet(id, amount, { name, photo: dbUser.avatar_url || "" });
      socket.emit("balance_updated", { balance });
    } catch (e) {
      socket.emit("error_message", e.message);
    }
  });

  socket.on("ice_admin_force_anomaly", data => {
    const id = socket.data.playerId;
    if (!id || !isAdmin(id)) return;
    const key = ICE_ANOMALY_KEYS.includes(data?.anomaly) ? data.anomaly : null;
    if (iceRound.status === "waiting" || iceRound.status === "countdown") {
      iceRound.anomaly = key;
      iceBroadcast();
    } else {
      icePendingAnomaly = key;
    }
    socket.emit("ice_admin_ok", { msg: key ? "Аномалия применится к раунду." : "Форс аномалии снят." });
  });

  socket.on("ice_request_state", () => {
    socket.emit("ice_state", iceStateMsg());
    socket.emit("ice_history", iceHistMsg());
  });

  socket.on("ice_request_history", () => {
    socket.emit("ice_history", iceHistMsg());
  });

  socket.on("place_bet", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const dbUser = await getUser(id);
      if (!dbUser || dbUser.banned) throw new Error("Ваш аккаунт заблокирован в приложении.");
      const amount = Number(data?.amount);
      const result = await placeBet(id, amount);
      socket.emit("bet_accepted", { bet: result.player.bet, balance: result.balance });
      socket.emit("balance_updated", { balance: result.balance });
      broadcast();
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("upgrade_spin", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const bet = Number(data?.bet);
      const target = Number(data?.target);
      const result = await playUpgrade(id, bet, target);
      socket.emit("upgrade_result", result);
      // The balance itself reveals the result, so keep it hidden until the
      // arrow has visibly stopped on its yellow or gray sector.
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), 6350);
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("bounce_spin", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const bet = Number(data?.bet);
      const modeIndex = Number(data?.modeIndex ?? 0);
      const result = await playBounce(id, bet, modeIndex);
      socket.emit("bounce_result", result);
      // Do not reveal the final balance during the visible result animation.
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), result.durationMs + 2500); // запас: на последних отскоках слоу-мо, раунд может идти дольше
    } catch (e) { socket.emit("error_message", e.message); }
  });

  // Раунд ОТСКОК закончился на клиенте (шар попал в зону) — можно сразу начинать следующий.
  socket.on("bounce_done", () => {
    const id = socket.data.playerId;
    if (id) activeBounceGames.delete(String(id));
  });
  // То же для ДРОПа: снимаем блокировку, как только анимация закончилась.
  socket.on("solo_done", data => {
    const id = socket.data.playerId;
    const key = String(data?.key || "");
    if (id && key === "plinko") soloBusy.delete(`${key}:${id}`);
  });

  socket.on("solo_modes", (_d, cb) => { if (typeof cb === "function") cb(SOLO_MODES_PUBLIC); });

  socket.on("plinko_spin", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const result = await playPlinko(id, Number(data?.bet), Number(data?.modeIndex ?? 0), Number(data?.count ?? 1));
      socket.emit("plinko_result", result);
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), result.durationMs);
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("penalty_spin", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const result = await playPenalty(id, Number(data?.bet), Number(data?.modeIndex ?? 0), data?.pick);
      socket.emit("penalty_result", result);
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), result.durationMs);
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("penalty_next", async data => {
    try {
      const id = socket.data.playerId;
      if (maintenanceMode && !isAdmin(id)) throw new Error(maintenanceMessage());
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const result = await penaltyNext(id, data?.pick);
      socket.emit("penalty_result", result);
      setTimeout(() => socket.emit("balance_updated", { balance: result.balance }), result.durationMs);
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("penalty_cashout", async () => {
    try {
      const id = socket.data.playerId;
      if (!id) throw new Error("Авторизация Telegram не выполнена.");
      const result = await penaltyCashout(id);
      socket.emit("penalty_result", result);
      socket.emit("balance_updated", { balance: result.balance });
    } catch (e) { socket.emit("error_message", e.message); }
  });

  socket.on("request_state", () => socket.emit("room_state", publicState()));

  socket.on("disconnect", async () => {
    const pid = socket.data.playerId;
    const ps = pid ? penaltySessions.get(String(pid)) : null;
    if (ps && ps.streak > 0 && !ps.busy) {
      penaltySessions.delete(String(pid)); clearTimeout(ps.timer);
      try { await penaltyPayout(pid, ps, "выход из игры"); } catch (e) { console.error("penalty disconnect payout:", e.message); }
    }
    const id = socket.data.playerId;
    if (id && state.status === "WAITING") {
      const p = state.players.get(id);
      if (p && p.bet === 0 && !p.betLocked) state.players.delete(id);
      broadcast();
    }
  });
});

app.get("/api/system/status", async (req, res) => {
  try {
    const status = await maintenanceStatusForRequest(req);
    res.json({ ok: true, maintenance: status.enabled, isAdmin: status.isAdmin, message: maintenanceMessage() });
  } catch (e) {
    res.json({ ok: true, maintenance: maintenanceMode, isAdmin: false, message: maintenanceMessage() });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    res.json({ user: session.telegram, balance: session.db.balance, isAdmin: isAdmin(session.telegram.id), banned: session.db.banned });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get("/api/telegram/webhook-status", async (req, res) => {
  try {
    const checked = validateTelegramInitData(req.headers["x-telegram-init-data"]);
    if (!checked.ok || !isAdmin(checked.user.id)) return res.status(403).json({ error: "Нет доступа." });
    const info = await telegramApi("getWebhookInfo", {});
    res.json({ ok: true, url: info.url || "", pending: info.pending_update_count || 0, last_error: info.last_error_message || null, last_error_date: info.last_error_date || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/telegram/status", async (req, res) => {
  const checked = validateTelegramInitData(req.headers["x-telegram-init-data"]);
  res.json({
    telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
    initDataReceived: !!req.headers["x-telegram-init-data"],
    authorized: checked.ok,
    reason: checked.ok ? null : checked.reason,
    databaseConfigured: !!pool
  });
});

app.post("/api/stars/create-invoice", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "Неверная сумма Stars." });
    // Telegram's XTR invoice API accepts at most 2,500 Stars per invoice.
    if (amount > 2500) return res.status(400).json({ error: "За один платёж можно пополнить не более 2500 Stars." });
    if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: "TELEGRAM_BOT_TOKEN не настроен." });

    const payload = JSON.stringify({
      type: "balance_topup",
      amount,
      userId: session.telegram.id,
      nonce: crypto.randomUUID()
    });

    const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Пополнение баланса",
        description: `Пополнение на ${amount} Telegram Stars`,
        payload,
        currency: "XTR",
        prices: [{ label: "Stars", amount }]
      })
    });
    const data = await tg.json();
    if (!data.ok) return res.status(502).json({ error: data.description || "Telegram API error" });
    res.json({ invoiceUrl: data.result });
  } catch (e) {
    res.status(401).json({ error: e.message || "Не удалось создать счёт." });
  }
});


async function notifyBalanceTopup(userId, amount, method = "Пополнение") {
  const appUrl = buildMiniAppOpenUrl();
  const reply_markup = appUrl ? {
    inline_keyboard: [[{ text: "🎮 ИГРАТЬ", web_app: { url: appUrl } }]]
  } : undefined;
  await telegramApi("sendMessage", {
    chat_id: String(userId),
    text: `✅ <b>Баланс пополнен</b>\n\n+${Number(amount).toFixed(2)} ⭐\nСпособ: ${method}`,
    parse_mode: "HTML",
    ...(reply_markup ? { reply_markup } : {})
  });
}

// ---------------- TELEGRAM BOT ----------------
const freebetWizard = new Map();

function freebetStartParam(id) {
  return `fb_${String(id)}`;
}

function parseFreebetStartParam(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^fb_([0-9a-f-]{36})$/i);
  return m ? m[1] : null;
}

function welcomeConfig() {
  return {
    text: String(process.env.WELCOME_TEXT || "🎉 <b>Добро пожаловать в RING!</b>\n\nОткрывай приложение, участвуй в играх и розыгрышах.").trim(),
    imageUrl: String(process.env.WELCOME_IMAGE_URL || "").trim(),
    appUrl: String(process.env.WELCOME_APP_URL || buildMiniAppOpenUrl()).trim(),
    channelUrl: String(process.env.WELCOME_CHANNEL_URL || "").trim(),
    supportUrl: String(process.env.WELCOME_SUPPORT_URL || buildSupportChatUrl()).trim()
  };
}

function welcomeKeyboard() {
  const cfg = welcomeConfig();
  const rows = [];
  if (cfg.appUrl) rows.push([{ text: "🎮 ОТКРЫТЬ ПРИЛОЖЕНИЕ", web_app: { url: cfg.appUrl } }]);
  const links = [];
  if (cfg.channelUrl) links.push({ text: "📢 КАНАЛ", url: cfg.channelUrl });
  if (cfg.supportUrl) links.push({ text: "💬 ПОДДЕРЖКА", url: cfg.supportUrl });
  if (links.length) rows.push(links);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function sendWelcome(message) {
  if (!message?.chat?.id) return;
  const cfg = welcomeConfig();
  const reply_markup = welcomeKeyboard();
  if (cfg.imageUrl) {
    return telegramApi("sendPhoto", {
      chat_id: message.chat.id,
      photo: cfg.imageUrl,
      caption: cfg.text,
      parse_mode: "HTML",
      ...(reply_markup ? { reply_markup } : {})
    });
  }
  return telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: cfg.text,
    parse_mode: "HTML",
    ...(reply_markup ? { reply_markup } : {})
  });
}

async function createFreebet(adminId, activations, bonus, wager) {
  requireDatabase();
  if (!isAdmin(adminId)) throw new Error("Нет доступа.");
  const uses = Number(activations);
  const amount = Number(bonus);
  const wagerMultiplier = Number(wager);
  if (!Number.isInteger(uses) || uses <= 0 || uses > 1_000_000_000) throw new Error("Количество активаций должно быть целым числом от 1 до 1 000 000 000.");
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error("Сумма Stars должна быть целым числом от 1 до 1 000 000 000.");
  if (!Number.isFinite(wagerMultiplier) || wagerMultiplier < 0 || wagerMultiplier > 1000) throw new Error("Вагер должен быть числом от 0 до 1000.");

  const id = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO freebets (id, created_by, bonus, max_uses, wager) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, bonus::float AS bonus, max_uses, uses_count, wager::float AS wager, active, created_at`,
    [id, String(adminId), amount, uses, wagerMultiplier]
  );
  return r.rows[0];
}

async function claimFreebet(userId, freebetId) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fb = await client.query(
      `SELECT id, bonus::float AS bonus, max_uses, uses_count, wager::float AS wager, active
       FROM freebets WHERE id=$1 FOR UPDATE`,
      [String(freebetId)]
    );
    if (!fb.rowCount) throw new Error("Фрибет не найден.");
    const row = fb.rows[0];
    if (!row.active || Number(row.uses_count) >= Number(row.max_uses)) throw new Error("Этот фрибет уже закончился.");

    const inserted = await client.query(
      `INSERT INTO freebet_claims (freebet_id, telegram_user_id, bonus, wager)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING freebet_id`,
      [String(freebetId), String(userId), Number(row.bonus), Number(row.wager || 0)]
    );
    if (!inserted.rowCount) {
      const existingUser = await getUser(userId, { fresh: true });
      await client.query("ROLLBACK");
      return { claimed: false, alreadyClaimed: true, balance: Number(existingUser?.balance || 0), bonus: Number(row.bonus), wager: Number(row.wager || 0) };
    }

    const balance = await creditBalance(userId, Number(row.bonus), client, {
      type: "freebet",
      description: `Активация фрибета ${freebetId}`
    });
    const wagerMultiplier = Number(row.wager || 0);
    if (wagerMultiplier > 0) {
      await client.query(
        `UPDATE users SET wager_remaining = wager_remaining + $2 WHERE telegram_id=$1`,
        [String(userId), Number(row.bonus) * wagerMultiplier]
      );
    }

    const updated = await client.query(
      `UPDATE freebets SET uses_count=uses_count+1, active=(uses_count+1 < max_uses)
       WHERE id=$1
       RETURNING uses_count, max_uses, active`,
      [String(freebetId)]
    );

    await client.query("COMMIT");
    invalidateUserCache(userId);
    return {
      claimed: true,
      alreadyClaimed: false,
      bonus: Number(row.bonus),
      wager: wagerMultiplier,
      balance,
      usesCount: Number(updated.rows[0].uses_count),
      maxUses: Number(updated.rows[0].max_uses),
      active: !!updated.rows[0].active
    };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

function freebetLinkForBot(botUsername, freebetId) {
  return buildTelegramMiniAppLink(botUsername, freebetStartParam(freebetId));
}

async function sendFreebetQuestion(chatId, text) {
  await telegramApi("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "freebet:cancel" }]] } });
}


// ---------------- ADMIN USER STATS + BROADCAST ----------------
const adminStatsPeriodLabels = {
  today: "сегодня",
  week: "за 7 дней",
  month: "за 30 дней",
  all: "за всё время"
};

const adminStatsPeriods = {
  today: "created_at >= date_trunc('day', NOW())",
  week: "created_at >= NOW() - INTERVAL '7 days'",
  month: "created_at >= NOW() - INTERVAL '30 days'",
  all: "TRUE"
};

const adminBroadcastWizard = new Map();

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

async function findAdminTargetUser(rawUsername) {
  requireDatabase();
  const username = normalizeUsername(rawUsername);
  if (!username) return null;

  const r = await pool.query(
    `SELECT telegram_id, username, first_name, balance::float AS balance,
            total_deposited::float AS total_deposited,
            total_wagered::float AS total_wagered,
            games_played, games_won, wager_remaining::float AS wager_remaining,
            banned, created_at
     FROM users
     WHERE LOWER(username)=$1
     LIMIT 1`,
    [username]
  );
  return r.rows[0] || null;
}

function formatAdminMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatAdminDate(value) {
  try {
    return new Date(value).toLocaleString("ru-RU", {
      timeZone: "Europe/Tallinn",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(value || "");
  }
}

function adminStatsPeriodButtons(userId) {
  return {
    inline_keyboard: [
      [
        { text: "📅 Сегодня", callback_data: `astat:${userId}:today` },
        { text: "7 дней", callback_data: `astat:${userId}:week` }
      ],
      [
        { text: "30 дней", callback_data: `astat:${userId}:month` },
        { text: "♾ Всё время", callback_data: `astat:${userId}:all` }
      ]
    ]
  };
}

async function sendAdminUserStatsChooser(chatId, rawUsername) {
  const user = await findAdminTargetUser(rawUsername);
  if (!user) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: `❌ Пользователь ${rawUsername} не найден в базе.\n\nПроверь username и убедись, что пользователь хотя бы один раз открывал бота / Mini App.`
    });
    return;
  }

  const username = user.username ? `@${user.username}` : "без username";
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `👤 <b>Пользователь найден</b>\n\n` +
      `Имя: <b>${escapeHtmlTelegram(user.first_name)}</b>\n` +
      `Username: <b>${escapeHtmlTelegram(username)}</b>\n` +
      `ID: <code>${escapeHtmlTelegram(user.telegram_id)}</code>\n` +
      `💰 Баланс: <b>${formatAdminMoney(user.balance)} ⭐</b>\n` +
      `💳 Депозит: <b>${formatAdminMoney(user.total_deposited)} ⭐</b>\n\n` +
      `Выбери период статистики:`,
    parse_mode: "HTML",
    reply_markup: adminStatsPeriodButtons(user.telegram_id)
  });
}

async function sendAdminUserStats(chatId, userId, period) {
  requireDatabase();
  const safePeriod = adminStatsPeriods[period] ? period : "all";
  const where = adminStatsPeriods[safePeriod];

  const userResult = await pool.query(
    `SELECT telegram_id, username, first_name, balance::float AS balance,
            total_deposited::float AS total_deposited,
            total_wagered::float AS total_wagered,
            games_played, games_won, wager_remaining::float AS wager_remaining,
            banned, created_at
     FROM users WHERE telegram_id=$1 LIMIT 1`,
    [String(userId)]
  );
  if (!userResult.rowCount) {
    await telegramApi("sendMessage", { chat_id: chatId, text: "❌ Пользователь больше не найден." });
    return;
  }

  const user = userResult.rows[0];

  const positive = await pool.query(
    `SELECT type,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount),0)::float AS amount
     FROM balance_transactions
     WHERE telegram_user_id=$1
       AND amount > 0
       AND ${where}
     GROUP BY type
     ORDER BY amount DESC`,
    [String(userId)]
  );

  const operations = await pool.query(
    `SELECT type, amount::float AS amount, balance_after::float AS balance_after,
            description, admin_id, created_at
     FROM balance_transactions
     WHERE telegram_user_id=$1 AND ${where}
     ORDER BY created_at DESC
     LIMIT 50`,
    [String(userId)]
  );

  const withdrawals = await pool.query(
    `SELECT currency, amount::float AS amount, status, created_at, wallet_address
     FROM withdrawal_requests
     WHERE telegram_user_id=$1 AND ${where}
     ORDER BY created_at DESC
     LIMIT 50`,
    [String(userId)]
  );

  const deposits = positive.rows.filter(r =>
    ["stars_topup", "balance_topup", "ton_topup"].includes(String(r.type))
  );
  const received = positive.rows.filter(r =>
    !["stars_topup", "balance_topup", "ton_topup"].includes(String(r.type))
  );

  const sumRows = rows => rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const topupTotal = sumRows(deposits);
  const receivedTotal = sumRows(received);
  const withdrawalTotal = sumRows(withdrawals.rows.filter(r => String(r.status) !== "rejected" && String(r.status) !== "declined"));

  const typeLabels = {
    stars_topup: "💳 Telegram Stars",
    balance_topup: "💳 Пополнение",
    ton_topup: "💎 TON / GRAM",
    pvp_win: "🎡 Победа PVP",
    raffle_prize: "🎁 Выигрыш розыгрыша",
    raffle_ticket_income: "🎟 Доход с билетов",
    referral_claim: "👥 Реферальная награда",
    freebet: "🎁 Фрибет",
    promo_bonus: "🏷 Промокод",
    admin_credit: "🛠 Начисление админом",
    upgrade_win: "⬆️ Выигрыш Upgrade",
    bounce_win: "↩️ Выигрыш Отскок",
    plinko_win: "🔻 Выигрыш Дроп",
    penalty_win: "🥅 Выигрыш Пенальти"
  };

  const operationLabels = {
    pvp_bet: "🎯 Ставка PVP",
    upgrade_bet: "⬆️ Ставка Upgrade",
    raffle_ticket: "🎟 Билет розыгрыша",
    task_purchase: "📋 Покупка задания",
    raffle_create: "🎁 Создание розыгрыша",
    raffle_prize: "🏆 Приз розыгрыша",
    pvp_win: "🎡 Победа PVP",
    admin_credit: "🛠 Начисление админом",
    admin_debit: "🛠 Списание админом",
    freebet: "🎁 Фрибет",
    promo_bonus: "🏷 Промокод",
    referral_claim: "👥 Реферальная награда",
    stars_topup: "💳 Пополнение Stars",
    ton_topup: "💎 Пополнение TON / GRAM",
    raffle_ticket_income: "🎟 Доход с билетов",
    raffle_refund: "↩️ Возврат розыгрыша",
    upgrade_win: "⬆️ Выигрыш Upgrade",
    bounce_bet: "↩️ Ставка Отскок",
    bounce_win: "↩️ Выигрыш Отскок",
    plinko_bet: "🔻 Ставка Дроп",
    plinko_win: "🔻 Выигрыш Дроп",
    penalty_bet: "🥅 Ставка Пенальти",
    penalty_win: "🥅 Выигрыш Пенальти"
  };

  const sourceLines = [
    ...deposits.map(r => `• ${typeLabels[r.type] || r.type}: <b>+${formatAdminMoney(r.amount)} ⭐</b> (${r.count})`),
    ...received.map(r => `• ${typeLabels[r.type] || r.type}: <b>+${formatAdminMoney(r.amount)} ⭐</b> (${r.count})`)
  ];

  const opLines = operations.rows.slice(0, 25).map(r => {
    const label = operationLabels[r.type] || r.type;
    const sign = Number(r.amount) > 0 ? "+" : "";
    return `• ${formatAdminDate(r.created_at)} — ${label}: <b>${sign}${formatAdminMoney(r.amount)} ⭐</b>${r.description ? `\n  ${escapeHtmlTelegram(r.description)}` : ""}`;
  });

  const withdrawalLines = withdrawals.rows.slice(0, 15).map(r =>
    `• ${formatAdminDate(r.created_at)} — ${String(r.currency || "STAR")}: <b>-${formatAdminMoney(r.amount)} ⭐</b> — ${escapeHtmlTelegram(r.status || "unknown")}`
  );

  const username = user.username ? `@${user.username}` : "без username";
  const winrate = Number(user.games_played) > 0
    ? ((Number(user.games_won) / Number(user.games_played)) * 100).toFixed(1)
    : "0.0";

  let text =
    `📊 <b>Статистика пользователя</b>\n` +
    `Период: <b>${adminStatsPeriodLabels[safePeriod]}</b>\n\n` +
    `👤 ${escapeHtmlTelegram(user.first_name)} ${escapeHtmlTelegram(username)}\n` +
    `🆔 <code>${escapeHtmlTelegram(user.telegram_id)}</code>\n` +
    `💰 Баланс сейчас: <b>${formatAdminMoney(user.balance)} ⭐</b>\n` +
    `💳 Всего депозитов: <b>${formatAdminMoney(user.total_deposited)} ⭐</b>\n` +
    `🎯 Всего поставлено: <b>${formatAdminMoney(user.total_wagered)} ⭐</b>\n` +
    `🎡 Игр: <b>${Number(user.games_played || 0)}</b> · побед: <b>${Number(user.games_won || 0)}</b> · winrate: <b>${winrate}%</b>\n` +
    `🎯 Остаток вагера: <b>${formatAdminMoney(user.wager_remaining)} ⭐</b>\n\n` +
    `💵 <b>Откуда получил деньги за период</b>\n` +
    (sourceLines.length ? sourceLines.join("\n") : "• Нет начислений") +
    `\n\n📥 Всего пополнено за период: <b>+${formatAdminMoney(topupTotal)} ⭐</b>` +
    `\n🎁 Других начислений: <b>+${formatAdminMoney(receivedTotal)} ⭐</b>` +
    `\n\n📤 <b>Выводы</b>\n` +
    (withdrawalLines.length ? withdrawalLines.join("\n") : "• Выводов нет") +
    `\n💸 Всего заявок на вывод: <b>${formatAdminMoney(withdrawalTotal)} ⭐</b>` +
    `\n\n🧾 <b>Операции</b>\n` +
    (opLines.length ? opLines.join("\n") : "• Операций нет");

  if (text.length > 3800) text = text.slice(0, 3750) + "\n\n… список сокращён до последних операций.";

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: adminStatsPeriodButtons(user.telegram_id)
  });
}

async function handleAdminStatsCallback(callback) {
  const data = String(callback?.data || "");
  const match = data.match(/^astat:(\d+):(today|week|month|all)$/);
  if (!match) return false;

  const adminId = String(callback?.from?.id || "");
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, "Нет доступа.");
    return true;
  }

  await answerCallbackQuery(callback.id, "Загружаю статистику…");
  try {
    await sendAdminUserStats(callback.message?.chat?.id || adminId, match[1], match[2]);
  } catch (e) {
    await telegramApi("sendMessage", { chat_id: adminId, text: `❌ Ошибка статистики: ${e.message}` });
  }
  return true;
}

async function sendAdminBroadcastAudienceChooser(chatId) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "📣 <b>Рассылка</b>\n\nКому отправить сообщение?",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "👥 Всем пользователям", callback_data: "abcast:all" }],
        [{ text: "💳 Депозит от суммы", callback_data: "abcast:deposit" }],
        [{ text: "❌ Отмена", callback_data: "abcast:cancel" }]
      ]
    }
  });
}

async function startAdminBroadcast(adminId) {
  if (!isAdmin(adminId)) return;
  adminBroadcastWizard.set(String(adminId), { step: "audience" });
  await sendAdminBroadcastAudienceChooser(adminId);
}

async function handleAdminBroadcastCallback(callback) {
  const data = String(callback?.data || "");
  if (!data.startsWith("abcast:")) return false;

  const adminId = String(callback?.from?.id || "");
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, "Нет доступа.");
    return true;
  }

  if (data === "abcast:cancel") {
    adminBroadcastWizard.delete(adminId);
    await answerCallbackQuery(callback.id, "Рассылка отменена.");
    await telegramApi("sendMessage", { chat_id: adminId, text: "❌ Рассылка отменена." });
    return true;
  }

  if (data === "abcast:all") {
    adminBroadcastWizard.set(adminId, { step: "message", minDeposit: 0 });
    await answerCallbackQuery(callback.id, "Выбраны все пользователи.");
    await telegramApi("sendMessage", {
      chat_id: adminId,
      text: "👥 Выбраны все пользователи.\n\nТеперь отправь мне <b>само сообщение для рассылки</b>. Можно отправить обычный текст, фото, видео или другое поддерживаемое Telegram-сообщение.\n\nДля отмены: /cancel",
      parse_mode: "HTML"
    });
    return true;
  }

  if (data === "abcast:deposit") {
    adminBroadcastWizard.set(adminId, { step: "minDeposit" });
    await answerCallbackQuery(callback.id, "Укажи минимальный депозит.");
    await telegramApi("sendMessage", {
      chat_id: adminId,
      text: "💳 Введи минимальный общий депозит.\n\nНапример: <code>100</code> — сообщение получат пользователи с депозитом от 100 ⭐.\n\nДля отмены: /cancel",
      parse_mode: "HTML"
    });
    return true;
  }

  return false;
}

async function performAdminBroadcast(adminId, sourceMessage, minDeposit = 0) {
  requireDatabase();

  const excluded = getAdminIds();
  const query = minDeposit > 0
    ? `SELECT telegram_id FROM users WHERE total_deposited >= $1 AND telegram_id <> ALL($2::text[]) ORDER BY telegram_id`
    : `SELECT telegram_id FROM users WHERE telegram_id <> ALL($1::text[]) ORDER BY telegram_id`;

  const params = minDeposit > 0 ? [Number(minDeposit), excluded] : [excluded];
  const users = (await pool.query(query, params)).rows;

  let sent = 0;
  let failed = 0;

  for (const row of users) {
    try {
      await telegramApi("copyMessage", {
        chat_id: String(row.telegram_id),
        from_chat_id: String(sourceMessage.chat.id),
        message_id: Number(sourceMessage.message_id)
      });
      sent++;
    } catch (e) {
      failed++;
    }
    // Telegram allows bursts, but a small delay keeps a large broadcast away from rate limits.
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  await telegramApi("sendMessage", {
    chat_id: adminId,
    text:
      `📣 <b>Рассылка завершена</b>\n\n` +
      `👥 Получателей: <b>${users.length}</b>\n` +
      `✅ Доставлено: <b>${sent}</b>\n` +
      `❌ Не доставлено: <b>${failed}</b>` +
      (minDeposit > 0 ? `\n💳 Фильтр: депозит от <b>${formatAdminMoney(minDeposit)} ⭐</b>` : ""),
    parse_mode: "HTML"
  });
}

async function handleAdminBroadcastMessage(message) {
  const adminId = String(message?.from?.id || "");
  if (!adminId || !isAdmin(adminId) || String(message?.chat?.type) !== "private") return false;

  const draft = adminBroadcastWizard.get(adminId);
  if (!draft) return false;

  const text = String(message.text || "").trim();
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    adminBroadcastWizard.delete(adminId);
    await telegramApi("sendMessage", { chat_id: adminId, text: "❌ Рассылка отменена." });
    return true;
  }

  if (draft.step === "minDeposit") {
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) {
      await telegramApi("sendMessage", { chat_id: adminId, text: "❌ Введи корректную сумму, например: 100." });
      return true;
    }
    draft.minDeposit = value;
    draft.step = "message";
    await telegramApi("sendMessage", {
      chat_id: adminId,
      text: `✅ Фильтр установлен: депозит от <b>${formatAdminMoney(value)} ⭐</b>.\n\nТеперь отправь сообщение для рассылки.`,
      parse_mode: "HTML"
    });
    return true;
  }

  if (draft.step === "message") {
    try {
      await telegramApi("sendMessage", { chat_id: adminId, text: "⏳ Начинаю рассылку…" });
      adminBroadcastWizard.delete(adminId);
      await performAdminBroadcast(adminId, message, Number(draft.minDeposit || 0));
    } catch (e) {
      adminBroadcastWizard.delete(adminId);
      await telegramApi("sendMessage", { chat_id: adminId, text: `❌ Ошибка рассылки: ${e.message}` });
    }
    return true;
  }

  return false;
}

async function handleAdminPrivateText(message) {
  const adminId = String(message?.from?.id || "");
  if (!adminId || !isAdmin(adminId) || String(message?.chat?.type) !== "private") return false;

  // A broadcast wizard has priority over username/stat commands.
  if (await handleAdminBroadcastMessage(message)) return true;

  const text = String(message.text || "").trim();
  if (!text || text.startsWith("/")) return false;

  // Sending @username directly to the bot opens the period selector.
  if (/^@[A-Za-z0-9_]{3,64}$/.test(text)) {
    await sendAdminUserStatsChooser(message.chat.id, text);
    return true;
  }

  return false;
}

async function handleFreebetCommand(message) {
  if (!message?.chat?.id) return;
  const adminId = String(message.from?.id || "");
  if (!isAdmin(adminId)) {
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Команда доступна только администраторам." });
    return;
  }
  if (String(message.chat.type) !== "private") {
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Создание фрибета доступно в личных сообщениях с ботом." });
    return;
  }
  try {
    await upsertUser({
      id: adminId,
      username: String(message.from?.username || ""),
      first_name: safeName(message.from?.first_name || "Администратор"),
      photo_url: ""
    });
  } catch (e) {
    console.error("Freebet admin sync error:", e.message);
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Не удалось подготовить профиль администратора. Проверь DATABASE_URL." });
    return;
  }
  freebetWizard.set(adminId, { step: "activations" });
  await telegramApi("sendMessage", { chat_id: message.chat.id, text: "🎁 Создание фрибета\n\nСколько активаций?\nНапиши целое число, например: 100\n\nДля отмены: /cancel" });
}

async function handleFreebetWizardMessage(message) {
  const adminId = String(message?.from?.id || "");
  if (!adminId || !isAdmin(adminId) || String(message?.chat?.type) !== "private") return false;
  const draft = freebetWizard.get(adminId);
  if (!draft) return false;

  const text = String(message.text || "").trim();
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    freebetWizard.delete(adminId);
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Создание фрибета отменено." });
    return true;
  }
  if (!text || text.startsWith("/")) return false;

  if (draft.step === "activations") {
    const activations = Number(text);
    if (!Number.isInteger(activations) || activations <= 0) {
      await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Нужно целое число активаций больше 0." });
      return true;
    }
    draft.activations = activations;
    draft.step = "bonus";
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "✅ Активаций: " + activations + "\n\nСколько Stars даёт фрибет?" });
    return true;
  }

  if (draft.step === "bonus") {
    const bonus = Number(text);
    if (!Number.isInteger(bonus) || bonus <= 0) {
      await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Сумма Stars должна быть целым числом больше 0." });
      return true;
    }
    draft.bonus = bonus;
    draft.step = "wager";
    await telegramApi("sendMessage", { chat_id: message.chat.id, text: "⭐ Stars: " + bonus + "\n\nКакой wager?\nНапример: 5 — бонус нужно отыграть x5.\n0 — без вагера." });
    return true;
  }

  if (draft.step === "wager") {
    const wager = Number(String(text).replace(",", "."));
    if (!Number.isFinite(wager) || wager < 0) {
      await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Вагер должен быть числом от 0 и выше." });
      return true;
    }
    try {
      const fb = await createFreebet(adminId, draft.activations, draft.bonus, wager);
      const bot = await getBotInfoCached();
      const link = freebetLinkForBot(bot.username, fb.id);
      freebetWizard.delete(adminId);
      await telegramApi("sendMessage", {
        chat_id: message.chat.id,
        text: `🎁 <b>Фрибет создан</b>\n\n⭐ Выдача: <b>${Number(fb.bonus).toFixed(0)} Stars</b>\n👥 Активаций: <b>${Number(fb.max_uses)}</b>\n🎯 Вагер: <b>x${Number(fb.wager)}</b>\n\nСсылка для раздачи:`,
        parse_mode: "HTML",
        reply_markup: link ? { inline_keyboard: [[{ text: "🎁 ПОЛУЧИТЬ ФРИБЕТ", url: link }]] } : undefined
      });
      if (!link) {
        await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Не удалось собрать ссылку. Проверь TELEGRAM_BOT_USERNAME / настройки Mini App на Render." });
      }
    } catch (e) {
      await telegramApi("sendMessage", { chat_id: message.chat.id, text: `Ошибка: ${e.message}` });
    }
    return true;
  }

  return false;
}

async function handleFreebetCallback(callback) {
  if (String(callback?.data || "") !== "freebet:cancel") return false;
  const adminId = String(callback?.from?.id || "");
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, "Нет доступа.");
    return true;
  }
  freebetWizard.delete(adminId);
  await answerCallbackQuery(callback.id, "Создание фрибета отменено.");
  if (callback.message?.chat?.id) {
    await telegramApi("sendMessage", { chat_id: callback.message.chat.id, text: "Создание фрибета отменено." }).catch(() => {});
  }
  return true;
}

function telegramApiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramApi(method, body) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не настроен.");
  }
  const response = await fetch(telegramApiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

function supportTelegramApiUrl(method) {
  return `https://api.telegram.org/bot${process.env.SUPPORT_BOT_TOKEN}/${method}`;
}

async function supportTelegramApi(method, body) {
  if (!process.env.SUPPORT_BOT_TOKEN) {
    throw new Error("SUPPORT_BOT_TOKEN не настроен.");
  }
  const response = await fetch(supportTelegramApiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Support Telegram ${method} failed`);
  return data.result;
}

async function getSupportBotInfoCached() {
  if (supportBotInfoCache && Date.now() - supportBotInfoCacheAt < 60 * 60 * 1000) return supportBotInfoCache;
  supportBotInfoCache = await supportTelegramApi("getMe", {});
  supportBotInfoCacheAt = Date.now();
  return supportBotInfoCache;
}

function getSupportAdminIds() {
  const raw = String(process.env.SUPPORT_ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_IDS || "");
  return raw.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean);
}

function buildSupportChatUrl() {
  const explicit = String(process.env.SUPPORT_BOT_URL || "").trim();
  if (explicit) return explicit;
  const username = String(supportBotInfoCache?.username || process.env.SUPPORT_BOT_USERNAME || "").replace(/^@/, "");
  return username ? `https://t.me/${username}` : "";
}

async function ensureSupportBotUser(user) {
  if (!pool || !user?.id) return;
  try {
    await upsertUser({
      id: String(user.id),
      username: String(user.username || ""),
      first_name: safeName(user.first_name || "Игрок"),
      photo_url: ""
    }, "");
  } catch (e) {
    console.error("Support user sync error:", e.message);
  }
}

async function sendSupportRequestToAdmins(message) {
  const admins = getSupportAdminIds();
  if (!admins.length) return;
  const from = message?.from || {};
  const userId = String(from.id || "");
  const username = from.username ? `@${from.username}` : "без username";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Пользователь";

  let ticketId = supportOpenTickets.get(userId);
  const isNewTicket = !ticketId;
  if (!ticketId) {
    ticketId = crypto.randomUUID();
    if (pool && userId) {
      try {
        await pool.query(
          `INSERT INTO support_tickets (id, telegram_user_id, status) VALUES ($1,$2,'open')`,
          [ticketId, userId]
        );
      } catch (e) {
        console.error("Support ticket insert error:", e.message);
      }
    }
    supportOpenTickets.set(userId, ticketId);
  }

  const header = `${isNewTicket ? "🆘 <b>Новая заявка в поддержку</b>" : "💬 <b>Новое сообщение по заявке</b>"}\n\n` +
    `🎫 <code>${escapeHtmlTelegram(ticketId.slice(0, 8))}</code>\n` +
    `👤 ${escapeHtmlTelegram(name)}\n` +
    `🔗 ${escapeHtmlTelegram(username)}\n` +
    `🆔 <code>${escapeHtmlTelegram(userId)}</code>`;
  await Promise.all(admins.map(async adminId => {
    try {
      const sentHeader = await supportTelegramApi("sendMessage", {
        chat_id: adminId,
        text: header,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "↩️ Ответить", callback_data: `support:reply:${userId}` },
            { text: "✅ Закрыть", callback_data: `support:close:${userId}` }
          ]]
        }
      });
      if (message?.chat?.id && message?.message_id) {
        await supportTelegramApi("copyMessage", {
          chat_id: adminId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
          reply_to_message_id: sentHeader.message_id
        });
      }
    } catch (e) {
      console.error(`Support forward error (${adminId}):`, e.message);
    }
  }));
  return { ticketId, isNewTicket };
}

function escapeHtmlTelegram(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

async function handleSupportBotCallback(callback) {
  const data = String(callback?.data || "");
  const adminId = String(callback?.from?.id || "");
  if (data === "support:create") {
    supportTicketWizard.set(adminId, true);
    await supportTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Опишите проблему." }).catch(() => {});
    await supportTelegramApi("sendMessage", { chat_id: callback.message.chat.id, text: "✍️ Напишите одним или несколькими сообщениями, что произошло. После отправки заявка уйдёт оператору." });
    return true;
  }
  const replyMatch = data.match(/^support:reply:(\d+)$/);
  if (replyMatch) {
    if (!getSupportAdminIds().includes(adminId)) {
      await supportTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа." }).catch(() => {});
      return true;
    }
    const userId = replyMatch[1];
    supportReplyWizard.set(adminId, userId);
    await supportTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Режим ответа включён." }).catch(() => {});
    await supportTelegramApi("sendMessage", { chat_id: adminId, text: `✍️ Ответ пользователю ${userId}. Можно отправлять несколько сообщений. Для выхода: /cancel` });
    return true;
  }
  const closeMatch = data.match(/^support:close:(\d+)$/);
  if (closeMatch) {
    if (!getSupportAdminIds().includes(adminId)) {
      await supportTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа." }).catch(() => {});
      return true;
    }
    const userId = closeMatch[1];
    supportReplyWizard.delete(adminId);
    supportTicketWizard.delete(userId);
    const ticketId = supportOpenTickets.get(userId);
    supportOpenTickets.delete(userId);
    if (ticketId && pool) {
      await pool.query(`UPDATE support_tickets SET status='closed', closed_at=NOW(), closed_by=$2 WHERE id=$1`, [ticketId, adminId]).catch(() => {});
    }
    await supportTelegramApi("answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка закрыта." }).catch(() => {});
    await supportTelegramApi("sendMessage", { chat_id: userId, text: "✅ Заявка закрыта оператором. Чтобы открыть новую, нажмите кнопку «Создать заявку»." }).catch(() => {});
    return true;
  }
  return false;
}

async function handleSupportBotMessage(message) {
  if (!message?.chat?.id) return false;
  const userId = String(message.from?.id || "");
  if (!userId) return false;
  const text = String(message.text || "").trim();
  const admins = getSupportAdminIds();

  // Operators also need a visible response to /start so they can verify the
  // support bot is alive. Their other messages remain in operator/reply mode.
  if (/^\/start(?:@\w+)?$/i.test(text) && admins.includes(userId)) {
    supportReplyWizard.delete(userId);
    await supportTelegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "🛠 <b>Панель оператора поддержки</b>\n\nКогда пользователь создаст заявку, сюда придёт сообщение с кнопками «Ответить» и «Закрыть».",
      parse_mode: "HTML"
    });
    return true;
  }
  if (/^\/help(?:@\w+)?$/i.test(text) && admins.includes(userId)) {
    await supportTelegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "↩️ Нажмите «Ответить» в сообщении заявки. Можно отправлять несколько сообщений. Для выхода используйте /cancel."
    });
    return true;
  }

  if (admins.includes(userId)) {
    if (/^\/cancel(?:@\w+)?$/i.test(text)) {
      supportReplyWizard.delete(userId);
      await supportTelegramApi("sendMessage", { chat_id: message.chat.id, text: "✅ Режим ответа выключен." });
      return true;
    }
    const target = supportReplyWizard.get(userId);
    if (target && message.chat.type === "private" && !text.startsWith("/")) {
      await supportTelegramApi("copyMessage", {
        chat_id: target,
        from_chat_id: message.chat.id,
        message_id: message.message_id
      });
      return true;
    }
    return false;
  }

  if (message.chat.type !== "private") return false;
  await ensureSupportBotUser(message.from);
  if (/^\/start(?:@\w+)?$/i.test(text)) {
    supportTicketWizard.delete(userId);
    await supportTelegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "👋 <b>Поддержка RING</b>\n\nЗдесь можно создать заявку и связаться с оператором.",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🆘 СОЗДАТЬ ЗАЯВКУ", callback_data: "support:create" }]] }
    });
    return true;
  }
  if (/^\/help(?:@\w+)?$/i.test(text)) {
    await supportTelegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "💬 Нажмите «Создать заявку», затем отправьте описание проблемы.",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🆘 СОЗДАТЬ ЗАЯВКУ", callback_data: "support:create" }]] }
    });
    return true;
  }

  if (supportOpenTickets.has(userId) || supportTicketWizard.has(userId)) {
    if (!supportOpenTickets.has(userId)) supportTicketWizard.delete(userId);
    await sendSupportRequestToAdmins(message);
    await supportTelegramApi("sendMessage", { chat_id: message.chat.id, text: "✅ Сообщение отправлено оператору. Можно продолжать писать сюда, пока заявка открыта." });
    return true;
  }

  await supportTelegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "Сначала создайте заявку в поддержку.",
    reply_markup: { inline_keyboard: [[{ text: "🆘 СОЗДАТЬ ЗАЯВКУ", callback_data: "support:create" }]] }
  });
  return true;
}

async function configureSupportBot() {
  if (!process.env.SUPPORT_BOT_TOKEN) {
    console.warn("Support bot is not configured: SUPPORT_BOT_TOKEN is missing.");
    return;
  }
  try {
    const info = await getSupportBotInfoCached();
    console.log(`Support bot connected: @${String(info?.username || "UNKNOWN")}`);
    const appUrl = buildMiniAppOpenUrl();
    if (!appUrl) return;
    const secret = activeWebhookSecret();
    await supportTelegramApi("setWebhook", {
      url: `${appUrl}/api/support/webhook`,
      ...(secret ? { secret_token: secret } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    await supportTelegramApi("deleteMyCommands", {});
    await supportTelegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Начать" },
        { command: "help", description: "Помощь" }
      ]
    });
    const hook = await supportTelegramApi("getWebhookInfo", {});
    console.log(`Support webhook configured: ${hook.url || appUrl + '/api/support/webhook'}${hook.last_error_message ? ` | last error: ${hook.last_error_message}` : ''}`);
  } catch (e) {
    console.error("Support Telegram setup error:", e.message);
  }
}

// Sends a plain-text DM to every configured admin. Failures for one admin
// (blocked bot, never started a chat with it, etc.) never stop the others.
async function notifyAdmins(text) {
  const ids = getAdminIds();
  if (!ids.length || !process.env.TELEGRAM_BOT_TOKEN) return;
  await Promise.all(ids.map(id =>
    telegramApi("sendMessage", { chat_id: id, text }).catch(e =>
      console.error(`Admin notify error (${id}):`, e.message)
    )
  ));
}

function withdrawalButtons(requestId) {
  return {
    inline_keyboard: [[
      { text: "✅ Принять", callback_data: `withdraw:approve:${requestId}` },
      { text: "❌ Отклонить", callback_data: `withdraw:decline:${requestId}` }
    ]]
  };
}

async function notifyWithdrawalAdmins(text, requestId) {
  const ids = getAdminIds();
  if (!ids.length || !process.env.TELEGRAM_BOT_TOKEN) return;
  await Promise.all(ids.map(id =>
    telegramApi("sendMessage", { chat_id: id, text, reply_markup: withdrawalButtons(requestId) }).catch(e =>
      console.error(`Withdrawal notify error (${id}):`, e.message)
    )
  ));
}

async function answerCallbackQuery(id, text) {
  if (!id) return;
  await telegramApi("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(e =>
    console.error("Telegram callback answer error:", e.message)
  );
}

async function completeWithdrawal(requestId, adminId) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE withdrawal_requests
       SET status='approved', reviewed_at=NOW(), reviewed_by=$2
       WHERE id=$1 AND status='pending'
       RETURNING id, telegram_user_id, amount::float AS amount, currency`,
      [requestId, String(adminId)]
    );
    if (!result.rowCount) throw new Error("Заявка уже обработана другим администратором.");
    await client.query("COMMIT");
    return result.rows[0];
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function requestWithdrawalDeclineReason(requestId, adminId) {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT id FROM withdrawal_requests
       WHERE status='decline_reason_pending' AND reviewed_by=$1 FOR UPDATE`,
      [String(adminId)]
    );
    if (pending.rowCount) throw new Error("Сначала укажите причину для предыдущей заявки.");
    const result = await client.query(
      `UPDATE withdrawal_requests SET status='decline_reason_pending', reviewed_by=$2
       WHERE id=$1 AND status='pending'
       RETURNING id`,
      [requestId, String(adminId)]
    );
    if (!result.rowCount) throw new Error("Заявка уже обработана другим администратором.");
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function rejectWithdrawal(requestId, adminId, reason = "") {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(
      `SELECT id, telegram_user_id, amount::float AS amount, currency
       FROM withdrawal_requests
       WHERE id=$1 AND status='decline_reason_pending' AND reviewed_by=$2 FOR UPDATE`,
      [Number(requestId), String(adminId)]
    );
    if (!request.rowCount) throw new Error("Заявка уже обработана или ожидает другого администратора.");
    const withdrawal = request.rows[0];
    const cleanReason = String(reason || "").trim().slice(0, 700);
    const balance = await creditBalance(withdrawal.telegram_user_id, withdrawal.amount, client, {
      type: "withdraw_rejected",
      description: `Возврат по отклонённой заявке на вывод №${withdrawal.id}`,
      adminId
    });
    await client.query(
      `UPDATE withdrawal_requests
       SET status='rejected', reviewed_at=NOW(), reviewed_by=$2, decline_reason=$3
       WHERE id=$1`,
      [Number(requestId), String(adminId), cleanReason]
    );
    await client.query("COMMIT");
    return { ...withdrawal, balance, reason: cleanReason };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function notifyWithdrawalCompleted(withdrawal) {
  await telegramApi("sendMessage", {
    chat_id: withdrawal.telegram_user_id,
    text: `✅ Ваша заявка на вывод №${withdrawal.id} выполнена.\nСумма: ${Number(withdrawal.amount).toFixed(2)} ⭐.`
  }).catch(e => console.error("Withdrawal completion notify error:", e.message));
}

async function notifyWithdrawalRejected(withdrawal) {
  const reason = withdrawal.reason ? `\nПричина: ${withdrawal.reason}` : "";
  await telegramApi("sendMessage", {
    chat_id: withdrawal.telegram_user_id,
    text: `❌ Ваша заявка на вывод №${withdrawal.id} отклонена.${reason}\nСредства возвращены на баланс.`
  }).catch(e => console.error("Withdrawal rejection notify error:", e.message));
  io.to(`user:${withdrawal.telegram_user_id}`).emit("balance_updated", { balance: withdrawal.balance });
}


// ---------------- RAFFLES ----------------
let botInfoCache = null;
let botInfoCacheAt = 0;
let supportBotInfoCache = null;
let supportBotInfoCacheAt = 0;
const supportReplyWizard = new Map();
const supportTicketWizard = new Map();
const supportOpenTickets = new Map();

async function getBotInfoCached() {
  if (botInfoCache && Date.now() - botInfoCacheAt < 60 * 60 * 1000) return botInfoCache;
  botInfoCache = await telegramApi("getMe", {});
  botInfoCacheAt = Date.now();
  return botInfoCache;
}

function normalizeChannelRef(value) {
  const raw = String(value || '').trim();
  const username = raw.replace(/^https?:\/\/(?:t\.me\/|telegram\.me\/)?/i, '').replace(/^@/, '').split(/[/?#\s]/)[0];
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('Укажи публичный канал в формате @channel.');
  return { username, chatId: '@' + username };
}

function parseRaffleStartParam(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^rg_([0-9a-f-]{36})_(\d+)$/i);
  return m ? { raffleId: m[1], referrerId: m[2] } : null;
}

async function verifyRaffleChannel(channelRef, creatorId) {
  const channel = normalizeChannelRef(channelRef);
  const chat = await telegramApi('getChat', { chat_id: channel.chatId });
  if (chat.type !== 'channel') throw new Error('Нужен именно Telegram-канал, а не группа.');

  const creatorMember = await telegramApi('getChatMember', { chat_id: chat.id, user_id: Number(creatorId) });
  const creatorOk = ['creator', 'administrator'].includes(String(creatorMember.status));
  if (!creatorOk) throw new Error('Создатель розыгрыша должен быть администратором этого канала.');

  const bot = await getBotInfoCached();
  const botMember = await telegramApi('getChatMember', { chat_id: chat.id, user_id: bot.id });
  const botOk = ['creator', 'administrator'].includes(String(botMember.status));
  if (!botOk || (botMember.can_post_messages === false)) {
    throw new Error('Сначала добавь бота в администраторы канала с правом публикации сообщений.');
  }

  const username = String(chat.username || channel.username);
  if (!username) throw new Error('Для розыгрыша нужен публичный канал с @username, чтобы участники могли его открыть и бустить.');

  return { chat, username };
}

function rafflePublicRow(row) {
  return {
    id: String(row.id),
    creatorId: String(row.creator_id),
    type: row.raffle_type,
    ticketPrice: Number(row.ticket_price || 0),
    prizePool: Number(row.prize_pool || 0),
    prizeTitle: row.prize_title || 'Stars',
    winnersCount: Number(row.winners_count),
    endsAt: new Date(row.ends_at).getTime(),
    channelId: String(row.channel_id),
    channelUsername: row.channel_username,
    channelTitle: row.channel_title || row.channel_username,
    postMessageId: row.post_message_id ? Number(row.post_message_id) : null,
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null
  };
}

function botChannelLink(username) {
  return `https://t.me/${String(username || '').replace(/^@/, '')}`;
}
function botBoostLink(username) {
  return `https://t.me/boost/${String(username || '').replace(/^@/, '')}`;
}

function normalizeBotUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//i, '')
    .split(/[/?#\s]/)[0];
}

function buildTelegramMiniAppLink(botUsername, startParam = '') {
  const username = normalizeBotUsername(botUsername);
  if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) return '';

  const start = String(startParam || '').trim();
  const shortName = String(process.env.TELEGRAM_MINI_APP_SHORT_NAME || '')
    .trim()
    .replace(/^\//, '')
    .split(/[?#\s]/)[0];

  // A named Direct Mini App link works from channel posts and does not require
  // sending the user through the bot chat first. Configure the short name in BotFather.
  if (shortName) {
    return `https://t.me/${username}/${encodeURIComponent(shortName)}${start ? `?startapp=${encodeURIComponent(start)}` : ''}`;
  }

  // Otherwise use the bot's Main Mini App deep link. This also opens the app
  // directly, but only when a Main Mini App is configured for this bot in BotFather.
  return `https://t.me/${username}${start ? `?startapp=${encodeURIComponent(start)}` : '?startapp'}`;
}

async function getRaffleById(raffleId) {
  const r = await pool.query(
    `SELECT r.*, u.first_name AS creator_first_name, u.username AS creator_username
     FROM raffles r JOIN users u ON u.telegram_id=r.creator_id WHERE r.id=$1`,
    [String(raffleId)]
  );
  return r.rows[0] || null;
}

async function isRaffleChannelSubscribed(raffle, userId) {
  try {
    const member = await telegramApi('getChatMember', {
      chat_id: raffle.channel_id,
      user_id: Number(userId)
    });
    const status = String(member?.status || '').toLowerCase();
    if (['creator', 'administrator', 'member'].includes(status)) return true;
    if (status === 'restricted') return member?.is_member === true;
    return false;
  } catch (e) {
    // The bot must be an administrator to reliably check arbitrary users.
    console.error('Raffle subscription check error:', e.message);
    return false;
  }
}

async function getRaffleDetails(raffleId, userId = null) {
  const row = await getRaffleById(raffleId);
  if (!row) throw new Error('Розыгрыш не найден.');
  const entries = await pool.query(
    `SELECT e.telegram_user_id, e.tickets, e.paid_amount, u.first_name, u.username
     FROM raffle_entries e JOIN users u ON u.telegram_id=e.telegram_user_id
     WHERE e.raffle_id=$1 ORDER BY e.tickets DESC, e.joined_at ASC`,
    [String(raffleId)]
  );
  const winners = await pool.query(
    `SELECT w.place, w.telegram_user_id, w.payout, u.first_name, u.username
     FROM raffle_winners w JOIN users u ON u.telegram_id=w.telegram_user_id
     WHERE w.raffle_id=$1 ORDER BY w.place`,
    [String(raffleId)]
  );
  let mine = null;
  let boostCount = 0;
  let referralLink = '';
  let subscribed = false;
  if (userId) {
    const me = entries.rows.find(e => String(e.telegram_user_id) === String(userId));
    mine = me ? { tickets: Number(me.tickets), paidAmount: Number(me.paid_amount) } : null;
    subscribed = await isRaffleChannelSubscribed(row, userId);
    const bc = await pool.query(`SELECT boost_count FROM raffle_boost_claims WHERE raffle_id=$1 AND telegram_user_id=$2`, [String(raffleId), String(userId)]);
    boostCount = bc.rowCount ? Number(bc.rows[0].boost_count) : 0;
    const bot = await getBotInfoCached().catch(() => null);
    if (bot?.username) referralLink = buildTelegramMiniAppLink(bot.username, `rg_${raffleId}_${userId}`);
  }
  return {
    raffle: rafflePublicRow(row),
    creator: { id: String(row.creator_id), name: row.creator_username ? '@' + row.creator_username : row.creator_first_name },
    entries: entries.rows.map(e => ({ id: String(e.telegram_user_id), name: e.username ? '@' + e.username : e.first_name, tickets: Number(e.tickets), paidAmount: Number(e.paid_amount) })),
    winners: winners.rows.map(w => ({ place: Number(w.place), id: String(w.telegram_user_id), name: w.username ? '@' + w.username : w.first_name, payout: Number(w.payout) })),
    mine,
    boostCount,
    boostUrl: botBoostLink(row.channel_username),
    channelUrl: botChannelLink(row.channel_username),
    subscriptionRequired: true,
    subscribed,
    referralLink
  };
}

function randomWeightedPick(items) {
  const total = items.reduce((s, x) => s + Number(x.tickets || 0), 0);
  if (!total) return null;
  const max = 1_000_000_000;
  const r = Number(BigInt('0x' + crypto.randomBytes(8).toString('hex')) % BigInt(max)) / max;
  let cumulative = 0;
  for (const item of items) {
    cumulative += Number(item.tickets || 0) / total;
    if (r < cumulative) return item;
  }
  return items[items.length - 1];
}

async function finishRaffle(row) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT * FROM raffles WHERE id=$1 FOR UPDATE`, [row.id]);
    if (!current.rowCount || current.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return false;
    }
    const raffle = current.rows[0];
    await client.query(`UPDATE raffles SET status='settling' WHERE id=$1`, [raffle.id]);
    const entries = await client.query(`SELECT telegram_user_id, tickets FROM raffle_entries WHERE raffle_id=$1 AND tickets>0`, [raffle.id]);
    let poolPrize = Number(raffle.prize_pool);
    const available = entries.rows.map(e => ({ id: String(e.telegram_user_id), tickets: Number(e.tickets) }));
    const winnerCount = Math.min(Number(raffle.winners_count), available.length);
    if (!winnerCount) {
      await client.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1`, [String(raffle.creator_id), poolPrize]);
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) SELECT telegram_id,'raffle_refund',$2,balance,'Возврат приза: в розыгрыше нет участников' FROM users WHERE telegram_id=$1`, [String(raffle.creator_id), poolPrize]);
      const finalR = await client.query(`SELECT balance::float AS balance FROM users WHERE telegram_id=$1`, [String(raffle.creator_id)]);
      await client.query(`UPDATE raffles SET status='finished', finished_at=NOW() WHERE id=$1`, [raffle.id]);
      await client.query('COMMIT');
      invalidateUserCache(raffle.creator_id);
      io.to(`user:${raffle.creator_id}`).emit('balance_updated', { balance: Number(finalR.rows[0].balance) });
      return true;
    }

    const winners = [];
    for (let place=1; place<=winnerCount; place++) {
      const chosen = randomWeightedPick(available);
      if (!chosen) break;
      available.splice(available.indexOf(chosen), 1);
      winners.push({ id: chosen.id, place });
    }
    const base = Math.floor((poolPrize / winners.length) * 100) / 100;
    let distributed = 0;
    for (let i=0; i<winners.length; i++) {
      const payout = i === winners.length - 1 ? Number((poolPrize - distributed).toFixed(2)) : base;
      distributed = Number((distributed + payout).toFixed(2));
      const updated = await client.query(`UPDATE users SET balance=balance+$2, games_won=games_won, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [winners[i].id, payout]);
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_prize',$2,$3,$4)`, [winners[i].id,payout,Number(updated.rows[0].balance),`Выигрыш в розыгрыше ${raffle.id}`]);
      await client.query(`INSERT INTO raffle_winners (raffle_id,telegram_user_id,place,payout) VALUES ($1,$2,$3,$4)`, [raffle.id,winners[i].id,winners[i].place,payout]);
      invalidateUserCache(winners[i].id);
    }
    await client.query(`UPDATE raffles SET status='finished', finished_at=NOW() WHERE id=$1`, [raffle.id]);
    await client.query('COMMIT');
    for (const w of winners) {
      const u = await getUser(w.id, { fresh: true }).catch(() => null);
      if (u) io.to(`user:${w.id}`).emit('balance_updated', { balance: Number(u.balance) });
    }

    const publicPrize = Number(raffle.prize_pool);
    const text = `🎁 РОЗЫГРЫШ ЗАВЕРШЁН\n\n🏆 ${raffle.prize_title || 'Stars'} — ${publicPrize.toFixed(2)} ⭐\n👥 Победителей: ${winners.length}`;
    await telegramApi('sendMessage', { chat_id: raffle.channel_id, text }).catch(e => console.error('Raffle result post error:', e.message));
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('finishRaffle error:', e.message);
    return false;
  } finally {
    client.release();
  }
}

let raffleSettleInFlight = false;
async function settleExpiredRaffles() {
  if (!pool || raffleSettleInFlight) return;
  raffleSettleInFlight = true;
  try {
    const r = await pool.query(`SELECT * FROM raffles WHERE status='active' AND ends_at <= NOW() ORDER BY ends_at ASC LIMIT 10`);
    for (const row of r.rows) await finishRaffle(row);
  } catch (e) {
    console.error('raffle scheduler error:', e.message);
  } finally {
    raffleSettleInFlight = false;
  }
}

async function buildRafflePost(raffle, detailsUrl) {
  const each = raffle.winnersCount > 0 ? Number(raffle.prizePool / raffle.winnersCount) : 0;
  const ticketLine = raffle.type === 'paid' ? `${raffle.ticketPrice.toFixed(2)} ⭐` : 'Бесплатно';
  return [
    '🎁 <b>РОЗЫГРЫШ ПОДАРКОВ</b>',
    '',
    `🏆 Приз: <b>${String(raffle.prizeTitle || 'Stars')}</b>`,
    `💰 Призовой фонд: <b>${raffle.prizePool.toFixed(2)} ⭐</b>`,
    `👥 Победителей: <b>${raffle.winnersCount}</b>`,
    `💎 Каждому: <b>≈ ${each.toFixed(2)} ⭐</b>`,
    `🎟 Билет: <b>${ticketLine}</b>`,
    `⏰ Итоги: <b>${new Date(raffle.endsAt).toLocaleString('ru-RU')}</b>`,
    '',
    'Нажми кнопку ниже, чтобы участвовать.'
  ].join('\n');
}

async function createRaffleForUser(userId, body) {
  requireDatabase();
  const type = body?.type === 'paid' ? 'paid' : 'free';
  const ticketPrice = type === 'paid' ? Number(body?.ticketPrice) : 0;
  const prizePool = Number(body?.prizePool);
  const winnersCount = Number(body?.winnersCount);
  const prizeTitle = String(body?.prizeTitle || 'Stars').trim().slice(0, 100) || 'Stars';
  const endsAt = new Date(body?.endsAt);

  if (!Number.isFinite(prizePool) || prizePool <= 0) throw new Error('Укажи сумму приза больше 0.');
  if (!Number.isInteger(winnersCount) || winnersCount <= 0 || winnersCount > 1000) throw new Error('Укажи количество победителей от 1 до 1000.');
  if (type === 'paid' && (!Number.isFinite(ticketPrice) || ticketPrice <= 0)) throw new Error('Укажи цену билета больше 0.');
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() < Date.now() + 60_000) throw new Error('Время окончания должно быть минимум через 1 минуту.');
  if (prizePool > 1_000_000_000 || ticketPrice > 1_000_000_000) throw new Error('Слишком большая сумма.');

  const verified = await verifyRaffleChannel(body?.channel, userId);
  const creator = await getUser(userId, { fresh: true });
  if (!creator) throw new Error('Пользователь не найден.');

  const client = await pool.connect();
  let raffle;
  try {
    await client.query('BEGIN');
    const debit = await client.query(`UPDATE users SET balance=(balance-$2::numeric), updated_at=NOW() WHERE telegram_id=$1 AND banned=false AND balance >= $2::numeric RETURNING balance::float AS balance`, [String(userId), prizePool]);
    if (!debit.rowCount) {
      const missing = Math.max(0, Number((prizePool - Number(creator.balance)).toFixed(2)));
      throw Object.assign(new Error('Недостаточно Stars на балансе.'), { code: 'INSUFFICIENT_FUNDS', missing, balance: Number(creator.balance) });
    }
    const id = crypto.randomUUID();
    const balanceAfter = Number(debit.rows[0].balance);
    await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_create',$2,$3,$4)`, [String(userId), -prizePool, balanceAfter, `Создание розыгрыша ${id}`]);
    const r = await client.query(
      `INSERT INTO raffles (id,creator_id,raffle_type,ticket_price,prize_pool,prize_title,winners_count,ends_at,channel_id,channel_username,channel_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,String(userId),type,ticketPrice,prizePool,prizeTitle,winnersCount,endsAt, String(verified.chat.id), verified.username, verified.chat.title || verified.username]
    );
    raffle = r.rows[0];
    await client.query('COMMIT');
    invalidateUserCache(userId);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }

  const pub = rafflePublicRow(raffle);
  try {
    const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('APP_PUBLIC_URL/RENDER_EXTERNAL_URL не настроен.');
    const bot = await getBotInfoCached();
    const detailsUrl = `${base}/?raffle=${encodeURIComponent(raffle.id)}`;
    const miniAppLink = bot?.username ? buildTelegramMiniAppLink(bot.username, `raffle_${raffle.id}`) : detailsUrl;
    const text = await buildRafflePost(pub, detailsUrl);
    const sent = await telegramApi('sendMessage', {
      chat_id: verified.chat.id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🎁 УЧАСТВОВАТЬ', url: miniAppLink }]] }
    });
    await pool.query(`UPDATE raffles SET post_message_id=$2 WHERE id=$1`, [raffle.id, Number(sent.message_id)]);
    pub.postMessageId = Number(sent.message_id);
  } catch (e) {
    // If posting failed, refund the locked prize pool so a broken Telegram permission never burns the creator's balance.
    const refund = await pool.connect();
    try {
      await refund.query('BEGIN');
      const rr = await refund.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [String(userId), prizePool]);
      if (rr.rowCount) {
        await refund.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_refund',$2,$3,$4)`, [String(userId),prizePool,Number(rr.rows[0].balance),`Возврат: не удалось опубликовать розыгрыш ${raffle.id}`]);
      }
      await refund.query(`UPDATE raffles SET status='cancelled' WHERE id=$1`, [raffle.id]);
      await refund.query('COMMIT');
      invalidateUserCache(userId);
    } catch (refundError) { try { await refund.query('ROLLBACK'); } catch {} console.error('Raffle refund error:', refundError.message); }
    finally { refund.release(); }
    throw new Error(`Не удалось опубликовать розыгрыш в канале: ${e.message}`);
  }

  return { raffle: pub, balance: await getBalance(userId) };
}

async function requireRaffleSubscription(userId, raffle) {
  const subscribed = await isRaffleChannelSubscribed(raffle, userId);
  if (!subscribed) {
    throw Object.assign(new Error('Сначала подпишись на канал розыгрыша.'), { code: 'RAFFLE_SUBSCRIPTION_REQUIRED' });
  }
}

async function joinRaffle(userId, raffleId, startParam = '') {
  requireDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM raffles WHERE id=$1 FOR UPDATE`, [String(raffleId)]);
    if (!rr.rowCount) throw new Error('Розыгрыш не найден.');
    const raffle = rr.rows[0];
    if (raffle.status !== 'active' || new Date(raffle.ends_at).getTime() <= Date.now()) throw new Error('Розыгрыш уже завершён.');
    await requireRaffleSubscription(userId, raffle);
    const existing = await client.query(`SELECT tickets, paid_amount FROM raffle_entries WHERE raffle_id=$1 AND telegram_user_id=$2 FOR UPDATE`, [String(raffleId),String(userId)]);
    if (existing.rowCount) throw new Error('Ты уже участвуешь в этом розыгрыше.');
    let paid = 0;
    if (raffle.raffle_type === 'paid') {
      paid = Number(raffle.ticket_price);
      const deb = await client.query(`UPDATE users SET balance=(balance-$2::numeric), updated_at=NOW() WHERE telegram_id=$1 AND banned=false AND balance >= $2::numeric RETURNING balance::float AS balance`, [String(userId),paid]);
      if (!deb.rowCount) {
        const u = await client.query(`SELECT balance::float AS balance FROM users WHERE telegram_id=$1`, [String(userId)]);
        const current = u.rowCount ? Number(u.rows[0].balance) : 0;
        const missing = Math.max(0, Number((paid-current).toFixed(2)));
        throw Object.assign(new Error('Недостаточно Stars для билета.'), { code:'INSUFFICIENT_FUNDS', missing, balance: current });
      }
      await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) SELECT $1,'raffle_ticket',-$2,balance,$3 FROM users WHERE telegram_id=$1`, [String(userId),paid,`Билет в розыгрыш ${raffleId}`]);
      const creatorCredit = await client.query(`UPDATE users SET balance=(balance+$2::numeric), updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`, [String(raffle.creator_id),paid]);
      if (creatorCredit.rowCount) {
        await client.query(`INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description) VALUES ($1,'raffle_ticket_income',$2,$3,$4)`, [String(raffle.creator_id),paid,Number(creatorCredit.rows[0].balance),`Оплата билета в розыгрыше ${raffleId}`]);
      }
    }
    await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,1,$3)`, [String(raffleId),String(userId),paid]);

    const ref = parseRaffleStartParam(startParam);
    if (ref && ref.raffleId === String(raffleId) && ref.referrerId !== String(userId)) {
      const refExists = await client.query(`SELECT 1 FROM raffle_referrals WHERE raffle_id=$1 AND referred_user_id=$2`, [String(raffleId),String(userId)]);
      if (!refExists.rowCount) {
        const refOwner = await client.query(`SELECT 1 FROM users WHERE telegram_id=$1`, [String(ref.referrerId)]);
        if (refOwner.rowCount) {
          await client.query(`INSERT INTO raffle_referrals (raffle_id,referrer_id,referred_user_id) VALUES ($1,$2,$3)`, [String(raffleId),String(ref.referrerId),String(userId)]);
          await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,1,0) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET tickets=(raffle_entries.tickets+1::integer)`, [String(raffleId),String(ref.referrerId)]);
        }
      }
    }

    await client.query('COMMIT');
    invalidateUserCache(userId);
    const userRow = await getUser(userId,{fresh:true});
    if (userRow) io.to(`user:${userId}`).emit('balance_updated', { balance: Number(userRow.balance) });
    return { balance: userRow ? Number(userRow.balance) : 0 };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}

async function checkRaffleBoost(userId, raffleId) {
  const raffle = await getRaffleById(raffleId);
  if (!raffle) throw new Error('Розыгрыш не найден.');
  if (raffle.status !== 'active') throw new Error('Розыгрыш уже завершён.');
  try {
    const result = await telegramApi('getUserChatBoosts', { chat_id: raffle.channel_id, user_id: Number(userId) });
    const boosts = Array.isArray(result?.boosts) ? result.boosts : [];
    const now = Math.floor(Date.now()/1000);
    const activeBoosts = boosts.filter(b => !b.expires || Number(b.expires) > now);
    const count = activeBoosts.length;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query(`SELECT boost_count FROM raffle_boost_claims WHERE raffle_id=$1 AND telegram_user_id=$2 FOR UPDATE`, [String(raffleId),String(userId)]);
      const claimed = old.rowCount ? Number(old.rows[0].boost_count) : 0;
      const delta = Math.max(0, count - claimed);
      if (delta > 0) {
        await client.query(`INSERT INTO raffle_entries (raffle_id,telegram_user_id,tickets,paid_amount) VALUES ($1,$2,$3,0) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET tickets=(raffle_entries.tickets+$3::integer)`, [String(raffleId),String(userId),delta]);
      }
      await client.query(`INSERT INTO raffle_boost_claims (raffle_id,telegram_user_id,boost_count) VALUES ($1,$2,$3) ON CONFLICT (raffle_id,telegram_user_id) DO UPDATE SET boost_count=EXCLUDED.boost_count, claimed_at=NOW()`, [String(raffleId),String(userId),count]);
      await client.query('COMMIT');
      return { boosts: count, newTickets: delta };
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  } catch (e) {
    if (/CHAT_ADMIN_REQUIRED|FORBIDDEN|not enough rights/i.test(e.message || '')) throw new Error('Бот должен быть администратором канала с правом управления бустами.');
    throw new Error(`Не удалось проверить буст: ${e.message}`);
  }
}

function buildMiniAppOpenUrl(refCode = "") {
  const base = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  const ref = String(refCode || "").trim();
  return ref ? `${base}/?ref=${encodeURIComponent(ref)}` : base;
}

async function configureTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot is not configured: TELEGRAM_BOT_TOKEN is missing.");
    return;
  }

  let botInfo = null;
  try {
    botInfo = await getBotInfoCached();
    console.log(`Telegram bot connected: @${normalizeBotUsername(botInfo?.username) || 'UNKNOWN'}`);
    if (!normalizeBotUsername(botInfo?.username)) {
      console.warn('Telegram getMe returned no valid username; Mini App deep links cannot be generated.');
    }
  } catch (e) {
    console.error('Telegram getMe error:', e.message);
  }

  const appUrl = buildMiniAppOpenUrl();
  if (!appUrl) {
    console.warn("Telegram webhook is not configured: APP_PUBLIC_URL/RENDER_EXTERNAL_URL is missing.");
    return;
  }

  const webhookUrl = `${appUrl}/api/telegram/webhook`;
  const rawSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "");
  // Telegram only accepts 1-256 chars of A-Z a-z 0-9 _ - in secret_token.
  // An invalid value used to make the whole setup call throw, which also
  // skipped registering /start and the menu button below.
  const secret = activeWebhookSecret();
  if (rawSecret && !secret) {
    console.warn("TELEGRAM_WEBHOOK_SECRET содержит недопустимые символы (разрешены A-Z a-z 0-9 _ -); вебхук будет настроен без secret_token.");
  }

  try {
    await telegramApi("setWebhook", {
      url: webhookUrl,
      ...(secret ? { secret_token: secret } : {}),
      allowed_updates: ["message", "pre_checkout_query", "callback_query"],
      drop_pending_updates: false
    });

    // /freebet remains a hidden admin-only command: it still works when typed
    // manually, but Telegram must not advertise it in the slash-command list.
    await telegramApi("deleteMyCommands", {});
    await telegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть приложение" },
        { command: "help", description: "Помощь" }
      ]
    });

    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Розыгрыши",
        web_app: { url: appUrl }
      }
    });

    console.log(`Telegram webhook configured: ${webhookUrl}`);
  } catch (e) {
    console.error("Telegram setup error:", e.message);
  }
}

async function verifyTelegramWebhook() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    const info = await telegramApi("getWebhookInfo", {});
    console.log(`Telegram webhook: ${info.url || "NOT_SET"}${info.last_error_message ? ` | last error: ${info.last_error_message}` : ""}`);
  } catch (e) {
    console.error("Telegram webhook check error:", e.message);
  }
}

async function handleTelegramStart(message) {
  if (!message?.chat?.id) return;

  const text = String(message.text || "").trim();
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  const parameter = match?.[1] ? String(match[1]).trim() : "";

  try {
    await sendWelcome(message);
  } catch (e) {
    console.error("Telegram /start welcome error:", e.message);
  }

  if (message.from?.id) {
    try {
      await upsertUser({
        id: String(message.from.id),
        username: String(message.from.username || ""),
        first_name: safeName(message.from.first_name || "Игрок"),
        photo_url: ""
      }, parameter);
    } catch (e) {
      console.error("Telegram /start user sync error:", e.message);
    }
  }
}

async function handleTelegramHelp(message) {
  if (!message?.chat?.id) return;
  await sendWelcome(message);
}

function activeWebhookSecret() {
  const raw = String(process.env.TELEGRAM_WEBHOOK_SECRET || "");
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : "";
}

async function handleWithdrawalCallback(callback) {
  const adminId = String(callback?.from?.id || "");
  const match = String(callback?.data || "").match(/^withdraw:(approve|decline|reject-empty):(\d+)$/);
  if (!match) return false;
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, "Нет доступа.");
    return true;
  }

  const [, action, requestId] = match;
  try {
    if (action === "approve") {
      const withdrawal = await completeWithdrawal(requestId, adminId);
      await notifyWithdrawalCompleted(withdrawal);
      await answerCallbackQuery(callback.id, "Вывод подтверждён.");
      await telegramApi("editMessageReplyMarkup", {
        chat_id: callback.message?.chat?.id,
        message_id: callback.message?.message_id,
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
      return true;
    }

    if (action === "decline") {
      await requestWithdrawalDeclineReason(requestId, adminId);
      await answerCallbackQuery(callback.id, "Укажите причину отказа.");
      await telegramApi("sendMessage", {
        chat_id: adminId,
        text: `Напишите причину отклонения заявки №${requestId} одним сообщением.`,
        reply_markup: {
          inline_keyboard: [[{
            text: "Отклонить без объяснения причин",
            callback_data: `withdraw:reject-empty:${requestId}`
          }]]
        }
      });
      return true;
    }

    const withdrawal = await rejectWithdrawal(requestId, adminId);
    await notifyWithdrawalRejected(withdrawal);
    await answerCallbackQuery(callback.id, "Заявка отклонена, средства возвращены.");
    return true;
  } catch (e) {
    await answerCallbackQuery(callback.id, e.message || "Не удалось обработать заявку.");
    return true;
  }
}

async function handleWithdrawalDeclineReason(message) {
  const adminId = String(message?.from?.id || "");
  const text = String(message?.text || "").trim();
  if (!isAdmin(adminId) || !text || text.startsWith("/")) return false;
  requireDatabase();
  const pending = await pool.query(
    `SELECT id FROM withdrawal_requests
     WHERE status='decline_reason_pending' AND reviewed_by=$1
     ORDER BY created_at DESC LIMIT 1`,
    [adminId]
  );
  if (!pending.rowCount) return false;

  const withdrawal = await rejectWithdrawal(pending.rows[0].id, adminId, text);
  await notifyWithdrawalRejected(withdrawal);
  await telegramApi("sendMessage", {
    chat_id: adminId,
    text: `Заявка №${withdrawal.id} отклонена. Средства возвращены пользователю.`
  });
  return true;
}

app.get("/api/support/config", async (req, res) => {
  try {
    if (!process.env.SUPPORT_BOT_TOKEN) return res.json({ ok: false, url: "" });
    const info = await getSupportBotInfoCached();
    res.json({ ok: true, url: buildSupportChatUrl(), username: String(info?.username || "") });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Support bot unavailable." });
  }
});

app.post("/api/support/webhook", async (req, res) => {
  const expectedSecret = activeWebhookSecret();
  if (expectedSecret && req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) return res.status(401).end();
  if (!process.env.SUPPORT_BOT_TOKEN) return res.status(503).json({ ok: false });
  try {
    const update = req.body || {};
    if (update.callback_query) {
      const handled = await handleSupportBotCallback(update.callback_query);
      return res.json({ ok: true, handled });
    }
    if (update.message) {
      const handled = await handleSupportBotMessage(update.message);
      return res.json({ ok: true, handled });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("Support webhook error:", e.message);
    return res.status(200).json({ ok: true });
  }
});


function appGameProfitStats() {
  return pool.query(`
    WITH sums AS (
      SELECT
        COALESCE(SUM(CASE WHEN type='pvp_bet' THEN -amount ELSE 0 END),0)::float AS pvp_bets,
        COALESCE(SUM(CASE WHEN type='pvp_win' THEN amount ELSE 0 END),0)::float AS pvp_payouts,
        COALESCE(SUM(CASE WHEN type='upgrade_bet' THEN -amount ELSE 0 END),0)::float AS upgrade_bets,
        COALESCE(SUM(CASE WHEN type='upgrade_win' THEN amount ELSE 0 END),0)::float AS upgrade_payouts,
        COALESCE(SUM(CASE WHEN type='bounce_bet' THEN -amount ELSE 0 END),0)::float AS bounce_bets,
        COALESCE(SUM(CASE WHEN type='bounce_win' THEN amount ELSE 0 END),0)::float AS bounce_payouts,
        COALESCE(SUM(CASE WHEN type='ice_bet' THEN -amount ELSE 0 END),0)::float AS ice_bets,
        COALESCE(SUM(CASE WHEN type='ice_win' THEN amount ELSE 0 END),0)::float AS ice_payouts
      FROM balance_transactions
      WHERE type IN ('pvp_bet','pvp_win','upgrade_bet','upgrade_win','bounce_bet','bounce_win','ice_bet','ice_win')
    )
    SELECT *,
      (pvp_bets - pvp_payouts)::float AS pvp_profit,
      (upgrade_bets - upgrade_payouts)::float AS upgrade_profit,
      (bounce_bets - bounce_payouts)::float AS bounce_profit,
      (ice_bets - ice_payouts)::float AS ice_profit,
      ((pvp_bets - pvp_payouts)
       + (upgrade_bets - upgrade_payouts)
       + (bounce_bets - bounce_payouts)
       + (ice_bets - ice_payouts))::float AS total_profit
    FROM sums
  `);
}

async function handleTelegramStats(message) {
  const chatId = message?.chat?.id;
  const adminId = String(message?.from?.id || "");
  if (!chatId) return;
  if (!isAdmin(adminId)) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "⛔ Команда /stats доступна только администраторам."
    }).catch(() => {});
    return;
  }

  try {
    requireDatabase();
    const r = await appGameProfitStats();
    const s = r.rows[0] || {};
    const mode = (name, bets, payouts, profit) =>
      `${name}\n  Ставки: <b>${formatAdminMoney(bets)} ⭐</b>\n  Выплаты: <b>${formatAdminMoney(payouts)} ⭐</b>\n  Результат: <b>${profit >= 0 ? "+" : ""}${formatAdminMoney(profit)} ⭐</b>`;

    const currentPvp = totalBank();
    const currentIce = ice_r3(iceRound.players.reduce((sum, p) => sum + Number(p.stake || 0), 0));

    const text =
      `📊 <b>ПРИБЫЛЬ ПРИЛОЖЕНИЯ</b>\n\n` +
      mode("🎡 PVP ROLL", Number(s.pvp_bets), Number(s.pvp_payouts), Number(s.pvp_profit)) + `\n\n` +
      mode("⬆️ UPGRADE", Number(s.upgrade_bets), Number(s.upgrade_payouts), Number(s.upgrade_profit)) + `\n\n` +
      mode("↩️ ОТСКОК", Number(s.bounce_bets), Number(s.bounce_payouts), Number(s.bounce_profit)) + `\n\n` +
      mode("❄️ ICE ARENA", Number(s.ice_bets), Number(s.ice_payouts), Number(s.ice_profit)) + `\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `💰 <b>ОБЩИЙ РЕЗУЛЬТАТ: ${Number(s.total_profit) >= 0 ? "+" : ""}${formatAdminMoney(s.total_profit)} ⭐</b>\n\n` +
      `⏳ Незавершённый PVP банк: <b>${formatAdminMoney(currentPvp)} ⭐</b>\n` +
      `⏳ Незавершённый Ice Arena банк: <b>${formatAdminMoney(currentIce)} ⭐</b>\n\n` +
      `<i>Результат считается по проведённым игровым ставкам и выплатам из PostgreSQL.</i>`;

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
  } catch (e) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: `❌ Не удалось получить статистику: ${escapeHtmlTelegram(e.message || "DB error")}`,
      parse_mode: "HTML"
    }).catch(() => {});
  }
}

app.post("/api/telegram/webhook", async (req, res) => {
  const expectedSecret = activeWebhookSecret();
  if (expectedSecret && req.headers["x-telegram-bot-api-secret-token"] !== expectedSecret) {
    return res.status(401).end();
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(503).json({ ok: false });

  try {
    const update = req.body || {};

    if (update.callback_query) {
      if (await handleAdminStatsCallback(update.callback_query)) {
        res.json({ ok: true, handled: "admin_stats_callback" });
        return;
      }
      if (await handleAdminBroadcastCallback(update.callback_query)) {
        res.json({ ok: true, handled: "admin_broadcast_callback" });
        return;
      }
      if (await handleTaskApprovalCallback(update.callback_query)) {
        res.json({ ok: true, handled: "task_approval_callback" });
        return;
      }
      if (await handleFreebetCallback(update.callback_query)) {
        res.json({ ok: true, handled: "freebet_callback" });
        return;
      }
      res.json({ ok: true, handled: "callback" });
      setImmediate(() => handleWithdrawalCallback(update.callback_query).catch(e => console.error("Withdrawal callback error:", e.message)));
      return;
    }

    const incomingMessage = update.message;
    const incomingText = String(incomingMessage?.text || "").trim();

    if (/^\/stats(?:@\w+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "stats" });
      setImmediate(() => handleTelegramStats(incomingMessage).catch(e => console.error("Telegram /stats async error:", e.message)));
      return;
    }

    if (/^\/broadcast(?:@\w+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "broadcast" });
      setImmediate(() => startAdminBroadcast(String(incomingMessage.from?.id || "")).catch(e => console.error("Telegram /broadcast error:", e.message)));
      return;
    }

    if (/^\/freebet(?:@\w+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "freebet" });
      setImmediate(() => handleFreebetCommand(incomingMessage).catch(e => console.error("Telegram /freebet async error:", e.message)));
      return;
    }

    if (/^\/start(?:@\w+)?(?:\s+.+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "start" });
      setImmediate(() => handleTelegramStart(incomingMessage).catch(e => console.error("Telegram /start async error:", e.message)));
      return;
    }

    if (/^\/help(?:@\w+)?$/i.test(incomingText)) {
      res.json({ ok: true, handled: "help" });
      setImmediate(() => handleTelegramHelp(incomingMessage).catch(e => console.error("Telegram /help async error:", e.message)));
      return;
    }

    if (incomingMessage && isAdmin(incomingMessage.from?.id)) {
      const adminPrivateHandled = await handleAdminPrivateText(incomingMessage);
      if (adminPrivateHandled) return res.json({ ok: true, handled: "admin_private" });
    }

    if (incomingMessage?.text && isAdmin(incomingMessage.from?.id)) {
      const freebetHandled = await handleFreebetWizardMessage(incomingMessage);
      if (freebetHandled) return res.json({ ok: true, handled: "freebet_wizard" });

      const handled = await handleWithdrawalDeclineReason(incomingMessage);
      if (handled) return res.json({ ok: true, handled: "withdrawal_decline_reason" });
    }

    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      let ok = false;
      try {
        const payload = JSON.parse(q.invoice_payload || "{}");
        ok = payload.type === "balance_topup"
          && String(payload.userId) === String(q.from?.id)
          && Number(payload.amount) === Number(q.total_amount)
          && q.currency === "XTR";
      } catch {}

      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: q.id,
          ok,
          ...(ok ? {} : { error_message: "Платёж недействителен." })
        })
      });
      return res.json({ ok: true });
    }

    const payment = update.message?.successful_payment;
    const tgUser = update.message?.from;
    if (payment && tgUser) {
      let payload;
      try { payload = JSON.parse(payment.invoice_payload || "{}"); }
      catch { return res.status(400).json({ ok: false }); }

      if (payload.type !== "balance_topup"
        || String(payload.userId) !== String(tgUser.id)
        || payment.currency !== "XTR") {
        return res.status(400).json({ ok: false });
      }

      requireDatabase();
      const chargeId = payment.telegram_payment_charge_id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const exists = await client.query(`SELECT 1 FROM payments WHERE telegram_payment_charge_id=$1 FOR UPDATE`, [chargeId]);
        if (!exists.rowCount) {
          await client.query(
            `INSERT INTO users (telegram_id, username, first_name)
             VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()`,
            [String(tgUser.id), tgUser.username || "", tgUser.first_name || "Игрок"]
          );
          const r = await client.query(
            `UPDATE users
             SET balance=(balance+$2::numeric),
                 total_deposited=total_deposited+$2::numeric,
                 updated_at=NOW()
             WHERE telegram_id=$1
             RETURNING balance::float AS balance, total_deposited::float AS total_deposited`,
            [String(tgUser.id), Number(payment.total_amount)]
          );
          const balanceAfter = Number(r.rows[0].balance);
          await client.query(
            `INSERT INTO balance_transactions
             (telegram_user_id, type, amount, balance_after, description)
             VALUES ($1,'stars_topup',$2,$3,$4)`,
            [String(tgUser.id), Number(payment.total_amount), balanceAfter, `Пополнение Telegram Stars, ${chargeId}`]
          );
          await client.query(
            `INSERT INTO payments (telegram_payment_charge_id, telegram_user_id, amount, payload)
             VALUES ($1,$2,$3,$4)`,
            [chargeId, String(tgUser.id), Number(payment.total_amount), payment.invoice_payload]
          );
          // Referral reward is accrued as PENDING and is not added to the referrer's
          // spendable balance until they press "ЗАБРАТЬ".
          const refRow = await client.query(
            `SELECT referred_by FROM users WHERE telegram_id=$1`,
            [String(tgUser.id)]
          );
          const referrerId = refRow.rows[0]?.referred_by ? String(refRow.rows[0].referred_by) : null;
          if (referrerId && referrerId !== String(tgUser.id)) {
            const reward = Number((Number(payment.total_amount) * 0.10).toFixed(2));
            await client.query(
              `INSERT INTO referral_earnings
               (referrer_id, referred_user_id, telegram_payment_charge_id, deposit_amount, reward_amount)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (telegram_payment_charge_id) DO NOTHING`,
              [referrerId, String(tgUser.id), chargeId, Number(payment.total_amount), reward]
            );
          }
          await client.query("COMMIT");
          io.to(`user:${tgUser.id}`).emit("balance_updated", { balance: balanceAfter });
          notifyBalanceTopup(tgUser.id, Number(payment.total_amount), "Telegram Stars").catch(e => console.error("Top-up DM error:", e.message));
          return res.json({ ok: true, credited: true });
        }
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Telegram webhook error:", e.message);
    res.status(500).json({ ok: false });
  }
});


app.post("/api/freebets/claim", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const raw = String(req.body?.token || "").trim();
    const freebetId = parseFreebetStartParam(raw)?.replace(/^fb_/, "") || (raw.match(/^[0-9a-f-]{36}$/i)?.[0] || "");
    if (!freebetId) throw new Error("Некорректная ссылка фрибета.");
    const result = await claimFreebet(session.telegram.id, freebetId);
    if (result.claimed) {
      io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance: result.balance });
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось активировать фрибет." });
  }
});


// Fast initial bootstrap: one authenticated DB read for balance + profile basics.
app.get("/api/bootstrap", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    // При каждом заходе в приложение баланс = ENTRY_BALANCE (по умолчанию 300 ⭐).
    // Отключить: переменная окружения ENTRY_BALANCE=off (или 0 / пусто через "off").
    const entryRaw = String(process.env.ENTRY_BALANCE ?? "300").trim().toLowerCase();
    const entryBalance = (entryRaw === "off" || entryRaw === "" || !Number.isFinite(Number(entryRaw))) ? null : Number(entryRaw);
    if (entryBalance !== null) {
      const rb = await pool.query(
        `UPDATE users SET balance=$2, updated_at=NOW() WHERE telegram_id=$1 RETURNING balance::float AS balance`,
        [String(session.telegram.id), entryBalance]
      );
      if (rb.rowCount) {
        session.db = { ...session.db, balance: Number(rb.rows[0].balance) };
        cacheUser(session.db);
      }
    }
    const security = await recordSecuritySignal(session.telegram.id, {
      fingerprint: req.headers['x-client-fingerprint'],
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent'],
      platform: req.headers['x-telegram-platform']
    });
    res.json({
      user: session.db,
      isAdmin: isAdmin(session.telegram.id),
      security,
      state: publicState(),
      gramUsdPerStar: Number(process.env.GRAM_USD_PER_STAR || 0.015)
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ---------------- PROFILE / REFERRALS ----------------
function appPublicUrl() {
  return String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
}

function buildReferralLink(userId) {
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!botUsername) return "";

  // Referral links always open the private chat with the bot.
  // The bot receives /start ref_<userId>, then sends the user a button
  // that opens the Mini App. This guarantees the referral is registered
  // before the user enters the app.
  return `https://t.me/${botUsername}?start=ref_${encodeURIComponent(String(userId))}`;
}

app.get("/api/profile", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const user = session.db;
    const r = await pool.query(
      `SELECT
         COUNT(DISTINCT referred_user_id)::int AS invited,
         COALESCE(SUM(reward_amount),0)::float AS total_earned,
         COALESCE(SUM(reward_amount) FILTER (WHERE claimed=false),0)::float AS pending,
         COALESCE(SUM(reward_amount) FILTER (WHERE claimed=true),0)::float AS claimed
       FROM referral_earnings
       WHERE referrer_id=$1`,
      [String(user.telegram_id)]
    );
    const s = r.rows[0] || {};
    const gamesPlayed = Number(user.games_played || 0);
    const gamesWon = Number(user.games_won || 0);
    const security = await recordSecuritySignal(session.telegram.id, {
      fingerprint: req.headers['x-client-fingerprint'],
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent'],
      platform: req.headers['x-telegram-platform']
    });
    res.json({
      user: { id: user.telegram_id, username: user.username, first_name: user.first_name, avatar_url: user.avatar_url, balance: Number(user.balance || 0) },
      stats: { gamesPlayed, gamesWon, winrate: gamesPlayed ? Number(((gamesWon / gamesPlayed) * 100).toFixed(2)) : 0, totalWagered: Number(user.total_wagered || 0) },
      referral: {
        invited: Number(s.invited || 0), totalEarned: Number(s.total_earned || 0), pending: Number(s.pending || 0), claimed: Number(s.claimed || 0), percent: 10, link: buildReferralLink(user.telegram_id)
      },
      security
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/profile/promo/redeem", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const result = await redeemPromoCode(session.telegram.id, req.body?.code);
    io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance: result.balance });
    res.json({ ok: true, code: result.code, bonus: result.bonus, wager: result.wager, balance: result.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/gram/topup-config", async (req, res) => {
  try {
    await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const recipient = String(
      process.env.TON_TOPUP_WALLET_ADDRESS ||
      process.env.TON_CONNECT_WALLET_ADDRESS ||
      (!String(process.env.TON_CONNECT || "").trim().startsWith("http") ? String(process.env.TON_CONNECT || "") : "")
    ).trim();
    // Accept "0,001" as well as "0.001" (a common paste mistake), and ignore
    // stray surrounding whitespace/newlines from copy-pasting into Render.
    const tonPerStarRaw = String(process.env.TON_PER_STAR || "").trim().replace(",", ".");
    const tonPerStar = Number(tonPerStarRaw);
    if (!recipient && (!tonPerStarRaw || !(tonPerStar > 0))) {
      return res.status(503).json({ error: "На Render не заданы TON_TOPUP_WALLET_ADDRESS и TON_PER_STAR (или сервис не передеплоен после их добавления)." });
    }
    if (!recipient) {
      return res.status(503).json({ error: "На Render не задан TON_TOPUP_WALLET_ADDRESS (или сервис не передеплоен после его добавления)." });
    }
    if (!tonPerStarRaw || !(tonPerStar > 0)) {
      return res.status(503).json({ error: "TON_PER_STAR на Render пуст или не является числом больше нуля (проверьте, не запятая ли вместо точки)." });
    }
    res.json({ recipient, tonPerStar });
  } catch (e) {
    res.status(401).json({ error: e.message || "Авторизация не выполнена." });
  }
});

app.post("/api/gram/topup-intent", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const amount = Number(req.body?.amount);
    const tonPerStar = Number(String(process.env.TON_PER_STAR || "").trim().replace(",", "."));
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (!(tonPerStar > 0)) throw new Error("TON_PER_STAR не настроен.");

    const id = crypto.randomUUID();
    const comment = `RING:${id}`;
    const expectedNanoTon = Math.round(amount * tonPerStar * 1e9);
    if (!Number.isSafeInteger(expectedNanoTon) || expectedNanoTon <= 0) throw new Error("Сумма TON некорректна.");
    await pool.query(
      `INSERT INTO ton_topup_intents (id, telegram_user_id, expected_nano_ton, stars, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, String(session.telegram.id), String(expectedNanoTon), amount, comment]
    );
    const payload = beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString("base64");
    res.json({ ok: true, payload, comment });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось подготовить TON-пополнение." });
  }
});

function tonMessageComment(message) {
  const exact = /^RING:[0-9a-f-]{36}$/i;
  const seen = new Set();
  const queue = [message];
  while (queue.length) {
    const value = queue.shift();
    if (value == null) continue;
    if (typeof value === 'string') {
      const text = value.trim();
      if (exact.test(text)) return text;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/comment|text|decoded|body|payload|message_content|decoded_body|msg_data/i.test(key)) queue.push(child);
      else if (child && typeof child === 'object') queue.push(child);
    }
  }
  return "";
}

async function settleTonTopups() {
  if (!pool) return;
  const recipient = String(process.env.TON_TOPUP_WALLET_ADDRESS || process.env.TON_CONNECT_WALLET_ADDRESS || "").trim();
  if (!recipient) return;
  try {
    const headers = {};
    if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;
    const response = await fetch(`https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(recipient)}/transactions?limit=100`, { headers });
    if (!response.ok) throw new Error(`TonAPI ${response.status}`);
    const data = await response.json();
    for (const transaction of data.transactions || []) {
      const comment = tonMessageComment(transaction.in_msg);
      if (!/^RING:[0-9a-f-]{36}$/i.test(comment)) continue;
      const hash = String(transaction.hash || transaction.transaction_id?.hash || "");
      const value = BigInt(String(transaction.in_msg?.value || "0"));
      if (!hash || value <= 0n) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const intent = await client.query(
          `SELECT * FROM ton_topup_intents WHERE comment=$1 AND status='pending' FOR UPDATE`,
          [comment]
        );
        if (!intent.rowCount || value < BigInt(intent.rows[0].expected_nano_ton)) {
          await client.query("ROLLBACK");
          continue;
        }
        const row = intent.rows[0];
        const balance = await creditBalance(row.telegram_user_id, Number(row.stars), client, {
          type: "ton_topup",
          description: `Автопополнение TON, транзакция ${hash}`
        });
        await client.query(
          `UPDATE users SET total_deposited=total_deposited+$2::numeric, updated_at=NOW() WHERE telegram_id=$1`,
          [String(row.telegram_user_id), Number(row.stars)]
        );
        await client.query(
          `UPDATE ton_topup_intents SET status='credited', transaction_hash=$2, credited_at=NOW() WHERE id=$1`,
          [row.id, hash]
        );
        await client.query("COMMIT");
        io.to(`user:${row.telegram_user_id}`).emit("balance_updated", { balance });
        notifyBalanceTopup(row.telegram_user_id, Number(row.stars), "GRAM / TON").catch(e => console.error("GRAM top-up DM error:", e.message));
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        console.error("TON top-up settlement error:", e.message);
      } finally {
        client.release();
      }
    }
  } catch (e) {
    console.error("TON top-up polling error:", e.message);
  }
}

// ---------------------------------------------------------------------------
// TODO: AUTOMATIC TON TOP-UPS (currently manual — admin approves by hand)
// ---------------------------------------------------------------------------
// Right now this endpoint only WRITES a 'topup_pending' request row and pings
// the admin in Telegram — a human has to see the on-chain payment and credit
// the user manually. To make this fully automatic, add a background poller
// that watches TON_TOPUP_WALLET_ADDRESS for incoming transactions and credits
// balances itself, no admin step needed. Rough plan:
//
// 1. Give every user a way to be identified from their transaction alone.
//    TON lets you attach a short text "comment" to a transfer. When a user
//    starts a top-up, generate/show them a comment to paste, e.g. their own
//    telegram_id ("UID12345678"), OR (cleaner) have the TonConnect transfer
//    include that comment automatically in its payload — no manual typing.
//
// 2. Add a small table to remember which on-chain transactions we already
//    credited, so we never double-credit on a re-poll:
//      CREATE TABLE IF NOT EXISTS ton_deposits (
//        tx_hash TEXT PRIMARY KEY,
//        telegram_user_id TEXT NOT NULL,
//        amount_ton NUMERIC NOT NULL,
//        stars_credited INTEGER NOT NULL,
//        created_at TIMESTAMPTZ DEFAULT NOW()
//      );
//
// 3. Every N seconds (setInterval, e.g. 20–30s), call a TON indexer API for
//    TON_TOPUP_WALLET_ADDRESS's recent incoming transactions — e.g.
//    TonCenter: GET https://toncenter.com/api/v2/getTransactions?address=...
//    or TonAPI:  GET https://tonapi.io/v2/blockchain/accounts/{address}/transactions
//    (both need a free API key for reasonable rate limits — add as
//    TONCENTER_API_KEY / TONAPI_KEY env vars).
//
// 4. For each NEW incoming transaction (hash not yet in ton_deposits):
//      - Read the TON amount and the attached comment.
//      - Extract the telegram_user_id from the comment (parse "UID<digits>").
//      - If no match, skip it (leave for manual review — could be a stray
//        transfer) and maybe notifyAdmins() so nothing silently gets lost.
//      - stars = amount_ton / tonPerStar  (tonPerStar = TON_PER_STAR env var,
//        same conversion rate already used above for the manual flow).
//      - Insert the tx_hash into ton_deposits FIRST (or in the same DB
//        transaction as the credit) so a crash/restart mid-poll can't
//        double-credit the same transaction on the next poll.
//      - await creditBalance(telegram_user_id, Math.floor(stars), pool, {
//          type: "ton_topup", description: `TON пополнение ${amount_ton} TON`
//        });
//      - Optionally io.to(`user:${telegram_user_id}`).emit("balance_updated", ...)
//        so the app updates live without a page refresh.
//
// 5. Start the poller once at server boot (near the bottom of this file,
//    alongside the other setInterval-based background jobs), guarded so it
//    only runs when TON_TOPUP_WALLET_ADDRESS/TON_PER_STAR are actually set.
//
// This is a genuine integration (needs a real TON API key + live testing
// against real transactions), so it's left as this outline rather than an
// unverified implementation — ask and it can be built out for real.
// ---------------------------------------------------------------------------
app.post("/api/gram/topup-request", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = session.telegram.id;
    const amount = Number(req.body?.amount);
    const wallet = String(req.body?.wallet || "").trim();
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (!wallet) throw new Error("TON Connect кошелёк не найден.");

    const gramUsdPerStar = Number(process.env.GRAM_USD_PER_STAR || 0.015);
    const usd = amount * gramUsdPerStar;
    await pool.query(
      `INSERT INTO withdrawal_requests (telegram_user_id, currency, amount, wallet_address, status)
       VALUES ($1,'GRAM',$2,$3,'topup_pending')`,
      [String(userId), amount, wallet]
    );

    const displayName = session.telegram.username ? `@${session.telegram.username}` : session.telegram.first_name;
    notifyAdmins(
      `💎 Новая заявка на пополнение GRAM\n` +
      `Пользователь: ${displayName} (ID: ${userId})\n` +
      `Сумма заявки: ${amount} ⭐\n` +
      `Эквивалент: ≈ $${usd.toFixed(2)}\n` +
      `TON кошелёк: ${wallet}`
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось создать заявку." });
  }
});

app.post("/api/profile/withdraw", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = session.telegram.id;
    const currency = String(req.body?.currency || "STAR").trim().toUpperCase();
    const amount = Number(req.body?.amount);
    const wallet = String(req.body?.wallet || "").trim();

    if (!["STAR", "GRAM"].includes(currency)) throw new Error("Вывод доступен только в Stars или GRAM.");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Введите целую сумму Stars больше 0.");
    if (amount < 100) throw new Error("Вывод доступен от 100 звёзд.");
    if (currency === "GRAM" && !wallet) throw new Error("Для вывода GRAM укажите кошелёк.");

    // A promo bonus with a wager requirement locks withdrawals until the
    // player has staked (bet, win or lose — PVP and/or Upgrade) that much
    // total volume. It's cleared automatically once the balance hits 0.
    const wagerRow = await pool.query(`SELECT wager_remaining::float AS w FROM users WHERE telegram_id=$1`, [String(userId)]);
    const wagerRemaining = Number(wagerRow.rows[0]?.w || 0);
    if (wagerRemaining > 0) {
      throw new Error(`Сначала нужно отыграть бонус по промокоду: осталось поставить ${wagerRemaining.toFixed(2)} ⭐.`);
    }

    const gramUsdPerStar = Number(process.env.GRAM_USD_PER_STAR || 0.015);
    const gramUsd = currency === "GRAM" ? amount * gramUsdPerStar : null;
    const description = currency === "GRAM"
      ? `Заявка на вывод ${amount} ⭐ → GRAM (≈ $${gramUsd.toFixed(2)}), кошелёк ${wallet}`
      : `Заявка на вывод ${amount} ⭐ → Telegram Stars`;

    const balanceAfter = await debitBalance(userId, amount, {
      type: "withdraw_request",
      description
    });

    const ins = await pool.query(
      `INSERT INTO withdrawal_requests (telegram_user_id, currency, amount, wallet_address)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [String(userId), currency, amount, wallet]
    );

    const displayName = session.telegram.username
      ? `@${session.telegram.username}`
      : session.telegram.first_name;

    notifyWithdrawalAdmins(
      `📤 Новая заявка на вывод\n` +
      `Пользователь: ${displayName} (ID: ${userId})\n` +
      `Направление: ${currency === "GRAM" ? "GRAM" : "Telegram Stars"}\n` +
      `Сумма списания: ${amount} ⭐\n` +
      (currency === "GRAM" ? `Эквивалент: ≈ $${gramUsd.toFixed(2)}\nTON / GRAM кошелёк: ${wallet}\n` : "") +
      `Заявка №${ins.rows[0].id}`,
      ins.rows[0].id
    ).catch(() => {});

    io.to(`user:${userId}`).emit("balance_updated", { balance: balanceAfter });
    res.json({ ok: true, balance: balanceAfter, requestId: ins.rows[0].id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/profile/referrals/claim", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const userId = String(session.telegram.id);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const rows = await client.query(
        `SELECT id, reward_amount::float AS reward_amount
         FROM referral_earnings
         WHERE referrer_id=$1 AND claimed=false
         ORDER BY id
         FOR UPDATE`,
        [userId]
      );

      const amount = Number(rows.rows.reduce((sum, r) => sum + Number(r.reward_amount || 0), 0).toFixed(2));
      if (amount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Пока нет доступных реферальных начислений." });
      }

      const userRow = await client.query(
        `UPDATE users
         SET balance=balance+$2, updated_at=NOW()
         WHERE telegram_id=$1 AND banned=false
         RETURNING balance::float AS balance`,
        [userId, amount]
      );
      if (!userRow.rowCount) throw new Error("Пользователь не найден или заблокирован.");

      const balanceAfter = Number(userRow.rows[0].balance);
      await client.query(
        `INSERT INTO balance_transactions
         (telegram_user_id, type, amount, balance_after, description)
         VALUES ($1,'referral_claim',$2,$3,$4)`,
        [userId, amount, balanceAfter, "Получение реферального вознаграждения"]
      );

      await client.query(
        `UPDATE referral_earnings
         SET claimed=true, claimed_at=NOW()
         WHERE referrer_id=$1 AND claimed=false`,
        [userId]
      );

      await client.query("COMMIT");
      io.to(`user:${userId}`).emit("balance_updated", { balance: balanceAfter });
      res.json({ ok: true, amount, balance: balanceAfter });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- PROMO CODES ----------------
function normalizePromoCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

async function redeemPromoCode(userId, rawCode) {
  requireDatabase();
  const code = normalizePromoCode(rawCode);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error("Промокод должен содержать 3–32 символа: A-Z, 0-9, _ или -.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const promo = await client.query(
      `SELECT id, code, bonus::float AS bonus, wager::float AS wager, required_deposit::float AS required_deposit, max_uses, uses_count, active
       FROM promo_codes WHERE code=$1 FOR UPDATE`,
      [code]
    );
    if (!promo.rowCount) throw new Error("Промокод не найден.");
    const p = promo.rows[0];
    if (!p.active) throw new Error("Этот промокод отключён.");
    if (Number(p.uses_count) >= Number(p.max_uses)) throw new Error("Лимит активаций промокода исчерпан.");
    const userDeposit = await client.query(`SELECT total_deposited::float AS total_deposited FROM users WHERE telegram_id=$1 FOR UPDATE`, [String(userId)]);
    const totalDeposited = Number(userDeposit.rows[0]?.total_deposited || 0);
    const requiredDeposit = Number(p.required_deposit || 0);
    if (requiredDeposit > totalDeposited) {
      throw new Error(`Для активации промокода нужен депозит от ${requiredDeposit.toFixed(2)} ⭐. Ваш депозит: ${totalDeposited.toFixed(2)} ⭐.`);
    }

    const already = await client.query(
      `SELECT 1 FROM promo_redemptions WHERE promo_code_id=$1 AND telegram_user_id=$2`,
      [p.id, String(userId)]
    );
    if (already.rowCount) throw new Error("Вы уже активировали этот промокод.");

    const balanceAfter = await creditBalance(userId, Number(p.bonus), client, {
      type: "promo_code",
      description: `Активация промокода ${p.code}`
    });

    // A promo with a wager multiplier adds bonus*wager to the amount the
    // player must stake (in PVP and/or Upgrade, win or lose) before they can
    // withdraw again. Multiple such promos stack on top of each other.
    const wagerMultiplier = Number(p.wager || 0);
    if (wagerMultiplier > 0) {
      await client.query(
        `UPDATE users SET wager_remaining = wager_remaining + $2 WHERE telegram_id=$1`,
        [String(userId), Number(p.bonus) * wagerMultiplier]
      );
    }

    await client.query(
      `INSERT INTO promo_redemptions (promo_code_id, telegram_user_id, bonus) VALUES ($1,$2,$3)`,
      [p.id, String(userId), Number(p.bonus)]
    );
    await client.query(
      `UPDATE promo_codes SET uses_count=uses_count+1 WHERE id=$1`,
      [p.id]
    );
    await client.query("COMMIT");
    return { code: p.code, bonus: Number(p.bonus), wager: wagerMultiplier, balance: balanceAfter };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function createPromoCode(adminId, rawCode, bonus, maxUses, wager, requiredDeposit) {
  requireDatabase();
  const code = normalizePromoCode(rawCode);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error("Промокод должен содержать 3–32 символа: A-Z, 0-9, _ или -.");
  const amount = Number(bonus);
  const uses = Number(maxUses);
  const wagerMultiplier = wager === undefined || wager === null || wager === "" ? 0 : Number(wager);
  const depositRequirement = requiredDeposit === undefined || requiredDeposit === null || requiredDeposit === "" ? 0 : Number(requiredDeposit);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error("Бонус должен быть целым числом от 1 до 1 000 000 000.");
  if (!Number.isInteger(uses) || uses <= 0 || uses > 1_000_000_000) throw new Error("Количество активаций должно быть от 1 до 1 000 000 000.");
  if (!Number.isFinite(wagerMultiplier) || wagerMultiplier < 0 || wagerMultiplier > 1000) throw new Error("Вагер должен быть числом от 0 до 1000 (0 — без вагера).");
  if (!Number.isFinite(depositRequirement) || depositRequirement < 0 || depositRequirement > 1_000_000_000) throw new Error("Минимальный депозит должен быть от 0 до 1 000 000 000 ⭐.");

  try {
    const r = await pool.query(
      `INSERT INTO promo_codes (code, bonus, max_uses, created_by, wager, required_deposit) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, code, bonus::float AS bonus, wager::float AS wager, required_deposit::float AS required_deposit, max_uses, uses_count, active, created_at`,
      [code, amount, uses, String(adminId), wagerMultiplier, depositRequirement]
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === "23505") throw new Error("Такой промокод уже существует.");
    throw e;
  }
}

// ---------------- RAFFLE API ----------------
app.get('/api/raffles', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.headers['x-raffle-ref'] || '');
    const r = await pool.query(`
      SELECT r.id,r.creator_id,r.raffle_type,r.ticket_price::float AS ticket_price,r.prize_pool::float AS prize_pool,r.prize_title,r.winners_count,r.ends_at,r.channel_id,r.channel_username,r.channel_title,r.post_message_id,r.status,r.created_at,r.finished_at,
             u.username AS creator_username,u.first_name AS creator_first_name,
             COALESCE((SELECT SUM(e.tickets) FROM raffle_entries e WHERE e.raffle_id=r.id),0)::int AS total_tickets,
             COALESCE((SELECT COUNT(*) FROM raffle_entries e WHERE e.raffle_id=r.id),0)::int AS participants
      FROM raffles r JOIN users u ON u.telegram_id=r.creator_id
      WHERE r.status IN ('active','finished') ORDER BY CASE WHEN r.status='active' THEN 0 ELSE 1 END, r.ends_at DESC LIMIT 100`);
    const items = r.rows.map(x => ({ ...rafflePublicRow(x), totalTickets:Number(x.total_tickets), participants:Number(x.participants), creator:x.creator_username?'@'+x.creator_username:x.creator_first_name }));
    res.json({ raffles: items, me: String(session.db.telegram_id) });
  } catch(e) { res.status(401).json({error:e.message}); }
});

app.get('/api/raffles/:id', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.headers['x-raffle-ref'] || '');
    res.json(await getRaffleDetails(req.params.id, session.telegram.id));
  } catch(e) { res.status(400).json({error:e.message}); }
});

app.post('/api/raffles', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const result = await createRaffleForUser(session.telegram.id, req.body || {});
    res.json({ok:true,...result});
  } catch(e) {
    const code = e.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
    res.status(code).json({error:e.message, code:e.code || null, missing:Number(e.missing || 0), balance:Number(e.balance || 0)});
  }
});

app.get('/api/raffles/:id/subscription', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const raffle = await getRaffleById(req.params.id);
    if (!raffle) return res.status(404).json({ error: 'Розыгрыш не найден.' });
    const subscribed = await isRaffleChannelSubscribed(raffle, session.telegram.id);
    res.json({ ok: true, required: true, subscribed, channelUrl: botChannelLink(raffle.channel_username) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/raffles/:id/join', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], req.body?.startParam || '');
    const result = await joinRaffle(session.telegram.id, req.params.id, req.body?.startParam || '');
    res.json({ok:true,...result, detail: await getRaffleDetails(req.params.id, session.telegram.id)});
  } catch(e) {
    const code = e.code === 'INSUFFICIENT_FUNDS' ? 402 : 400;
    res.status(code).json({error:e.message, code:e.code || null, missing:Number(e.missing || 0), balance:Number(e.balance || 0)});
  }
});

app.post('/api/raffles/:id/check-boost', async (req,res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers['x-telegram-init-data'], '');
    const result = await checkRaffleBoost(session.telegram.id, req.params.id);
    res.json({ok:true,...result,detail:await getRaffleDetails(req.params.id,session.telegram.id)});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// ---------------- TASKS ----------------
async function verifyTaskChannel(channelUsername, userId = null) {
  const channel = normalizeChannelRef(channelUsername);
  if (!channel?.username) throw new Error("Укажите username канала, например @my_channel.");

  let chat;
  try {
    chat = await telegramApi("getChat", { chat_id: channel.chatId });
  } catch (e) {
    const msg = String(e.message || "");
    if (/chat not found|bad request/i.test(msg)) {
      throw new Error(`Канал ${channel.chatId} не найден. Проверь @username канала.`);
    }
    throw e;
  }
  if (chat.type !== "channel") throw new Error("Нужен именно Telegram-канал, а не группа.");

  const bot = await getBotInfoCached();
  let botMember;
  try {
    botMember = await telegramApi("getChatMember", { chat_id: chat.id, user_id: Number(bot.id) });
  } catch (e) {
    const msg = String(e.message || "");
    if (/member list is inaccessible|user not found|chat member/i.test(msg)) {
      throw new Error("Не удалось проверить права бота в канале. Добавьте бота администратором канала и дайте право проверять подписку.");
    }
    throw e;
  }
  if (!["creator", "administrator"].includes(String(botMember.status))) {
    throw new Error("Добавьте бота администратором канала, чтобы он мог проверять подписку.");
  }

  if (userId != null) {
    let member;
    try {
      member = await telegramApi("getChatMember", { chat_id: chat.id, user_id: Number(userId) });
    } catch (e) {
      const msg = String(e.message || "");
      if (/member list is inaccessible|user not found|chat member/i.test(msg)) {
        throw new Error("Telegram не дал проверить подписку. Убедись, что бот остаётся администратором канала, затем повтори проверку.");
      }
      throw e;
    }
    const joined = ["creator", "administrator", "member"].includes(String(member.status)) || (String(member.status) === "restricted" && member.is_member === true);
    if (!joined) throw new Error("Сначала подпишитесь на канал, затем повторите проверку.");
  }
  return { id: String(chat.id), username: `@${String(chat.username || channel.username)}` };
}

function taskPrice(reward, activations) {
  const multiplierRaw = String(process.env.TASK_PRICE_MULTIPLIER || "1.5").replace(",", ".");
  const multiplier = Number(multiplierRaw);
  const safeMultiplier = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1.5;
  return Number((Number(reward) * Number(activations) * safeMultiplier).toFixed(2));
}

function taskApprovalButtons(taskId) {
  return {
    inline_keyboard: [[
      { text: "✅ Принять", callback_data: `task:approve:${taskId}` },
      { text: "❌ Отклонить", callback_data: `task:reject:${taskId}` }
    ]]
  };
}

async function notifyTaskCreationAttempt(telegramUser, body) {
  const channel = String(body?.channel || '—').trim();
  const reward = Number(body?.reward || 0);
  const activations = Number(body?.activations || 0);
  const cost = (reward > 0 && activations > 0) ? taskPrice(reward, activations) : 0;
  const priceText = isAdmin(telegramUser?.id) ? 'БЕСПЛАТНО (админ)' : `${cost.toFixed(2)} ⭐`;
  const username = telegramUser?.username ? `@${telegramUser.username}` : 'без username';
  const text = [
    '📣 Попытка создать задание',
    '',
    `👤 Пользователь: ${username}`,
    `🆔 ID: ${String(telegramUser?.id || '—')}`,
    `📢 Канал: ${channel}`,
    `⭐ Награда: ${Number.isFinite(reward) ? reward : 0} ⭐`,
    `👥 Активации: ${Number.isFinite(activations) ? activations : 0}`,
    `💳 Стоимость: ${priceText}`
  ].join('\n');
  await notifyAdmins(text);
}

async function notifyTaskPendingAdmins(telegramUser, body, taskResult) {
  const ids = getAdminIds();
  if (!ids.length || !process.env.TELEGRAM_BOT_TOKEN) return;
  const channel = String(body?.channel || taskResult?.channel || '—').trim();
  const reward = Number(body?.reward || 0);
  const activations = Number(body?.activations || 0);
  const price = Number(taskResult?.price || taskPrice(reward, activations));
  const username = telegramUser?.username ? `@${telegramUser.username}` : 'без username';
  const taskId = String(taskResult?.id || '');
  const text = [
    '🟠 <b>Новое задание на проверку</b>',
    '',
    `👤 Пользователь: <b>${escapeHtmlTelegram(username)}</b>`,
    `🆔 ID: <code>${escapeHtmlTelegram(telegramUser?.id)}</code>`,
    `📢 Канал: <b>${escapeHtmlTelegram(channel)}</b>`,
    `⭐ Награда: <b>${Number.isFinite(reward) ? reward.toFixed(2) : '0.00'} ⭐</b>`,
    `👥 Активации: <b>${Number.isFinite(activations) ? activations : 0}</b>`,
    `💳 Стоимость: <b>${price.toFixed(2)} ⭐</b>`,
    `🧾 Заявка: <code>${escapeHtmlTelegram(taskId)}</code>`,
    '',
    'Средства уже зарезервированы. После принятия задание станет доступно пользователям.'
  ].join('\n');

  await Promise.all(ids.map(id => telegramApi('sendMessage', {
    chat_id: id,
    text,
    parse_mode: 'HTML',
    reply_markup: taskApprovalButtons(taskId)
  }).catch(e => console.error(`Task approval notify error (${id}):`, e.message))));
}

async function notifyTaskCreator(task, messageText) {
  if (!task?.created_by) return;
  await telegramApi('sendMessage', {
    chat_id: String(task.created_by),
    text: messageText,
    parse_mode: 'HTML'
  }).catch(e => console.error('Task creator notify error:', e.message));
}

async function handleTaskApprovalCallback(callback) {
  const match = String(callback?.data || '').match(/^task:(approve|reject):([0-9a-f-]{36})$/i);
  if (!match) return false;
  const adminId = String(callback?.from?.id || '');
  if (!isAdmin(adminId)) {
    await answerCallbackQuery(callback.id, 'Нет доступа.');
    return true;
  }

  const [, action, taskId] = match;
  try {
    requireDatabase();
    if (action === 'approve') {
      const preview = await pool.query(
        `SELECT id, created_by, target_username, reward::float AS reward, max_activations, price::float AS price, status
         FROM tasks WHERE id=$1 LIMIT 1`,
        [taskId]
      );
      if (!preview.rowCount) throw new Error('Задание не найдено.');
      if (preview.rows[0].status !== 'pending') throw new Error('Эта заявка уже обработана.');

      // Re-check the channel before activation so an old request cannot be approved
      // after the bot was removed or its permissions changed.
      await verifyTaskChannel(preview.rows[0].target_username);

      const client = await pool.connect();
      let task;
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT * FROM tasks WHERE id=$1 FOR UPDATE`,
          [taskId]
        );
        if (!locked.rowCount || locked.rows[0].status !== 'pending') throw new Error('Эта заявка уже обработана.');
        const updated = await client.query(
          `UPDATE tasks SET status='active' WHERE id=$1 RETURNING id, created_by, target_username, reward::float AS reward, max_activations, price::float AS price`,
          [taskId]
        );
        task = updated.rows[0];
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally {
        client.release();
      }

      await notifyTaskCreator(task,
        `✅ <b>Задание одобрено</b>\n\n` +
        `Канал: <b>${escapeHtmlTelegram(task.target_username)}</b>\n` +
        `Награда: <b>${Number(task.reward).toFixed(2)} ⭐</b>\n` +
        `Активаций: <b>${Number(task.max_activations)}</b>\n\n` +
        `Задание опубликовано и уже доступно пользователям.`
      );

      await answerCallbackQuery(callback.id, 'Задание принято.');
      await telegramApi('editMessageText', {
        chat_id: callback.message?.chat?.id,
        message_id: callback.message?.message_id,
        text: `✅ <b>Задание принято</b>\n\n${escapeHtmlTelegram(preview.rows[0].target_username)} · ${Number(preview.rows[0].reward).toFixed(2)} ⭐ · ${Number(preview.rows[0].max_activations)} активаций\nПользователь: <code>${escapeHtmlTelegram(preview.rows[0].created_by)}</code>\nСтоимость: ${Number(preview.rows[0].price).toFixed(2)} ⭐`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
      return true;
    }

    const client = await pool.connect();
    let task;
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, created_by, target_username, price::float AS price, status FROM tasks WHERE id=$1 FOR UPDATE`,
        [taskId]
      );
      if (!locked.rowCount) throw new Error('Задание не найдено.');
      if (locked.rows[0].status !== 'pending') throw new Error('Эта заявка уже обработана.');
      task = locked.rows[0];

      const refund = Number(task.price || 0);
      let balance = null;
      if (refund > 0) {
        const credited = await client.query(
          `UPDATE users SET balance=balance+$2::numeric, updated_at=NOW()
           WHERE telegram_id=$1
           RETURNING balance::float AS balance`,
          [String(task.created_by), refund]
        );
        if (!credited.rowCount) throw new Error('Создатель задания не найден, возврат невозможен.');
        balance = Number(credited.rows[0].balance);
        await client.query(
          `INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description)
           VALUES ($1,'task_refund',$2,$3,$4)`,
          [String(task.created_by), refund, balance, `Возврат за отклонённое задание ${task.id}`]
        );
      }

      await client.query(`UPDATE tasks SET status='cancelled' WHERE id=$1`, [taskId]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }

    await notifyTaskCreator(task,
      `❌ <b>Задание отклонено</b>\n\n` +
      `Канал: <b>${escapeHtmlTelegram(task.target_username)}</b>\n` +
      (Number(task.price || 0) > 0
        ? `💳 Возвращено: <b>${Number(task.price).toFixed(2)} ⭐</b> на баланс.`
        : 'Средства не списывались.')
    );

    await answerCallbackQuery(callback.id, 'Задание отклонено, средства возвращены.');
    await telegramApi('editMessageText', {
      chat_id: callback.message?.chat?.id,
      message_id: callback.message?.message_id,
      text: `❌ <b>Задание отклонено</b>\n\n${escapeHtmlTelegram(task.target_username)}\nПользователь: <code>${escapeHtmlTelegram(task.created_by)}</code>\nВозврат: ${Number(task.price || 0).toFixed(2)} ⭐`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    return true;
  } catch (e) {
    await answerCallbackQuery(callback.id, e.message || 'Не удалось обработать заявку.');
    return true;
  }
}

async function createTaskForUser(userId, body) {
  requireDatabase();
  const reward = Number(body?.reward);
  const activations = Number(body?.activations);
  if (!Number.isFinite(reward) || reward <= 0 || reward > 1_000_000_000) {
    throw new Error("Укажите награду больше 0.");
  }
  if (!Number.isInteger(activations) || activations <= 0 || activations > 1_000_000_000) {
    throw new Error("Укажите целое количество активаций больше 0.");
  }

  const channel = await verifyTaskChannel(body?.channel);
  const adminCreator = isAdmin(userId);
  const price = adminCreator ? 0 : taskPrice(reward, activations);
  const status = adminCreator ? 'active' : 'pending';
  const id = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (price > 0) {
      const debited = await client.query(
        `UPDATE users SET balance=balance-$2, updated_at=NOW()
         WHERE telegram_id=$1 AND banned=false AND balance >= $2
         RETURNING balance::float AS balance`,
        [String(userId), price]
      );
      if (!debited.rowCount) throw new Error("Недостаточно Stars для оплаты задания.");
    }

    const balanceRow = await client.query(
      `SELECT balance::float AS balance FROM users WHERE telegram_id=$1 FOR UPDATE`,
      [String(userId)]
    );
    if (!balanceRow.rowCount) throw new Error("Пользователь не найден.");
    const balance = Number(balanceRow.rows[0].balance);

    if (price > 0) {
      await client.query(
        `INSERT INTO balance_transactions (telegram_user_id,type,amount,balance_after,description)
         VALUES ($1,'task_purchase',$2,$3,$4)`,
        [String(userId), -price, balance, `Создание задания ${channel.username}`]
      );
    }

    await client.query(
      `INSERT INTO tasks (id, created_by, task_type, target_username, target_chat_id, reward, max_activations, price, status)
       VALUES ($1,$2,'channel_subscription',$3,$4,$5,$6,$7,$8)`,
      [id, String(userId), channel.username, channel.id, reward, activations, price, status]
    );

    await client.query("COMMIT");
    invalidateUserCache(userId);
    return { ok: true, id, price, balance, free: adminCreator, pending: !adminCreator, status };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

app.get("/api/tasks", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const result = await pool.query(
      `SELECT t.id, t.task_type, t.target_username, t.reward::float AS reward, t.max_activations, t.completions,
              EXISTS(SELECT 1 FROM task_completions c WHERE c.task_id=t.id AND c.telegram_user_id=$1) AS completed
       FROM tasks t WHERE t.status='active' ORDER BY t.created_at DESC`, [String(session.telegram.id)]
    );
    res.json({ tasks: result.rows });
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось загрузить задания." }); }
});

app.post("/api/tasks/:id/complete", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const taskId = String(req.params.id);
    const preview = await pool.query(`SELECT * FROM tasks WHERE id=$1 AND status='active'`, [taskId]);
    if (!preview.rowCount) throw new Error("Задание недоступно.");
    if (preview.rows[0].task_type !== "channel_subscription") throw new Error("Этот вид задания пока недоступен.");
    await verifyTaskChannel(preview.rows[0].target_username, session.telegram.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(`SELECT * FROM tasks WHERE id=$1 AND status='active' FOR UPDATE`, [taskId]);
      if (!locked.rowCount || Number(locked.rows[0].completions) >= Number(locked.rows[0].max_activations)) throw new Error("Лимит активаций задания исчерпан.");
      const inserted = await client.query(`INSERT INTO task_completions (task_id, telegram_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING task_id`, [taskId, String(session.telegram.id)]);
      if (!inserted.rowCount) throw new Error("Вы уже получили награду за это задание.");
      const balance = await creditBalance(session.telegram.id, Number(locked.rows[0].reward), client, { type: "task_reward", description: `Награда за задание ${taskId}` });
      await client.query(`UPDATE tasks SET completions=completions+1, status=CASE WHEN completions+1 >= max_activations THEN 'finished' ELSE 'active' END WHERE id=$1`, [taskId]);
      await client.query("COMMIT");
      io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance });
      res.json({ ok: true, balance });
    } catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; } finally { client.release(); }
  } catch (e) { res.status(400).json({ error: e.message || "Не удалось выполнить задание." }); }
});

app.post("/api/tasks", async (req, res) => {
  try {
    const session = await authenticatedUserFromInitData(req.headers["x-telegram-init-data"]);
    const result = await createTaskForUser(session.telegram.id, req.body || {});
    io.to(`user:${session.telegram.id}`).emit("balance_updated", { balance: result.balance });
    if (result.pending) {
      await notifyTaskPendingAdmins(session.telegram, req.body || {}, result);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось создать задание." });
  }
});

app.post("/api/admin/tasks", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const result = await createTaskForUser(admin.id, req.body || {});
    io.to(`user:${admin.id}`).emit("balance_updated", { balance: result.balance });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось создать задание." });
  }
});

// ---------------- ADMIN API ----------------
app.get("/api/admin/system", async (req, res) => {
  try {
    await requireAdminRequest(req);
    res.json({ ok: true, maintenance: maintenanceMode });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/system/maintenance", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const enabled = Boolean(req.body?.enabled);
    const result = await setMaintenanceMode(enabled, admin.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});


app.get("/api/admin/stats", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS users,
        COUNT(*) FILTER (WHERE banned=true)::int AS banned,
        COALESCE(SUM(balance),0)::float AS total_balance
      FROM users
    `);
    res.json({ ...r.rows[0], onlinePvpPlayers: state.players.size, roundStatus: state.status, roomBank: totalBank() });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    const values = [];
    let where = "";
    if (q) {
      values.push(`%${q}%`);
      where = `WHERE telegram_id ILIKE $${values.length} OR username ILIKE $${values.length} OR first_name ILIKE $${values.length}`;
    }
    values.push(limit);
    const r = await pool.query(
      `SELECT u.telegram_id, u.username, u.first_name, u.balance::float AS balance,
              u.wager_remaining::float AS wager_remaining,
              u.total_deposited::float AS total_deposited,
              u.banned, u.created_at,
              COALESCE(f.risk_score,0)::int AS risk_score,
              COALESCE(f.linked_accounts,0)::int AS linked_accounts,
              COALESCE(f.exact_device_matches,0)::int AS exact_device_matches,
              COALESCE(f.shared_ip_matches,0)::int AS shared_ip_matches
       FROM users u
       LEFT JOIN account_security_flags f ON f.telegram_user_id=u.telegram_id
       ${where ? where.replaceAll('telegram_id','u.telegram_id').replaceAll('username','u.username').replaceAll('first_name','u.first_name') : ''}
       ORDER BY u.created_at DESC LIMIT $${values.length}`,
      values
    );
    res.json({ users: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/api/admin/security/multiaccounts", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    const r = await pool.query(`
      SELECT s.fingerprint_hash,
             COUNT(DISTINCT s.telegram_user_id)::int AS accounts,
             ARRAY_AGG(DISTINCT s.telegram_user_id ORDER BY s.telegram_user_id) AS telegram_ids,
             MAX(s.last_seen_at) AS last_seen
      FROM account_security_signals s
      WHERE s.fingerprint_hash <> ''
      GROUP BY s.fingerprint_hash
      HAVING COUNT(DISTINCT s.telegram_user_id) > 1
      ORDER BY accounts DESC, last_seen DESC
      LIMIT $1`, [limit]);
    res.json({ clusters: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/api/admin/transactions", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const target = req.query.userId ? String(req.query.userId) : null;
    const r = target
      ? await pool.query(`SELECT * FROM balance_transactions WHERE telegram_user_id=$1 ORDER BY created_at DESC LIMIT 100`, [target])
      : await pool.query(`SELECT * FROM balance_transactions ORDER BY created_at DESC LIMIT 100`);
    res.json({ transactions: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

// One summary shape (total + count, breakdown "by method", recent list)
// reused across the Пополнения/Ставки/Выводы/Рефералы admin tabs, in the
// spirit of the "Статистика" screen the client asked to match.
const ADMIN_SUMMARY_METHOD_LABELS = {
  stars_topup: "Stars", balance_topup: "Stars", ton_topup: "TON / GRAM",
  pvp_bet: "PVP", upgrade_bet: "Upgrade", bounce_bet: "Отскок", plinko_bet: "Дроп", penalty_bet: "Пенальти",
  STAR: "Stars", GRAM: "GRAM", TON: "TON",
  true: "Выплачено", false: "Не выплачено"
};

app.get("/api/admin/summary/:category", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const category = String(req.params.category);
    let rows;
    if (category === "topups") {
      rows = (await pool.query(
        `SELECT t.type AS method, t.amount::float AS amount, t.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM balance_transactions t JOIN users u ON u.telegram_id=t.telegram_user_id
         WHERE t.type IN ('stars_topup','balance_topup','ton_topup') ORDER BY t.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "bets") {
      rows = (await pool.query(
        `SELECT t.type AS method, ABS(t.amount::float) AS amount, t.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM balance_transactions t JOIN users u ON u.telegram_id=t.telegram_user_id
         WHERE t.type IN ('pvp_bet','upgrade_bet','bounce_bet','plinko_bet','penalty_bet') ORDER BY t.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "withdrawals") {
      rows = (await pool.query(
        `SELECT w.currency AS method, w.amount::float AS amount, w.status, w.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM withdrawal_requests w JOIN users u ON u.telegram_id=w.telegram_user_id
         ORDER BY w.created_at DESC LIMIT 500`
      )).rows;
    } else if (category === "referrals") {
      rows = (await pool.query(
        `SELECT r.claimed AS method, r.reward_amount::float AS amount, r.created_at,
                COALESCE(NULLIF(u.username,''), u.first_name) AS name, u.username
         FROM referral_earnings r JOIN users u ON u.telegram_id=r.referrer_id
         ORDER BY r.created_at DESC LIMIT 500`
      )).rows;
    } else {
      throw new Error("Неизвестная категория статистики.");
    }

    const byMethod = {};
    let totalAmount = 0;
    for (const row of rows) {
      const key = String(row.method);
      if (!byMethod[key]) byMethod[key] = { method: ADMIN_SUMMARY_METHOD_LABELS[key] || key, count: 0, amount: 0 };
      byMethod[key].count += 1;
      byMethod[key].amount += Number(row.amount);
      totalAmount += Number(row.amount);
    }

    res.json({
      totalAmount,
      count: rows.length,
      byMethod: Object.values(byMethod),
      recent: rows.slice(0, 30).map(row => ({
        name: row.name,
        username: row.username || null,
        method: ADMIN_SUMMARY_METHOD_LABELS[String(row.method)] || String(row.method),
        status: row.status || null,
        amount: Number(row.amount),
        createdAt: row.created_at
      }))
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/admin/promos", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const r = await pool.query(
      `SELECT id, code, bonus::float AS bonus, wager::float AS wager, required_deposit::float AS required_deposit, max_uses, uses_count, active, created_by, created_at
       FROM promo_codes ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ promos: r.rows });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/promos", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const promo = await createPromoCode(admin.id, req.body?.code, req.body?.bonus, req.body?.maxUses, req.body?.wager, req.body?.requiredDeposit);
    res.json({ ok: true, promo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/admin/promos/:id/toggle", async (req, res) => {
  try {
    await requireAdminRequest(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный промокод." });
    const active = Boolean(req.body?.active);
    const r = await pool.query(
      `UPDATE promo_codes SET active=$2 WHERE id=$1 RETURNING id, code, bonus::float AS bonus, wager::float AS wager, required_deposit::float AS required_deposit, max_uses, uses_count, active, created_at`,
      [id, active]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Промокод не найден." });
    res.json({ ok: true, promo: r.rows[0] });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/users/:id/adjust-balance", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const delta = Number(req.body?.delta);
    if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: "delta должен быть целым числом и не равен 0." });
    if (Math.abs(delta) > 1_000_000_000) return res.status(400).json({ error: "Слишком большая сумма." });
    const wager = req.body?.wager === undefined || req.body?.wager === null || req.body?.wager === "" ? 0 : Number(req.body.wager);
    if (!Number.isFinite(wager) || wager < 0 || wager > 1000) return res.status(400).json({ error: "Вагер должен быть числом от 0 до 1000." });
    const balance = await adjustAdminBalance(String(req.params.id), delta, admin.id, String(req.body?.description || "Изменение баланса администратором").slice(0, 180), wager);
    io.to(`user:${String(req.params.id)}`).emit("balance_updated", { balance });
    res.json({ ok: true, balance });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.post("/api/admin/users/:id/ban", async (req, res) => {
  try {
    const admin = await requireAdminRequest(req);
    const banned = Boolean(req.body?.banned);
    const result = await setBanned(String(req.params.id), banned, admin.id);
    res.json({ ok: true, user: result });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "telegram-stars-pvp-wheel",
    status: state.status,
    players: state.players.size,
    database: !!pool,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    telegramWebhookConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET && !!process.env.APP_PUBLIC_URL,
    adminsConfigured: getAdminIds().length
  });
});

// History list: round number, winner, payout/multiplier, timestamp. Search
// by round number when ?q= is a plain number, otherwise returns the most
// recent rounds.
app.get("/api/pvp/history", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);
    const values = [];
    let where = "";
    if (q && /^\d+$/.test(q)) {
      values.push(q);
      where = `WHERE round_number::text LIKE $${values.length} || '%'`;
    }
    values.push(limit);
    const r = await pool.query(
      `SELECT round_number, id, bank, winner_id, winner_bet, payout, players, created_at
       FROM pvp_rounds ${where} ORDER BY round_number DESC LIMIT $${values.length}`,
      values
    );
    const rounds = r.rows.map(row => {
      const players = Array.isArray(row.players) ? row.players : [];
      const winner = players.find(p => p.id === row.winner_id) || null;
      const winnerBet = Number(row.winner_bet || 0);
      const payout = Number(row.payout || 0);
      return {
        roundNumber: row.round_number,
        createdAt: row.created_at,
        bank: Number(row.bank),
        winner: winner ? {
          id: winner.id,
          name: winner.name,
          avatar: winner.avatar,
          percentage: winner.percentage
        } : null,
        payout,
        multiplier: winnerBet > 0 ? Number((payout / winnerBet).toFixed(2)) : 0
      };
    });
    res.json({ rounds });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось загрузить историю." });
  }
});

// Full breakdown of one round: every participant + the provably-fair seed.
app.get("/api/pvp/history/:roundNumber", async (req, res) => {
  try {
    const roundNumber = Number(req.params.roundNumber);
    if (!Number.isInteger(roundNumber) || roundNumber <= 0) throw new Error("Некорректный номер игры.");
    const r = await pool.query(
      `SELECT round_number, id, bank, winner_id, winner_bet, payout, commission, players,
              server_seed, server_seed_hash, created_at
       FROM pvp_rounds WHERE round_number=$1`,
      [roundNumber]
    );
    if (!r.rowCount) throw new Error("Игра не найдена.");
    const row = r.rows[0];
    const players = Array.isArray(row.players) ? row.players : [];
    const winnerBet = Number(row.winner_bet || 0);
    const payout = Number(row.payout || 0);
    res.json({
      roundNumber: row.round_number,
      createdAt: row.created_at,
      bank: Number(row.bank),
      winnerId: row.winner_id,
      payout,
      multiplier: winnerBet > 0 ? Number((payout / winnerBet).toFixed(2)) : 0,
      players: players
        .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, bet: Number(p.bet || 0), percentage: p.percentage }))
        .sort((a, b) => b.bet - a.bet),
      // Provably fair: server_seed_hash was fixed before the round settled;
      // server_seed is only revealed here, afterwards, so anyone can hash it
      // themselves and confirm it matches — the seed could not have been
      // chosen after seeing the bets.
      hash: row.server_seed_hash,
      seed: row.server_seed
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Не удалось загрузить игру." });
  }
});

app.get("/api/state", (req, res) => res.json(publicState()));
app.get("*", (req, res) => {
  staticCache.send(req, res, "/index.html").then(done => { if (!done) res.sendFile(path.join(__dirname, "public", "index.html")); }, () => res.sendFile(path.join(__dirname, "public", "index.html")));
});

async function start() {
  await initDb();
  await loadIceHistory();
  await loadMaintenanceMode();
  await settleExpiredRaffles();
  setInterval(settleExpiredRaffles, 5000).unref();
  await settleTonTopups();
  setInterval(settleTonTopups, 20000).unref();

  server.listen(PORT, "0.0.0.0", async () => {
    console.log(`PVP wheel listening on ${PORT}`);
    await configureTelegramBot();
    await configureSupportBot();
    await verifyTelegramWebhook();
    setInterval(verifyTelegramWebhook, 10 * 60 * 1000).unref();
  });
}

start().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
