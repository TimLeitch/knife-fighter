'use strict';
// ============================================================
//  KAOTIC GAMING — site server
//  Accounts, sessions, per-game saves, progress, "playing now",
//  error reports and the admin dashboard API. Serves every game
//  listed in games.json.
//
//  Needs Node.js 22.13+ (built-in node:sqlite). No npm packages.
//  Run:   node server.js           (or start.cmd on Windows, or Docker)
//  Commands:
//    node server.js create-admin <username>   make (or promote) an admin account
//    node server.js backup <file.db>          write a consistent copy of the database
//  Env:
//    PORT (8088)  HOST (127.0.0.1; 0.0.0.0 in Docker)  KG_DATA_DIR (database folder)
//    TRUST_PROXY=1            believe X-Forwarded-For / X-Forwarded-Proto from a reverse proxy
//    KG_ADMIN_USER / KG_ADMIN_PASSWORD   create this admin on start if no admin exists yet
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8088;
const HOST = process.env.HOST || '127.0.0.1'; // only this machine; Docker sets 0.0.0.0
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
// player data lives OUTSIDE OneDrive: a syncing database file can be corrupted
const DATA_DIR = process.env.KG_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'KaoticGaming');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_DAYS = 30;
const EVENT_KEEP_DAYS = 60;
const now = () => Date.now();

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'kaotic.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',          -- 'player' | 'admin'
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game)
  );
  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}',          -- whatever the game reports (level, kills, ...)
    playtime_s INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    first_played INTEGER NOT NULL,
    last_played INTEGER NOT NULL,
    PRIMARY KEY (user_id, game)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_at ON events(at);
  CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    game TEXT,
    message TEXT NOT NULL,
    detail TEXT,
    user_agent TEXT,
    at INTEGER NOT NULL
  );
  -- every PayPal order the shop starts, so a payment can only ever unlock the account that started it.
  -- Kept forever (it's your sales record), even if the player's account goes away.
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,                          -- PayPal order id
    env TEXT NOT NULL,                            -- 'sandbox' (test money) or 'live' (real money)
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    product TEXT NOT NULL,
    amount TEXT NOT NULL,                         -- the price when the order was made, e.g. '0.99'
    currency TEXT NOT NULL,                       -- 'USD'
    status TEXT NOT NULL,                         -- created | pending | completed | failed | refunded | reversed
    attempt INTEGER NOT NULL DEFAULT 0,           -- capture tries (a new one after a declined card)
    capture_id TEXT UNIQUE,
    payer_email TEXT,
    payer_id TEXT,
    fee TEXT,                                     -- PayPal's fee, as PayPal reports it
    net TEXT,                                     -- what you keep
    checked_at INTEGER,                           -- last time PayPal confirmed this order's state
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
  CREATE INDEX IF NOT EXISTS orders_status ON orders(env, status, checked_at);
  -- what each player owns, per PayPal environment (so test-money sales never count once you go live).
  -- Always recomputed from the player's completed orders: a refund removes it unless another payment covers it.
  CREATE TABLE IF NOT EXISTS entitlements (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product TEXT NOT NULL,
    env TEXT NOT NULL,
    order_id TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, product, env)
  );
  -- PayPal webhook events already handled (PayPal retries and may send the same event twice)
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    at INTEGER NOT NULL
  );
`);
const q = sql => db.prepare(sql);
const S = {
  userByName: q('SELECT * FROM users WHERE username = ?'),
  userById: q('SELECT * FROM users WHERE id = ?'),
  insertUser: q('INSERT INTO users (username, pass_hash, role, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
  adminCount: q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
  touchUser: q('UPDATE users SET last_seen = ? WHERE id = ?'),
  insertSession: q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionUser: q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: q('DELETE FROM sessions WHERE user_id = ?'),
  getSave: q('SELECT data, updated_at FROM saves WHERE user_id = ? AND game = ?'),
  putSave: q(`INSERT INTO saves (user_id, game, data, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, game) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  deleteSave: q('DELETE FROM saves WHERE user_id = ? AND game = ?'),
  ensureProgress: q(`INSERT INTO progress (user_id, game, first_played, last_played) VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id, game) DO UPDATE SET last_played = excluded.last_played`),
  setSummary: q('UPDATE progress SET summary = ?, last_played = ? WHERE user_id = ? AND game = ?'),
  addPlaytime: q('UPDATE progress SET playtime_s = playtime_s + ?, last_played = ? WHERE user_id = ? AND game = ?'),
  addSession: q('UPDATE progress SET sessions = sessions + 1, last_played = ? WHERE user_id = ? AND game = ?'),
  insertEvent: q('INSERT INTO events (user_id, game, type, data, at) VALUES (?, ?, ?, ?, ?)'),
  insertError: q('INSERT INTO errors (user_id, game, message, detail, user_agent, at) VALUES (?, ?, ?, ?, ?, ?)'),
  // shop (every query is limited to one PayPal environment: sandbox or live)
  insertOrder: q('INSERT INTO orders (id, env, user_id, product, amount, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  orderById: q('SELECT * FROM orders WHERE id = ? AND env = ?'),
  orderByCapture: q('SELECT * FROM orders WHERE capture_id = ? AND env = ?'),
  setOrderStatus: q('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  bumpAttempt: q('UPDATE orders SET attempt = attempt + 1, updated_at = ? WHERE id = ?'),
  setOrderPaid: q(`UPDATE orders SET status = ?, capture_id = COALESCE(?, capture_id), payer_email = COALESCE(?, payer_email), payer_id = COALESCE(?, payer_id),
                   fee = COALESCE(?, fee), net = COALESCE(?, net), checked_at = ?, updated_at = ? WHERE id = ?`),
  markChecked: q('UPDATE orders SET checked_at = ? WHERE id = ?'),
  // status changes that must never overwrite a sale another request just settled
  startCapture: q("UPDATE orders SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'created'"),
  backToCreated: q("UPDATE orders SET status = 'created', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND capture_id IS NULL"),
  failIfOpen: q("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('created', 'pending') AND capture_id IS NULL"),
  openOrder: q("SELECT id, status FROM orders WHERE user_id = ? AND product = ? AND env = ? AND status = 'pending' LIMIT 1"),
  firstPaid: q("SELECT id FROM orders WHERE user_id = ? AND product = ? AND env = ? AND status = 'completed' ORDER BY created_at LIMIT 1"),
  entitlementsOf: q('SELECT product FROM entitlements WHERE user_id = ? AND env = ?'),
  ownsProduct: q('SELECT 1 FROM entitlements WHERE user_id = ? AND product = ? AND env = ?'),
  grant: q(`INSERT INTO entitlements (user_id, product, env, order_id, granted_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, product, env) DO UPDATE SET order_id = excluded.order_id`),
  ungrant: q('DELETE FROM entitlements WHERE user_id = ? AND product = ? AND env = ?'),
  seenWebhook: q('INSERT INTO webhook_events (id, type, at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'),
  webhookSeen: q('SELECT 1 FROM webhook_events WHERE id = ?'),
};
const entitlementsOf = userId => userId ? S.entitlementsOf.all(userId, PAYPAL.env).map(r => r.product) : [];

// ---------- passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex')); // equalizes timing for unknown usernames
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  S.insertSession.run(sha256(token), userId, now(), now() + SESSION_DAYS * 864e5);
  setCookie(res, req, 'kg_session', token, SESSION_DAYS * 86400);
}
function setCookie(res, req, name, value, maxAge) {
  const secure = isHttps(req) ? '; Secure' : '';
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`]);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).kg_session;
  if (!token) return null;
  const u = S.sessionUser.get(sha256(token), now());
  if (!u || u.disabled) return null;
  if (!u.last_seen || now() - u.last_seen > 60e3) S.touchUser.run(now(), u.id);
  return u;
}

// ---------- request helpers ----------
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
// traffic arriving through the Cloudflare tunnel carries Cloudflare's headers
const viaCloudflare = req => !!req.headers['cf-connecting-ip'];
// the entry the nearest proxy added; earlier entries come from the visitor and can be faked
const lastForwarded = req => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
// visitor IP for rate limits; proxy headers only count when they can't be faked by the visitor:
// the tunnel runs on this machine (loopback), or TRUST_PROXY says a reverse proxy sits in front
function clientIp(req) {
  const remote = req.socket.remoteAddress || '?';
  if (TRUST_PROXY || isLoopback(remote)) return req.headers['cf-connecting-ip'] || lastForwarded(req) || remote;
  return remote;
}
const isHttps = req => viaCloudflare(req) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
// /setup is only for someone sitting at the machine (not via a tunnel or proxy)
const isLocalVisit = req => isLoopback(req.socket.remoteAddress) && !viaCloudflare(req) && !req.headers['x-forwarded-for'];

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
// the shop page also loads PayPal's checkout (its script, pop-up and card fields)
// PayPal's published policy for its JavaScript SDK (developer.paypal.com/sdk/js/v5/best-practices),
// merged into this site's own. Only the shop page gets it; every other page keeps the strict one.
const PAYPAL_SRC = 'https://*.paypal.com https://*.paypalobjects.com https://*.venmo.com';
const SHOP_HEADERS = {
  'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' ${PAYPAL_SRC}; ` +
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${PAYPAL_SRC}; font-src 'self' https://fonts.gstatic.com; ` +
    `img-src 'self' data: ${PAYPAL_SRC}; connect-src 'self' ${PAYPAL_SRC}; frame-src 'self' ${PAYPAL_SRC}; child-src 'self' ${PAYPAL_SRC}; ` +
    `frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.paypal.com`,
  'Referrer-Policy': 'strict-origin-when-cross-origin', // the browser default; PayPal's popup is not given anything more
  // no Cross-Origin-Opener-Policy: PayPal's checkout popup reports back through window.opener
};
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(data);
}
const json = (res, status, obj) => send(res, status, obj);
const fail = (res, status, message) => json(res, status, { error: message });
const redirect = (res, to) => { res.writeHead(302, { Location: to, ...SEC_HEADERS }); res.end(); };

function readBody(req, limit = 300 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(Object.assign(new Error('Body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// the exact bytes of a request body (PayPal webhooks must be verified as they arrived)
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// simple rate limits: per visitor IP (sign-in / sign-up), per username (password guessing), per player (game calls)
const buckets = new Map();
function limited(k, max, windowMs) {
  const t = now();
  let b = buckets.get(k);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(k, b); }
  return ++b.n > max;
}
const rateLimited = (req, key, max, windowMs) => limited(key + '|' + clientIp(req), max, windowMs);
// is this key already at its limit? (looks without counting)
const overLimit = (k, max) => { const b = buckets.get(k); return !!b && b.reset >= now() && b.n >= max; };
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60e3).unref();

// ---------- games ----------
let gamesCache = { at: 0, list: [] };
function games() {
  if (now() - gamesCache.at < 3000) return gamesCache.list;
  try {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
    gamesCache = { at: now(), list: list.filter(g => /^[a-z0-9-]{2,40}$/.test(g.slug)) };
  } catch (e) { console.error('games.json:', e.message); }
  return gamesCache.list;
}
const gameBySlug = slug => games().find(g => g.slug === slug && g.status !== 'hidden');

// ---------- high scores ----------
// a game lists what can be ranked in games.json: "leaderboard": [{ "key": "bestLevel", "label": "Best level" }, ...]
// keys are numbers the game sends with KG.report(); only listed, plain keys are ever put into SQL
const boardMetrics = g => (Array.isArray(g.leaderboard) ? g.leaderboard : [])
  .filter(m => m && /^[A-Za-z0-9_]{1,40}$/.test(m.key)).map(m => ({ key: m.key, label: String(m.label || m.key) }));
function leaderboard(game, key, limit) {
  const metrics = boardMetrics(game);
  if (!metrics.some(m => m.key === key)) return [];
  const rows = q(`SELECT u.id AS userId, u.username, pr.summary, pr.last_played,
                         EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.product = 'supporter' AND e.env = '${PAYPAL.env}') AS supporter
                  FROM progress pr JOIN users u ON u.id = pr.user_id
                  WHERE pr.game = ? AND u.disabled = 0 AND json_extract(pr.summary, '$.${key}') IS NOT NULL
                  ORDER BY CAST(json_extract(pr.summary, '$.${key}') AS REAL) DESC, pr.last_played ASC
                  LIMIT ?`).all(game.slug, limit);
  let rank = 0, prev = null;
  return rows.map((r, i) => {
    const s = parse(r.summary) || {}, value = Number(s[key]) || 0;
    if (value !== prev) { rank = i + 1; prev = value; } // ties share a rank
    const others = {};
    for (const m of metrics) if (m.key !== key && s[m.key] != null) others[m.key] = Number(s[m.key]) || 0;
    return { rank, userId: r.userId, username: r.username, supporter: !!r.supporter, value, others, lastPlayed: r.last_played };
  });
}

// ---------- shop: the 99¢ Supporter Pack, paid through PayPal ----------
// The server sets the price and creates the PayPal order; the player approves it in PayPal's window;
// then the server captures (collects) the payment itself and checks PayPal's answer (status, amount,
// currency, which player) before anything is unlocked. The browser only ever passes an order id along.
// Facts this relies on are from PayPal's docs (Orders v2, Payments v2, Webhooks v1, JS SDK v5).
const PAYPAL = {
  env: /^live$/i.test(process.env.PAYPAL_ENV || '') ? 'live' : 'sandbox', // sandbox = test money only
  clientId: (process.env.PAYPAL_CLIENT_ID || '').trim(),
  secret: (process.env.PAYPAL_CLIENT_SECRET || '').trim(),
  webhookId: (process.env.PAYPAL_WEBHOOK_ID || '').trim(),
  // while testing in sandbox, only admins and these usernames can buy (comma separated)
  testers: new Set((process.env.PAYPAL_TESTERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)),
};
// PAYPAL_API_BASE exists only for local tests against a stand-in: sandbox mode, and this machine only
const testBase = process.env.PAYPAL_API_BASE || '';
PAYPAL.base = PAYPAL.env === 'sandbox' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(testBase) ? testBase
  : PAYPAL.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
// Real money needs the webhook: it's how refunds and chargebacks take the pack back.
const shopProblem = !PAYPAL.clientId || !PAYPAL.secret ? 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set'
  : PAYPAL.env === 'live' && !PAYPAL.webhookId ? 'PAYPAL_WEBHOOK_ID is not set (live mode needs the webhook for refunds and chargebacks)'
  : PAYPAL.webhookId && !/^[A-Za-z0-9]{1,50}$/.test(PAYPAL.webhookId) ? 'PAYPAL_WEBHOOK_ID does not look like a PayPal webhook ID' : '';
const shopEnabled = () => !shopProblem;
// who may buy right now: anyone signed in when live; only admins and testers while it's test money
const shopOpenFor = u => shopEnabled() && !!u && (PAYPAL.env === 'live' || u.role === 'admin' || PAYPAL.testers.has(u.username.toLowerCase()));
// what's for sale; the price here is the only price that counts
const PRODUCTS = {
  supporter: { name: 'Supporter Pack', description: 'Kaotic Gaming Supporter Pack: supporter badge on the high scores', price: '0.99', currency: 'USD' },
};
const ORDER_ID_RE = /^[A-Z0-9]{8,30}$/;                  // PayPal order ids are 17 characters
const DECLINES_PER_DAY = 6;                               // declined cards per player per day before the shop says "tomorrow"
const safeLog = s => String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '?').slice(0, 80); // nothing a sender controls can fake a log line
const customIdFor = (userId, product) => `kg-${userId}-${product}`; // plain characters only: PayPal echoes it on refunds too
const cents = v => Math.round(Number(v) * 100);           // compare money as whole cents, never as floats

let ppToken = { value: '', exp: 0 };
async function paypalToken() {
  if (ppToken.value && now() < ppToken.exp) return ppToken.value;
  const r = await fetch(PAYPAL.base + '/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${PAYPAL.clientId}:${PAYPAL.secret}`).toString('base64'),
               'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`PayPal sign-in failed (HTTP ${r.status}${d.error ? ', ' + d.error : ''}). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.`);
  ppToken = { value: d.access_token, exp: now() + Math.max(60, (Number(d.expires_in) || 300) - 300) * 1000 }; // renew well before it runs out
  return ppToken.value;
}
// one PayPal REST call: { ok, status, data }. Network errors and timeouts come back as status 0.
async function paypal(method, pathname, body, extraHeaders = {}, retried = false) {
  let r;
  try {
    const token = await paypalToken();
    r = await fetch(PAYPAL.base + pathname, {
      method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation', ...extraHeaders },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch (e) { return { ok: false, status: 0, data: { name: 'NETWORK', message: e.message } }; }
  if (r.status === 401 && !retried) { ppToken = { value: '', exp: 0 }; return paypal(method, pathname, body, extraHeaders, true); } // token ended early
  const data = await r.json().catch(() => ({}));
  if (!r.ok && data.debug_id) console.error(`PayPal ${method} ${pathname.replace(/[A-Z0-9]{8,}/g, '…')}: HTTP ${r.status} ${ppIssue(data)} (debug_id ${data.debug_id})`);
  return { ok: r.ok, status: r.status, data };
}
const ppIssue = d => (d && Array.isArray(d.details) && d.details[0] && d.details[0].issue) || (d && d.name) || '';
const capturing = new Set(); // player|item pairs with a capture in flight
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createPaypalOrder(user, productId) {
  const p = PRODUCTS[productId], money = { currency_code: p.currency, value: p.price };
  return paypal('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: productId,
      custom_id: customIdFor(user.id, productId),         // ties the payment to this player; checked again on capture
      invoice_id: 'KG-' + crypto.randomBytes(9).toString('hex').toUpperCase(), // unique per order; shows in the buyer's PayPal history
      description: p.description.slice(0, 127),
      amount: { ...money, breakdown: { item_total: money } }, // required when items are listed, and must add up exactly
      items: [{ name: p.name, quantity: '1', unit_amount: money, category: 'DIGITAL_GOODS' }],
    }],
    // No payment_source, so the same order works with every button (PayPal, Venmo, card). The settings
    // below are PayPal's older location for them, still accepted; sending them in both places is an error.
    application_context: { brand_name: 'Kaotic Gaming', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
  }, { 'PayPal-Request-Id': crypto.randomUUID() }); // a fresh id per purchase attempt (PayPal allows up to 38 characters)
}

// Collect the payment. The request id is tied to the order and attempt, so repeating it (a double click,
// a retry after a timeout) can never charge twice; after a declined card the attempt number moves on, so
// the buyer's new payment method gets a fresh try instead of PayPal's stored decline.
// Returns PayPal's answer, or { unknown: true } when money may have moved but PayPal couldn't tell us yet:
// the caller then keeps the order 'pending' and the re-check job or a webhook settles it. Only a definite
// refusal on the FIRST answer for this request id means nothing was charged.
async function capturePaypalOrder(order) {
  const reqId = `c${order.attempt}-${order.id}`;
  const once = () => paypal('POST', `/v2/checkout/orders/${order.id}/capture`, '{}', { 'PayPal-Request-Id': reqId });
  // a timeout, a 5xx, "previous request in progress" (409) or PayPal's rate limit (429): try again with the same id
  const unclear = x => x.status === 0 || x.status >= 500 || x.status === 409 || x.status === 429;
  let r = await once(), ambiguous = false;
  for (let tries = 0; tries < 2 && unclear(r); tries++) {
    ambiguous = true;
    await sleep(r.status === 409 || r.status === 429 ? 1500 : 300);
    r = await once();
  }
  if (r.ok) return r;
  if (ambiguous || unclear(r) || ppIssue(r.data) === 'ORDER_ALREADY_CAPTURED') {
    const g = await getPaypalOrder(order.id); // PayPal's own record of the order decides
    return g.ok ? g : { ...r, unknown: true };
  }
  return r;
}
const getPaypalOrder = id => paypal('GET', `/v2/checkout/orders/${id}`);

// Re-decide what a player owns from their completed orders, so a refund only takes the pack away
// when no other payment covers it.
function recomputeEntitlement(userId, product) {
  if (!userId) return;
  const paid = S.firstPaid.get(userId, product, PAYPAL.env);
  if (paid) S.grant.run(userId, product, PAYPAL.env, paid.id, now());
  else S.ungrant.run(userId, product, PAYPAL.env);
}
function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Read PayPal's order (after a capture, or fetched fresh) and update our records. The pack is granted
// only when the capture is COMPLETED and matches what this order sold to this player at this price.
// Returns { status } or { status, problem }; 'unknown' means PayPal's answer didn't say enough.
function settleOrder(order, d) {
  const pu = (d && Array.isArray(d.purchase_units) && d.purchase_units[0]) || {};
  const cap = (pu.payments && Array.isArray(pu.payments.captures) && pu.payments.captures[0]) || null;
  if (!d || d.id !== order.id) return { status: 'unknown', problem: 'PayPal answered about a different order' };
  if (!cap) {                                       // not collected (yet): nothing to grant
    S.markChecked.run(now(), order.id);
    return { status: order.status };
  }
  const amount = cap.amount || {}, custom = cap.custom_id || pu.custom_id;
  if (!custom || !amount.value) return { status: 'unknown', problem: 'PayPal left out the amount or player' }; // ask again with a full GET
  if (amount.currency_code !== order.currency || cents(amount.value) !== cents(order.amount) || custom !== customIdFor(order.user_id, order.product)) {
    console.error(`PayPal order ${order.id}: payment does not match the sale (got ${amount.value} ${amount.currency_code}, ${custom}); not unlocking anything.`);
    S.setOrderStatus.run('failed', now(), order.id);
    return { status: 'failed', problem: 'Payment did not match the sale' };
  }
  const status = { COMPLETED: 'completed', PENDING: 'pending', DECLINED: 'failed', FAILED: 'failed', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'refunded' }[cap.status] || 'pending';
  const breakdown = cap.seller_receivable_breakdown || {}; // not there while a payment is pending
  const fee = breakdown.paypal_fee && breakdown.paypal_fee.value, net = breakdown.net_amount && breakdown.net_amount.value;
  const wallet = (d.payment_source && d.payment_source.paypal) || {}, payer = d.payer || {};
  const keepReversed = order.status === 'reversed' && status !== 'completed'; // a chargeback stays a chargeback
  inTransaction(() => {
    S.setOrderPaid.run(keepReversed ? 'reversed' : status, cap.id || null, wallet.email_address || payer.email_address || null,
                       wallet.account_id || payer.payer_id || null, fee || null, net || null, now(), now(), order.id);
    recomputeEntitlement(order.user_id, order.product);
  });
  if (status === 'completed' && order.status !== 'completed') console.log(`Sale (${PAYPAL.env}): ${order.product} for user ${order.user_id}, PayPal order ${order.id}, ${amount.value} ${amount.currency_code}.`);
  if (status === 'refunded' && order.status !== 'refunded') console.log(`Refund (${PAYPAL.env}): PayPal order ${order.id}; Supporter Pack re-checked for user ${order.user_id}.`);
  return { status: keepReversed ? 'reversed' : status };
}
// fetch an order from PayPal and settle it (used by webhooks and the re-check job)
async function refreshOrder(order) {
  const g = await getPaypalOrder(order.id);
  order = S.orderById.get(order.id, PAYPAL.env) || order; // it may have changed while we waited for PayPal
  if (!g.ok) {
    // expired or gone without ever being collected: nothing was charged
    if (g.status === 404 && order.status === 'pending' && !order.capture_id && now() - order.created_at > 12 * 3600e3) S.failIfOpen.run(now(), order.id);
    return { status: order.status, problem: `PayPal HTTP ${g.status}` };
  }
  const collected = !!((g.data.purchase_units || [])[0] || {}).payments;
  if (!collected && order.status === 'pending') {
    // We tried to collect this earlier but couldn't reach PayPal (or the server stopped mid-way). If the buyer
    // approved it and still doesn't own the pack, finish what they asked for (PayPal allows 6 hours); otherwise drop it.
    const key = order.user_id + '|' + order.product;
    if (capturing.has(key)) return { status: 'pending' }; // a capture for this player is running right now
    capturing.add(key);
    try {
      const cur = S.orderById.get(order.id, PAYPAL.env);
      if (!cur || cur.status !== 'pending' || cur.capture_id) return { status: cur ? cur.status : 'unknown' };
      const fresh = g.data.status === 'APPROVED' && now() - cur.created_at < 5 * 3600e3 && !S.ownsProduct.get(cur.user_id, cur.product, PAYPAL.env);
      if (!fresh) { S.failIfOpen.run(now(), cur.id); return { status: 'failed' }; } // nothing was charged
      const c = await capturePaypalOrder(cur);
      if (c.ok) return settleOrder(cur, c.data);
      if (c.unknown) return { status: 'pending', problem: `PayPal HTTP ${c.status}` };
      // a definite "no": nothing was charged, and nobody can pick another way to pay from here
      S.failIfOpen.run(now(), cur.id);
      return { status: 'failed' };
    } finally { capturing.delete(key); }
  }
  return settleOrder(order, g.data);
}

// a sale we already have: ask PayPal's payment record (the authority on refunds) whether it was refunded
const CAPTURE_ID_RE = /^[A-Z0-9]{5,40}$/;
async function refreshCapture(order) {
  if (!order.capture_id || !CAPTURE_ID_RE.test(order.capture_id)) return refreshOrder(order);
  const c = await paypal('GET', `/v2/payments/captures/${order.capture_id}`);
  if (!c.ok) return { status: order.status, problem: `PayPal HTTP ${c.status}` };
  const refunded = c.data.status === 'REFUNDED' || c.data.status === 'PARTIALLY_REFUNDED'; // a failed or cancelled refund changes nothing
  inTransaction(() => {
    if (refunded && order.status === 'completed') S.setOrderStatus.run('refunded', now(), order.id);
    S.markChecked.run(now(), order.id);
    recomputeEntitlement(order.user_id, order.product);
  });
  if (refunded && order.status === 'completed') console.log(`Refund (${PAYPAL.env}): PayPal order ${order.id}; Supporter Pack re-checked for user ${order.user_id}.`);
  return { status: refunded ? 'refunded' : order.status };
}

// Every 15 minutes, re-check a few orders with PayPal: payments still pending, and recent sales (180 days,
// the dispute window) at most once a day, so refunds and chargebacks are caught even if a webhook was missed.
// force (the admin's "Re-check now"): also sales already checked today, so a refund made today shows up at once
async function recheckOrders({ force = false } = {}) {
  if (!shopEnabled()) return;
  const t = now();
  const due = q(`SELECT * FROM orders WHERE env = ? AND (status = 'pending' OR (status IN ('completed', 'refunded') AND created_at > ? AND COALESCE(checked_at, 0) < ?))
                 ORDER BY status = 'pending' DESC, COALESCE(checked_at, 0) LIMIT ?`).all(PAYPAL.env, t - 180 * 864e5, force ? t : t - 864e5, force ? 100 : 25);
  for (const o of due) {
    try { await (o.status === 'pending' ? refreshOrder(o) : refreshCapture(o)); } catch (e) { console.error(`Re-checking PayPal order ${o.id}: ${e.message}`); }
    await sleep(300);
  }
}

// PayPal webhooks: late completions of PENDING payments, declines, refunds and chargebacks.
// Each one is checked with PayPal (verify-webhook-signature) before it changes anything, and even then
// the order is re-read from PayPal rather than trusting the event's own details.
async function handlePaypalWebhook(req, res) {
  if (!shopEnabled() || !PAYPAL.webhookId) return fail(res, 404, 'Webhooks are not set up.');
  if (rateLimited(req, 'paypal-webhook', 120, 60e3)) return fail(res, 429, 'Slow down.');
  const raw = await readRaw(req, 64 * 1024);
  const event = parse(raw);
  if (!event || typeof event !== 'object' || typeof event.event_type !== 'string' || typeof event.id !== 'string') return fail(res, 400, 'Not a PayPal event.');
  const type = event.event_type, r = event.resource && typeof event.resource === 'object' ? event.resource : {};
  // Which of OUR orders is this about? Worked out locally first: anything else is answered without bothering PayPal.
  const links = Array.isArray(r.links) ? r.links : [];
  const upHref = String((links.find(l => l && l.rel === 'up') || {}).href || '');
  // a capture's "up" link is its order; a refund's "up" link is the capture it refunds
  const captureId = /\/v2\/payments\/captures\/[A-Z0-9]+$/.test(upHref) ? upHref.split('/').pop() : String(r.id || '');
  const related = r.supplementary_data && r.supplementary_data.related_ids;
  const orderId = (related && related.order_id) || (/\/v2\/checkout\/orders\/[A-Z0-9]+$/.test(upHref) ? upHref.split('/').pop() : '');
  const order = (ORDER_ID_RE.test(String(orderId)) && S.orderById.get(orderId, PAYPAL.env)) || (CAPTURE_ID_RE.test(captureId) && S.orderByCapture.get(captureId, PAYPAL.env));
  if (!order || !/^PAYMENT\.CAPTURE\.(COMPLETED|PENDING|DENIED|DECLINED|REFUNDED|REVERSED)$/.test(type)) return json(res, 200, { ok: true, note: 'nothing to do' });
  // PayPal's signature headers, in the shapes PayPal's docs give them
  const hd = name => String(req.headers[name] || '');
  if (!/^[A-Za-z0-9]{1,100}$/.test(hd('paypal-auth-algo')) || !/^https:\/\/api(-m)?(\.sandbox)?\.paypal\.com\/[^\s"\\]{1,450}$/.test(hd('paypal-cert-url'))
      || !/^[\w.:-]{1,50}$/.test(hd('paypal-transmission-id')) || !/^[A-Za-z0-9+/=_-]{1,500}$/.test(hd('paypal-transmission-sig'))
      || !/^[\w.:+-]{1,100}$/.test(hd('paypal-transmission-time'))) return fail(res, 400, 'Not signed.');
  const h = name => JSON.stringify(hd(name));
  // the event goes back to PayPal byte-for-byte as it arrived (re-serialising it can break verification)
  const check = await paypal('POST', '/v1/notifications/verify-webhook-signature',
    `{"auth_algo":${h('paypal-auth-algo')},"cert_url":${h('paypal-cert-url')},"transmission_id":${h('paypal-transmission-id')},` +
    `"transmission_sig":${h('paypal-transmission-sig')},"transmission_time":${h('paypal-transmission-time')},"webhook_id":${JSON.stringify(PAYPAL.webhookId)},"webhook_event":${raw}}`);
  if (!check.ok && check.status !== 400) return fail(res, 503, 'Could not reach PayPal; try again.'); // PayPal resends for 3 days
  if (!check.ok || check.data.verification_status !== 'SUCCESS') {
    console.error(`PayPal webhook ${safeLog(event.id)} (${safeLog(type)}) failed verification; ignored.`);
    return fail(res, 400, 'Not verified.');
  }
  if (S.webhookSeen.get(String(event.id).slice(0, 100))) return json(res, 200, { ok: true, note: 'already handled' });
  if (type === 'PAYMENT.CAPTURE.REVERSED') {
    // a chargeback or reversal: PayPal took the money back
    inTransaction(() => { S.setOrderStatus.run('reversed', now(), order.id); recomputeEntitlement(order.user_id, order.product); });
    console.log(`PayPal reversal (${PAYPAL.env}) for order ${order.id}; Supporter Pack re-checked for user ${order.user_id}.`);
  } else {
    // PayPal's current word decides: the order for completions and declines, the payment record for refunds
    const s = await (type === 'PAYMENT.CAPTURE.REFUNDED' ? refreshCapture(order) : refreshOrder(order));
    if (s.problem) return fail(res, 503, 'Could not read the order from PayPal.'); // PayPal resends it later
  }
  S.seenWebhook.run(String(event.id).slice(0, 100), String(type).slice(0, 100), now());
  return json(res, 200, { ok: true });
}

// ---------- "playing now" (in memory; it's only about the last minute) ----------
const presence = new Map(); // userId -> { game, status, at, since }
const ONLINE_MS = 60e3;
function beat(user, game, status, away) {
  const t = now(), p = presence.get(user.id);
  S.ensureProgress.run(user.id, game, t, t);
  // count play time only between consecutive heartbeats in the same game
  if (p && p.game === game && !p.away && t - p.at < 45e3) S.addPlaytime.run(Math.round((t - p.at) / 1000), t, user.id, game);
  presence.set(user.id, { game, status: String(status || '').slice(0, 80), at: t, since: p && p.game === game ? p.since : t, away: !!away });
}

// ---------- validation ----------
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
function checkNewAccount(username, password) {
  if (!USERNAME_RE.test(username || '')) return 'Usernames are 3–20 letters, numbers or underscores.';
  if (typeof password !== 'string' || password.length < 8) return 'Passwords need at least 8 characters.';
  if (password.length > 128) return 'Passwords can be at most 128 characters.';
  return null;
}
const publicUser = u => u && { id: u.id, username: u.username, role: u.role };
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const decodePath = s => { try { return decodeURIComponent(s); } catch (e) { throw Object.assign(new Error('Bad address.'), { status: 400 }); } };

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache', ...extraHeaders });
  });
}
// resolve a path inside a folder, refusing anything that escapes it
function inside(base, rel) {
  const full = path.resolve(base, '.' + path.sep + rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

// serve a game page with the site's player info and SDK injected before the game's own code
function serveGame(req, res, game, user) {
  const entry = path.resolve(ROOT, game.entry);
  fs.readFile(entry, 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Game file missing: ' + game.entry, 'text/plain; charset=utf-8');
    const save = S.getSave.get(user.id, game.slug);
    const boot = { game: game.slug, title: game.title, user: publicUser(user), save: save ? parse(save.data) : null,
                   entitlements: entitlementsOf(user.id), shopOpen: shopOpenFor(user) };
    const inject = `<script>window.KG_BOOT=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script><script src="/sdk.js"></script>`;
    const i = html.search(/<script[\s>]/i);
    const page = i >= 0 ? html.slice(0, i) + inject + html.slice(i) : html + inject;
    send(res, 200, page, 'text/html; charset=utf-8');
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method;

  // health check for Docker / uptime monitors: is the server up and the database readable?
  if (p === '/healthz') {
    try { q('SELECT 1').get(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 503, { ok: false }); }
  }

  // PayPal's server calls this one, so it can't carry X-KG; it's verified with PayPal instead
  if (p === '/api/paypal/webhook' && method === 'POST') return handlePaypalWebhook(req, res);

  // state-changing API calls must carry X-KG (a cross-site form or link can't add it)
  if (p.startsWith('/api/') && method !== 'GET' && req.headers['x-kg'] !== '1') return fail(res, 403, 'Missing request header.');

  // ----- pages -----
  if (method === 'GET' && !p.startsWith('/api/')) {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/login') return serveFile(res, path.join(PUBLIC, 'login.html'));
    if (p === '/scores') return serveFile(res, path.join(PUBLIC, 'scores.html'));
    // the shop page is the only page allowed to load PayPal's checkout
    if (p === '/shop') return serveFile(res, path.join(PUBLIC, 'shop.html'), SHOP_HEADERS);
    if (p === '/shop.html') return redirect(res, '/shop' + url.search); // the page only works with its own headers
    if (p === '/admin') {
      const u = currentUser(req);
      if (!u) return redirect(res, '/login?next=/admin');
      if (u.role !== 'admin') return send(res, 403, 'Admins only.', 'text/plain; charset=utf-8');
      return serveFile(res, path.join(PUBLIC, 'admin.html'));
    }
    if (p === '/setup') {
      if (S.adminCount.get().n > 0) return redirect(res, '/login');
      if (!isLocalVisit(req)) return send(res, 403, 'Setup can only be done on the computer running the site.', 'text/plain; charset=utf-8');
      return serveFile(res, path.join(PUBLIC, 'setup.html'));
    }
    const play = p.match(/^\/play\/([a-z0-9-]+)\/?(.*)$/);
    if (play) {
      const game = gameBySlug(play[1]);
      if (!game) return send(res, 404, 'No such game.', 'text/plain; charset=utf-8');
      const user = currentUser(req);
      if (!user) return redirect(res, '/login?next=' + encodeURIComponent('/play/' + game.slug));
      if (!play[2]) return serveGame(req, res, game, user);
      // extra files for multi-file games live in the game's "assets" folder
      if (!game.assets) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      const f = inside(path.resolve(ROOT, game.assets), decodePath(play[2]));
      return f ? serveFile(res, f) : send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    const f = inside(PUBLIC, decodePath(p));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f);
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  // ----- public API -----
  if (p === '/api/me' && method === 'GET') {
    const u = currentUser(req);
    return json(res, 200, { user: publicUser(u), entitlements: entitlementsOf(u && u.id), needsSetup: S.adminCount.get().n === 0 && isLocalVisit(req),
                            shop: shopEnabled() && (PAYPAL.env === 'live' || shopOpenFor(u)) }); // whether to show the "Support" link
  }
  if (p === '/api/games' && method === 'GET') {
    const u = currentUser(req);
    return json(res, 200, games().filter(g => g.status !== 'hidden').map(g => {
      const pr = u && q('SELECT summary, playtime_s, last_played FROM progress WHERE user_id = ? AND game = ?').get(u.id, g.slug);
      const playing = [...presence.values()].filter(v => v.game === g.slug && now() - v.at < ONLINE_MS && !v.away).length;
      const metrics = boardMetrics(g);
      const top = metrics.length ? leaderboard(g, metrics[0].key, 1)[0] : null;
      return { slug: g.slug, title: g.title, tagline: g.tagline || '', description: g.description || '', color: g.color || '#d9a93a', status: g.status || 'live', playingNow: playing,
               mine: pr ? { summary: parse(pr.summary) || {}, playtime: pr.playtime_s, lastPlayed: pr.last_played } : null,
               leaderboard: metrics, top: top ? { username: top.username, supporter: top.supporter && PAYPAL.env === 'live', value: top.value, label: metrics[0].label } : null };
    }));
  }
  // public high scores: GET /api/leaderboard/<game>?by=<metric>
  const lb = p.match(/^\/api\/leaderboard\/([a-z0-9-]+)$/);
  if (lb && method === 'GET') {
    const game = gameBySlug(lb[1]);
    const metrics = game ? boardMetrics(game) : [];
    if (!metrics.length) return fail(res, 404, 'This game has no high scores.');
    const by = metrics.find(m => m.key === url.searchParams.get('by')) || metrics[0];
    const rows = leaderboard(game, by.key, 100);
    const u = currentUser(req);
    let me = null;
    if (u) {
      const mine = rows.find(r => r.userId === u.id);
      if (mine) me = { rank: mine.rank, value: mine.value };
      else {
        const pr = q('SELECT summary FROM progress WHERE user_id = ? AND game = ?').get(u.id, game.slug);
        const v = pr && Number((parse(pr.summary) || {})[by.key]);
        if (Number.isFinite(v)) me = { value: v, rank: 1 + q(`SELECT COUNT(*) AS n FROM progress pr JOIN users u ON u.id = pr.user_id
            WHERE pr.game = ? AND u.disabled = 0 AND CAST(json_extract(pr.summary, '$.${by.key}') AS REAL) > ?`).get(game.slug, v).n };
      }
    }
    // test-money (sandbox) badges are only shown to the buyer themselves
    return json(res, 200, { game: game.slug, title: game.title, metrics, by: by.key,
      rows: rows.map(({ userId, ...r }) => ({ ...r, supporter: r.supporter && (PAYPAL.env === 'live' || (!!u && userId === u.id)), isMe: !!u && userId === u.id })), me });
  }
  if (p === '/api/register' && method === 'POST') {
    if (rateLimited(req, 'register', 5, 10 * 60e3)) return fail(res, 429, 'Too many new accounts from here. Try again in a few minutes.');
    const { username, password } = await readBody(req);
    const bad = checkNewAccount(username, password);
    if (bad) return fail(res, 400, bad);
    if (S.userByName.get(username)) return fail(res, 409, 'That username is taken.');
    const r = S.insertUser.run(username, hashPassword(password), 'player', now(), now());
    startSession(res, req, Number(r.lastInsertRowid));
    return json(res, 200, { user: publicUser(S.userById.get(Number(r.lastInsertRowid))) });
  }
  if (p === '/api/login' && method === 'POST') {
    if (rateLimited(req, 'login', 10, 5 * 60e3)) return fail(res, 429, 'Too many sign-in attempts. Wait a few minutes and try again.');
    const { username, password } = await readBody(req);
    // guessing one account's password from many IPs
    if (typeof username === 'string' && limited('login-user|' + username.toLowerCase().slice(0, 40), 20, 15 * 60e3))
      return fail(res, 429, 'Too many sign-in attempts for this account. Wait a few minutes and try again.');
    const u = typeof username === 'string' ? S.userByName.get(username) : null;
    const ok = checkPassword(String(password || ''), u ? u.pass_hash : DUMMY_HASH) && !!u;
    if (!ok) return fail(res, 401, 'Wrong username or password.');
    if (u.disabled) return fail(res, 403, 'This account has been turned off. Contact the site owner.');
    startSession(res, req, u.id);
    S.touchUser.run(now(), u.id);
    return json(res, 200, { user: publicUser(u) });
  }
  if (p === '/api/logout' && method === 'POST') {
    const token = cookies(req).kg_session;
    if (token) S.deleteSession.run(sha256(token));
    setCookie(res, req, 'kg_session', '', 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/setup' && method === 'POST') {
    if (S.adminCount.get().n > 0) return fail(res, 409, 'An admin already exists.');
    if (!isLocalVisit(req)) return fail(res, 403, 'Setup can only be done on the computer running the site.');
    const { username, password } = await readBody(req);
    const bad = checkNewAccount(username, password);
    if (bad) return fail(res, 400, bad);
    if (S.userByName.get(username)) return fail(res, 409, 'That username is taken.');
    const r = S.insertUser.run(username, hashPassword(password), 'admin', now(), now());
    startSession(res, req, Number(r.lastInsertRowid));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/error' && method === 'POST') {
    // only game pages report errors, and those need a signed-in player
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'Sign in first.');
    if (limited('error|' + u.id, 20, 60 * 60e3)) return json(res, 200, { ok: true });
    const b = await readBody(req, 16 * 1024);
    S.insertError.run(u.id, typeof b.game === 'string' ? b.game.slice(0, 40) : null, String(b.message || 'Unknown error').slice(0, 500),
                      String(b.detail || '').slice(0, 2000), String(req.headers['user-agent'] || '').slice(0, 300), now());
    return json(res, 200, { ok: true });
  }

  // ----- shop (the 99¢ Supporter Pack through PayPal) -----
  if (p === '/api/shop' && method === 'GET') {
    const u = currentUser(req);
    // a payment PayPal left PENDING: ask PayPal again (at most once a minute per player)
    if (u && shopEnabled() && !limited('shop-pending|' + u.id, 1, 60e3)) {
      for (const o of q("SELECT * FROM orders WHERE user_id = ? AND env = ? AND status = 'pending'").all(u.id, PAYPAL.env)) {
        try { await refreshOrder(o); } catch (e) { console.error(`Re-checking PayPal order ${o.id}: ${e.message}`); }
      }
    }
    const owned = entitlementsOf(u && u.id), open = shopOpenFor(u);
    return json(res, 200, {
      // while it's test money, the shop only shows itself to admins and testers
      enabled: shopEnabled() && (PAYPAL.env === 'live' || open), open, mode: shopEnabled() ? PAYPAL.env : null,
      userId: u ? u.id : null, // the game checks this answer is about the player it's running as
      clientId: open ? PAYPAL.clientId : null, // public by design: PayPal's buttons need it
      products: Object.entries(PRODUCTS).map(([id, pr]) => ({ id, name: pr.name, price: pr.price, currency: pr.currency, owned: owned.includes(id) })),
      owned,
    });
  }
  const shopGate = u => !u ? [401, 'Sign in first.'] : !shopEnabled() ? [503, 'Purchases aren’t switched on yet.']
    : !shopOpenFor(u) ? [403, 'The shop is in test mode: only testers can buy right now.'] : null;
  if (p === '/api/shop/order' && method === 'POST') {
    const u = currentUser(req), gate = shopGate(u);
    if (gate) return fail(res, ...gate);
    // per player, per address and for the whole site: stops scripted accounts from using the checkout to test cards
    if (limited('shop-order|' + u.id, 10, 10 * 60e3) || rateLimited(req, 'shop-order', 20, 10 * 60e3) || limited('shop-order-all', 150, 10 * 60e3))
      return fail(res, 429, 'Too many tries. Wait a few minutes and try again.');
    if (overLimit('shop-declines|' + u.id, DECLINES_PER_DAY)) return fail(res, 429, 'Too many declined payments today. Please try again tomorrow.');
    const { product } = await readBody(req, 4 * 1024);
    if (typeof product !== 'string' || !Object.hasOwn(PRODUCTS, product)) return fail(res, 400, 'No such item.');
    if (S.ownsProduct.get(u.id, product, PAYPAL.env)) return json(res, 409, { code: 'owned', error: 'You already have this.' });
    if (S.openOrder.get(u.id, product, PAYPAL.env))
      return json(res, 409, { code: 'pending', error: 'Your earlier payment is still being processed by PayPal. Your pack unlocks as soon as it clears.' });
    const r = await createPaypalOrder(u, product);
    if (!r.ok || !ORDER_ID_RE.test(String(r.data.id || ''))) {
      console.error(`PayPal create order failed: HTTP ${r.status} ${ppIssue(r.data)}`);
      return fail(res, 502, 'PayPal couldn’t start the payment. Please try again in a moment.');
    }
    S.insertOrder.run(r.data.id, PAYPAL.env, u.id, product, PRODUCTS[product].price, PRODUCTS[product].currency, 'created', now(), now());
    return json(res, 200, { id: r.data.id });
  }
  if (p === '/api/shop/capture' && method === 'POST') {
    const u = currentUser(req), gate = shopGate(u);
    if (gate) return fail(res, ...gate);
    if (limited('shop-capture|' + u.id, 30, 10 * 60e3) || rateLimited(req, 'shop-capture', 60, 10 * 60e3)) return fail(res, 429, 'Too many tries. Wait a few minutes and try again.');
    const { orderId } = await readBody(req, 4 * 1024);
    const order = typeof orderId === 'string' && ORDER_ID_RE.test(orderId) ? S.orderById.get(orderId, PAYPAL.env) : null;
    if (!order || order.user_id !== u.id) return fail(res, 404, 'No such order.'); // only the player who started it can finish it
    if (order.status === 'completed') return json(res, 200, { status: 'completed', owned: entitlementsOf(u.id) });
    if (order.status === 'refunded' || order.status === 'reversed') return fail(res, 409, 'This payment was refunded.');
    if (order.status === 'failed') return fail(res, 409, 'This payment didn’t go through, so you have not been charged. Please start again.');
    // one capture at a time per player and item: two tabs approved at once can't both be charged
    const key = u.id + '|' + order.product;
    if (capturing.has(key)) return json(res, 409, { code: 'busy', error: 'Another payment of yours is finishing right now. Give it a moment.' });
    capturing.add(key);
    try {
      // already own it (bought in another tab): don't take a second payment; this approval just expires
      if (S.ownsProduct.get(u.id, order.product, PAYPAL.env)) {
        S.failIfOpen.run(now(), order.id);
        return json(res, 200, { status: 'completed', owned: entitlementsOf(u.id), note: 'Already yours: this second payment was not taken.' });
      }
      const other = S.openOrder.get(u.id, order.product, PAYPAL.env);
      if (other && other.id !== order.id) return json(res, 409, { code: 'pending', error: 'Your earlier payment is still being processed by PayPal.' });
      if (overLimit('shop-declines|' + u.id, DECLINES_PER_DAY)) return fail(res, 429, 'Too many declined payments today. Please try again tomorrow.');
      // marked in progress BEFORE asking PayPal: if the server stops mid-capture, the re-check job still finds it
      S.startCapture.run(now(), order.id);
      const cur = { ...order, status: 'pending' };
      const r = await capturePaypalOrder(cur);
      if (!r.ok) {
        // money may have moved but PayPal couldn't tell us: kept 'pending' and settled in the background
        if (r.unknown) return json(res, 200, { status: 'pending', owned: entitlementsOf(u.id) });
        // A definite "no" on PayPal's first answer: no money moved. The next try gets a fresh request id
        // (PayPal may replay an answer to the same id); only unclear outcomes reuse an id, which prevents double charges.
        const issue = ppIssue(r.data);
        if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_ACTION_REQUIRED' || issue === 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING') {
          limited('shop-declines|' + u.id, DECLINES_PER_DAY, 24 * 3600e3);
          if (order.attempt < 3) { // the buyer picks another way to pay (PayPal's buttons restart)
            S.backToCreated.run(now(), order.id);
            return json(res, 402, { restart: true, error: 'That payment method was declined. Please choose another one.' });
          }
          S.failIfOpen.run(now(), order.id);
          return fail(res, 402, 'That payment was declined several times, so it was stopped. You have not been charged.');
        }
        if (issue === 'ORDER_NOT_APPROVED') { S.backToCreated.run(now(), order.id); return fail(res, 409, 'The payment wasn’t approved in PayPal yet.'); }
        // anything else is a final "no" for this order (refused, blocked, expired…): nothing was charged
        S.failIfOpen.run(now(), order.id);
        console.error(`PayPal capture refused for order ${order.id}: HTTP ${r.status} ${safeLog(issue)}`);
        return fail(res, 402, 'PayPal didn’t accept this payment, so you have not been charged. Please try again, or use another payment method.');
      }
      let result = settleOrder(cur, r.data);
      if (result.status === 'unknown') { const g = await getPaypalOrder(order.id); if (g.ok) result = settleOrder(S.orderById.get(order.id, PAYPAL.env), g.data); }
      if (result.status === 'failed') return fail(res, 402, 'PayPal didn’t complete the payment, so you have not been given the pack.');
      // accepted but not collected yet (or PayPal's answer was incomplete): stays 'pending' until it settles
      if (result.status !== 'completed' && result.status !== 'refunded' && result.status !== 'reversed') result = { status: 'pending' };
      return json(res, 200, { status: result.status, owned: entitlementsOf(u.id) });
    } finally { capturing.delete(key); }
  }

  // ----- signed-in player API (per game) -----
  const gm = p.match(/^\/api\/(save|event|heartbeat|report)\/([a-z0-9-]+)$/);
  if (gm) {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'Sign in again to keep saving.');
    const game = gameBySlug(gm[2]);
    if (!game) return fail(res, 404, 'No such game.');
    // plenty for a real game (saves and events come in bursts), stops a script filling the disk
    if (method !== 'GET' && limited('game|' + u.id, 240, 60e3)) return fail(res, 429, 'Slow down a little.');
    const t = now();
    if (gm[1] === 'save') {
      if (method === 'GET') { const s = S.getSave.get(u.id, game.slug); return json(res, 200, { data: s ? parse(s.data) : null, updatedAt: s ? s.updated_at : null }); }
      if (method === 'PUT') {
        const b = await readBody(req, 260 * 1024);
        if (b.data === null) S.deleteSave.run(u.id, game.slug);
        else S.putSave.run(u.id, game.slug, JSON.stringify(b.data ?? null), t);
        S.ensureProgress.run(u.id, game.slug, t, t);
        return json(res, 200, { ok: true, updatedAt: t });
      }
    }
    if (method !== 'POST') return fail(res, 405, 'Method not allowed.');
    const b = await readBody(req, 32 * 1024);
    if (gm[1] === 'heartbeat') { beat(u, game.slug, b.status, b.away); return json(res, 200, { ok: true }); }
    if (gm[1] === 'report') {
      S.ensureProgress.run(u.id, game.slug, t, t);
      S.setSummary.run(JSON.stringify(b.summary && typeof b.summary === 'object' ? b.summary : {}).slice(0, 8000), t, u.id, game.slug);
      return json(res, 200, { ok: true });
    }
    if (gm[1] === 'event') {
      const type = String(b.type || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
      if (!type) return fail(res, 400, 'Event type required.');
      S.ensureProgress.run(u.id, game.slug, t, t);
      if (type === 'session_start') S.addSession.run(t, u.id, game.slug);
      S.insertEvent.run(u.id, game.slug, type, b.data ? JSON.stringify(b.data).slice(0, 4000) : null, t);
      return json(res, 200, { ok: true });
    }
  }

  // ----- admin API -----
  if (p.startsWith('/api/admin/')) {
    const me = currentUser(req);
    if (!me || me.role !== 'admin') return fail(res, 403, 'Admins only.');
    const t = now(), day = 864e5;
    const name = id => { const u = S.userById.get(id); return u ? u.username : '(deleted)'; };
    const gameTitle = slug => (games().find(g => g.slug === slug) || {}).title || slug;

    if (p === '/api/admin/overview' && method === 'GET') {
      const playingNow = [...presence.entries()].filter(([, v]) => t - v.at < ONLINE_MS)
        .map(([uid, v]) => ({ userId: uid, username: name(uid), game: v.game, gameTitle: gameTitle(v.game), status: v.status, away: v.away, since: v.since }))
        .sort((a, b) => a.since - b.since);
      return json(res, 200, {
        players: q('SELECT COUNT(*) AS n FROM users').get().n,
        newToday: q('SELECT COUNT(*) AS n FROM users WHERE created_at > ?').get(t - day).n,
        active24h: q('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?').get(t - day).n,
        sessions24h: q("SELECT COUNT(*) AS n FROM events WHERE type = 'session_start' AND at > ?").get(t - day).n,
        errors24h: q('SELECT COUNT(*) AS n FROM errors WHERE at > ?').get(t - day).n,
        playingNow,
        games: games().map(g => ({
          slug: g.slug, title: g.title, status: g.status || 'live',
          players: q('SELECT COUNT(*) AS n FROM progress WHERE game = ?').get(g.slug).n,
          active7d: q('SELECT COUNT(*) AS n FROM progress WHERE game = ? AND last_played > ?').get(g.slug, t - 7 * day).n,
          playtime: q('SELECT COALESCE(SUM(playtime_s), 0) AS n FROM progress WHERE game = ?').get(g.slug).n,
          sessions: q('SELECT COALESCE(SUM(sessions), 0) AS n FROM progress WHERE game = ?').get(g.slug).n,
          playingNow: playingNow.filter(x => x.game === g.slug && !x.away).length,
        })),
        recent: q('SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.at DESC LIMIT 40').all()
          .map(e => ({ ...e, data: parse(e.data), gameTitle: gameTitle(e.game) })),
      });
    }
    if (p === '/api/admin/players' && method === 'GET') {
      const rows = q(`SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_seen,
                        COUNT(pr.game) AS games, COALESCE(SUM(pr.playtime_s), 0) AS playtime, MAX(pr.last_played) AS last_played
                      FROM users u LEFT JOIN progress pr ON pr.user_id = u.id GROUP BY u.id ORDER BY COALESCE(u.last_seen, u.created_at) DESC`).all();
      return json(res, 200, rows.map(r => ({ ...r, online: presence.has(r.id) && t - presence.get(r.id).at < ONLINE_MS })));
    }
    const pm = p.match(/^\/api\/admin\/player\/(\d+)$/);
    if (pm && method === 'GET') {
      const u = S.userById.get(Number(pm[1]));
      if (!u) return fail(res, 404, 'No such player.');
      const pres = presence.get(u.id);
      return json(res, 200, {
        user: { id: u.id, username: u.username, role: u.role, disabled: u.disabled, created_at: u.created_at, last_seen: u.last_seen },
        now: pres && t - pres.at < ONLINE_MS ? { ...pres, gameTitle: gameTitle(pres.game) } : null,
        games: q('SELECT * FROM progress WHERE user_id = ? ORDER BY last_played DESC').all(u.id)
          .map(r => ({ ...r, summary: parse(r.summary) || {}, title: gameTitle(r.game) })),
        events: q('SELECT * FROM events WHERE user_id = ? ORDER BY at DESC LIMIT 60').all(u.id).map(e => ({ ...e, data: parse(e.data), gameTitle: gameTitle(e.game) })),
      });
    }
    const gmA = p.match(/^\/api\/admin\/game\/([a-z0-9-]+)$/);
    if (gmA && method === 'GET') {
      return json(res, 200, {
        slug: gmA[1], title: gameTitle(gmA[1]),
        players: q(`SELECT pr.*, u.username FROM progress pr JOIN users u ON u.id = pr.user_id WHERE pr.game = ? ORDER BY pr.last_played DESC`).all(gmA[1])
          .map(r => ({ ...r, summary: parse(r.summary) || {}, online: presence.has(r.user_id) && presence.get(r.user_id).game === gmA[1] && t - presence.get(r.user_id).at < ONLINE_MS })),
      });
    }
    if (p === '/api/admin/purchases' && method === 'GET') {
      // only the current mode's sales (test money never mixes with real money); checkouts never paid are left out
      const orders = q(`SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
                        WHERE o.env = ? AND o.status != 'created' ORDER BY o.created_at DESC LIMIT 500`).all(PAYPAL.env)
        .map(o => ({ ...o, productName: (PRODUCTS[o.product] || {}).name || o.product }));
      const done = q(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS REAL)), 0) AS gross, COALESCE(SUM(CAST(fee AS REAL)), 0) AS fees,
                        COALESCE(SUM(CAST(net AS REAL)), 0) AS net FROM orders WHERE env = ? AND status = 'completed'`).get(PAYPAL.env);
      return json(res, 200, { mode: shopEnabled() ? PAYPAL.env : null, problem: shopProblem || null, orders,
        totals: { count: done.n, gross: done.gross, fees: done.fees, net: done.net,
                  refunded: q("SELECT COUNT(*) AS n FROM orders WHERE env = ? AND status IN ('refunded', 'reversed')").get(PAYPAL.env).n } });
    }
    if (p === '/api/admin/shop/recheck' && method === 'POST') {
      if (!shopEnabled()) return fail(res, 409, 'The shop is off: ' + shopProblem + '.');
      if (limited('shop-recheck-admin', 6, 60e3)) return fail(res, 429, 'Give it a minute.');
      await recheckOrders({ force: true });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/errors' && method === 'GET') {
      return json(res, 200, q('SELECT e.*, u.username FROM errors e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.at DESC LIMIT 200').all());
    }
    const um = p.match(/^\/api\/admin\/user\/(\d+)$/);
    if (um && method === 'POST') {
      const u = S.userById.get(Number(um[1]));
      if (!u) return fail(res, 404, 'No such player.');
      const b = await readBody(req);
      if (u.id === me.id && (b.disabled || b.role === 'player')) return fail(res, 400, "You can't turn off or demote your own admin account.");
      if (typeof b.disabled === 'boolean') { q('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, u.id); if (b.disabled) S.deleteUserSessions.run(u.id); }
      if (b.role === 'admin' || b.role === 'player') q('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
      let tempPassword = null;
      if (b.resetPassword) {
        tempPassword = crypto.randomBytes(6).toString('base64url');
        q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(tempPassword), u.id);
        S.deleteUserSessions.run(u.id);
      }
      return json(res, 200, { ok: true, tempPassword });
    }
    return fail(res, 404, 'Unknown admin request.');
  }

  // signed-in player changing their own password
  if (p === '/api/password' && method === 'POST') {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'Sign in first.');
    if (rateLimited(req, 'password', 10, 10 * 60e3)) return fail(res, 429, 'Too many attempts. Try again later.');
    const { current, next } = await readBody(req);
    if (!checkPassword(String(current || ''), u.pass_hash)) return fail(res, 401, 'Your current password is wrong.');
    const bad = checkNewAccount(u.username, next);
    if (bad) return fail(res, 400, bad);
    q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    // sign out everywhere else (a stolen session stops working), keep this browser signed in
    S.deleteUserSessions.run(u.id);
    startSession(res, req, u.id);
    return json(res, 200, { ok: true });
  }

  return fail(res, 404, 'Not found.');
}

// ---------- housekeeping ----------
function prune() {
  const t = now();
  q('DELETE FROM sessions WHERE expires_at < ?').run(t);
  q('DELETE FROM events WHERE at < ?').run(t - EVENT_KEEP_DAYS * 864e5);
  q('DELETE FROM errors WHERE at < ?').run(t - EVENT_KEEP_DAYS * 864e5);
  q("DELETE FROM orders WHERE status = 'created' AND created_at < ?").run(t - 30 * 864e5); // checkouts never paid
  q('DELETE FROM webhook_events WHERE at < ?').run(t - 90 * 864e5);
  for (const [id, v] of presence) if (t - v.at > 10 * 60e3) presence.delete(id);
}
prune();
setInterval(prune, 60 * 60e3).unref();
setInterval(() => { const t = now(); for (const [id, v] of presence) if (t - v.at > 10 * 60e3) presence.delete(id); }, 60e3).unref();

// ---------- admin accounts without the /setup page (Docker, servers) ----------
// creates the account, or promotes an existing one to admin (and sets its password if one is given)
function makeAdmin(username, password) {
  const existing = S.userByName.get(username);
  if (existing) {
    q("UPDATE users SET role = 'admin', disabled = 0 WHERE id = ?").run(existing.id);
    if (password) {
      const bad = checkNewAccount(existing.username, password);
      if (bad) throw new Error(bad);
      q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
      S.deleteUserSessions.run(existing.id);
    }
    return `${existing.username} is now an admin${password ? ' (password changed)' : ''}.`;
  }
  const bad = checkNewAccount(username, password);
  if (bad) throw new Error(bad);
  S.insertUser.run(username, hashPassword(password), 'admin', now(), now());
  return `Admin account ${username} created.`;
}
function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); }; // don't echo the password
    rl.question(prompt, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
async function runCommand(cmd, arg) {
  if (cmd === 'create-admin') {
    if (!arg) throw new Error('Usage: node server.js create-admin <username>   (password from KG_ADMIN_PASSWORD or typed in)');
    const pw = process.env.KG_ADMIN_PASSWORD || (process.stdin.isTTY ? await askHidden('Password for ' + arg + ': ') : '');
    if (!S.userByName.get(arg) && !pw) throw new Error('No password given. Set KG_ADMIN_PASSWORD or run it in an interactive terminal (docker exec -it ...).');
    console.log(makeAdmin(arg, pw));
    return;
  }
  if (cmd === 'backup') {
    if (!arg) throw new Error('Usage: node server.js backup <file.db>');
    const target = path.resolve(arg);
    if (fs.existsSync(target)) throw new Error('That file already exists: ' + target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); // consistent copy, safe while the site runs
    console.log('Backup written to ' + target);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Commands: create-admin <username>, backup <file.db>`);
}

// ---------- start ----------
function startServer() {
  // first admin from the environment (for Docker, where /setup can't be reached from the machine itself)
  if (S.adminCount.get().n === 0 && process.env.KG_ADMIN_USER && process.env.KG_ADMIN_PASSWORD) {
    try { console.log(makeAdmin(process.env.KG_ADMIN_USER, process.env.KG_ADMIN_PASSWORD)); }
    catch (e) { console.error('Could not create the admin from KG_ADMIN_USER / KG_ADMIN_PASSWORD: ' + e.message); }
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!err.status) console.error(new Date().toISOString(), req.method, req.url, err);
      if (!res.headersSent) fail(res, err.status || 500, err.status ? err.message : 'Something went wrong on the server.');
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Kaotic Gaming is running on ${HOST}:${PORT}${TRUST_PROXY ? ' (trusting reverse-proxy headers)' : ''}`);
    console.log(`Player data: ${DATA_DIR}`);
    if (S.adminCount.get().n === 0) console.log(`No admin yet. Open http://localhost:${PORT}/setup on this machine, or run: node server.js create-admin <username>`);
    // the 99¢ Supporter Pack shop
    if (shopEnabled()) console.log(`Shop is on: PayPal ${PAYPAL.env}${PAYPAL.env === 'sandbox' ? ' (test money; only admins' + (PAYPAL.testers.size ? ' and PAYPAL_TESTERS' : '') + ' can buy)' : ' (REAL money)'}${PAYPAL.webhookId ? '' : ', no webhook'}.`);
    else if (process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_WEBHOOK_ID) console.error(`Shop is OFF: ${shopProblem}.`);
    // anyone could sign up with a tester name nobody has taken yet
    const unknownTesters = [...PAYPAL.testers].filter(n => !S.userByName.get(n));
    if (PAYPAL.env === 'sandbox' && unknownTesters.length) console.error(`PAYPAL_TESTERS lists names with no account yet (anyone could register them): ${unknownTesters.map(safeLog).join(', ')}`);
  });
  if (shopEnabled()) { // re-check pending payments and recent sales with PayPal (refunds, chargebacks, late payments)
    setTimeout(() => recheckOrders().catch(e => console.error('Shop re-check:', e.message)), 60e3).unref();
    setInterval(() => recheckOrders().catch(e => console.error('Shop re-check:', e.message)), 15 * 60e3).unref();
  }
  const shutdown = () => { server.close(); try { db.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[2]) {
  runCommand(process.argv[2], process.argv[3])
    .then(() => { db.close(); process.exit(0); })
    .catch(e => { console.error(e.message); try { db.close(); } catch (x) {} process.exit(1); });
} else startServer();
