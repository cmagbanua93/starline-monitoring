/* ------------------------- monitor sign-in & accounts -------------------------
 * Everyone signs in with their own username and password.
 *   admin       — the dashboard, plus the Users page (create / reset / disable /
 *                 delete accounts) and the billing push log
 *   technician  — the dashboard only (live status, ISP links, account list)
 *
 * Accounts live in the starline-ops Postgres (DATABASE_URL), in their own
 * schema "monitor" so nothing touches billing's or the map's tables.
 * Passwords are scrypt hashes; a sign-in is a signed cookie carrying the user
 * id, an expiry and a token version. Changing a password, disabling an account
 * or changing its role bumps the version, signing that person out everywhere.
 *
 * First visit with no accounts: "Create the administrator account". When
 * DASHBOARD_PASSWORD (the old shared password) is set, that form asks for it,
 * so only someone who already had access can claim admin.
 *
 * Without DATABASE_URL the monitor keeps the old single shared password, so a
 * missing variable can never lock the office out of its own monitor.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const COOKIE = 'sl_user';
const LEGACY_COOKIE = 'sl_monitor';
const SESSION_DAYS = 30;
const ROLES = ['admin', 'technician'];
const ROLE_LABEL = { admin: 'Admin', technician: 'Technician' };

let pool = null;
let ready = false;

async function init() {
  if (!DATABASE_URL) {
    console.log('[auth] DATABASE_URL not set — using the single DASHBOARD_PASSWORD sign-in');
    return;
  }
  const { Pool } = require('pg');
  const internal = /\.railway\.internal|localhost|127\.0\.0\.1/i.test(DATABASE_URL);
  pool = new Pool({ connectionString: DATABASE_URL, max: 3, ssl: (!internal && /sslmode=require/i.test(DATABASE_URL)) ? { rejectUnauthorized: false } : false });
  pool.on('error', (e) => console.error('[auth] db idle error:', e.message));
  for (let i = 1; i <= 6 && !ready; i++) {
    try {
      await pool.query(`
        CREATE SCHEMA IF NOT EXISTS monitor;
        CREATE TABLE IF NOT EXISTS monitor.users (
          id            serial PRIMARY KEY,
          username      text NOT NULL,
          name          text,
          pass_hash     text NOT NULL,
          role          text NOT NULL DEFAULT 'technician',
          active        boolean NOT NULL DEFAULT true,
          token_version integer NOT NULL DEFAULT 1,
          created_at    timestamptz NOT NULL DEFAULT now(),
          last_login    timestamptz
        );
        CREATE UNIQUE INDEX IF NOT EXISTS monitor_users_username_key ON monitor.users (lower(username));`);
      ready = true;
      console.log('[auth] accounts ready (Postgres schema "monitor")');
    } catch (e) {
      console.error(`[auth] database not ready (attempt ${i}): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
const accountsOn = () => !!pool;
const q = (text, params) => pool.query(text, params);

/* ---- helpers ---- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'hex');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), want.length), want);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const cleanUsername = (u) => String(u || '').trim().toLowerCase();
const usernameProblem = (u) => (/^[a-z0-9._-]{3,32}$/.test(u) ? null : 'Username: 3–32 letters, numbers, dot, dash or underscore (no spaces).');
const passwordProblem = (p) => (String(p || '').length >= 8 ? null : 'Password must be at least 8 characters.');

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const sign = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
function sessionCookie(req, user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${user.id}.${exp}.${user.token_version}`;
  return `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${
    req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
}
const legacyToken = () => crypto.createHmac('sha256', SESSION_SECRET).update('starline-monitor-v1').digest('hex');

/* Users are looked up per request (the dashboard polls), so keep them for a
   minute; any account change clears this at once. */
const userCache = new Map();
async function userById(id) {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 60e3) return c.user;
  const r = await q('SELECT id, username, name, role, active, token_version FROM monitor.users WHERE id = $1', [id]);
  const user = r.rows[0] || null;
  userCache.set(id, { at: Date.now(), user });
  return user;
}

/** The signed-in person, or null. */
async function currentUser(req) {
  if (!accountsOn()) {
    if (!DASHBOARD_PASSWORD) return null;
    return safeEqual(cookieOf(req, LEGACY_COOKIE), legacyToken())
      ? { id: 0, username: 'staff', name: 'Staff', role: 'admin', legacy: true } : null;
  }
  const raw = cookieOf(req, COOKIE);
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [id, exp, ver, mac] = parts;
  if (!/^\d+$/.test(id) || !safeEqual(mac, sign(`${id}.${exp}.${ver}`)) || Number(exp) < Date.now()) return null;
  const u = await userById(Number(id));
  if (!u || !u.active || String(u.token_version) !== ver) return null;
  return u;
}

async function userCount() { return Number((await q('SELECT count(*)::int n FROM monitor.users')).rows[0].n); }
async function otherActiveAdmins(id) {
  return Number((await q(`SELECT count(*)::int n FROM monitor.users WHERE role='admin' AND active AND id <> $1`, [id])).rows[0].n);
}

/* ---- sign-in throttle: 10 wrong passwords per address per 15 minutes ---- */
const fails = new Map();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function throttled(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { fails.delete(ip); return false; }
  return f.n >= 10;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(ip, { first: Date.now(), n: 1 }); else f.n++;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}

/* ------------------------------- pages ------------------------------- */
const BRAND_CSS = `
:root{--navy:#12304a;--navy2:#1b4166;--gold:#d9b345;--bg:#f3f5f8;--text:#1f2937;--muted:#6b7280;--border:#e5e7eb;--danger:#dc2626}
*{box-sizing:border-box;margin:0;padding:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;font-size:15px}
.btn{display:inline-block;border:1px solid #cfd6e0;background:#fff;color:var(--text);border-radius:6px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--navy)}
.btn.primary{background:var(--navy);border-color:var(--navy);color:#fff}.btn.primary:hover{background:var(--navy2)}
.btn.danger{color:var(--danger);border-color:#f3c2c2}.btn.danger:hover{background:#fdecec}
.btn.tiny{padding:5px 9px;font-size:12px}
label{display:block;font-size:13px;font-weight:600;color:#374151;margin:10px 0 5px}
input,select{width:100%;height:44px;padding:0 12px;font-size:15px;border:1px solid #cfd6e0;border-radius:6px;background:#fff;color:var(--text)}
input:focus,select:focus{outline:none;border-color:var(--navy);box-shadow:0 0 0 3px rgba(18,48,74,.12)}
.err{color:var(--danger);font-size:13px;margin-top:10px}
.ok{color:#166534;background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:9px 11px;font-size:13px;margin-bottom:12px}
.bad{color:#991b1b;background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:9px 11px;font-size:13px;margin-bottom:12px}
.chip{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:99px;margin-left:4px;vertical-align:1px}
.chip.admin{background:var(--gold);color:#0b2236}.chip.technician{background:#e0ecff;color:#1e40af}.chip.off{background:#fee2e2;color:#991b1b}`;

const HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/icon.png"><meta name="theme-color" content="#12304a">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

function loginPage({ message = '', setup = false, setupKey = false, values = {} } = {}) {
  return `${HEAD('StarLine Internet · Uptime Monitor')}
<style>${BRAND_CSS}
.wrap{min-height:100vh;padding:24px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(180deg,var(--navy) 0,var(--navy) 42%,var(--bg) 42%)}
.wrap>*{width:100%;max-width:420px}.brand{text-align:center;margin-bottom:18px}
.brand img{width:230px;max-width:70%;height:auto;margin-bottom:6px}.brand p{font-size:14px;font-weight:600;color:#e6ebf2;letter-spacing:.12em}
.card{background:#fff;border:1px solid var(--border);border-top:4px solid var(--gold);border-radius:10px;padding:24px;box-shadow:0 10px 30px rgba(16,24,40,.12)}
h1{font-size:19px;font-weight:700}.sub{font-size:13px;color:var(--muted);margin:2px 0 8px}
.note{font-size:13px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:9px 11px;margin:8px 0 2px}
.card .btn.primary{width:100%;height:46px;font-size:15px;margin-top:18px}.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:16px}</style>
</head><body><div class="wrap">
  <div class="brand"><img src="/logo.png" alt="StarLine Internet"><p>UPTIME MONITOR</p></div>
  <form class="card" method="POST" action="${setup ? '/setup' : '/login'}">
    <h1>${setup ? 'Create the administrator account' : 'Sign in'}</h1>
    <div class="sub">${setup ? 'This only appears once, before any account exists.' : 'Customer uptime &amp; ISP links'}</div>
    ${setup ? `<div class="note">First-time setup: create the <b>administrator</b> account. You can add technician accounts after signing in.</div>
      ${setupKey ? '<label>Current monitor password</label><input type="password" name="setup_key" autocomplete="off" required>' : ''}
      <label>Your name</label><input name="name" value="${esc(values.name)}" placeholder="e.g. Chris" autocomplete="name">` : ''}
    ${accountsOn() ? `<label>Username</label><input name="username" value="${esc(values.username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required ${setup && setupKey ? '' : 'autofocus'}>` : ''}
    <label>Password</label><input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
    ${setup ? '<label>Repeat password</label><input type="password" name="password2" autocomplete="new-password" required>' : ''}
    <button class="btn primary" type="submit">${setup ? 'Create admin account' : 'Sign in'}</button>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
  </form>
  <div class="foot">StarLine Internet · Minglanilla, Cebu</div>
</div></body></html>`;
}

function shell(user, title, inner) {
  return `${HEAD(title + ' · StarLine Monitor')}
<style>${BRAND_CSS}
header{background:var(--navy);border-bottom:3px solid var(--gold);color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px}
header img{height:40px}.htxt{border-left:1px solid rgba(255,255,255,.3);padding-left:12px}
header h1{font-size:13px;font-weight:600;color:#e6ebf2;letter-spacing:.04em;text-transform:uppercase}
header .s{font-size:12px;color:#c7d2e1}header .sp{flex:1}
header a{color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:6px;padding:6px 12px;font-size:12.5px;font-weight:600;text-decoration:none}
header a:hover{background:rgba(255,255,255,.1)}
.wrap{max-width:820px;margin:0 auto;padding:18px 14px 40px}
.card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
h2{font-size:12px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.row.off{opacity:.6}.row .t{font-weight:600;font-size:14px}.row .m{color:var(--muted);font-size:12px}
.acts{display:flex;flex-wrap:wrap;gap:5px}.acts form{display:inline}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.hint{color:var(--muted);font-size:12.5px;margin-top:8px}
@media(max-width:560px){.grid{grid-template-columns:1fr}.htxt{display:none}}</style>
</head><body>
<header><img src="/logo.png" alt="StarLine Internet"><div class="htxt"><h1>Uptime Monitor</h1><div class="s">${esc(title)}</div></div>
<div class="sp"></div><a href="/">‹ Dashboard</a></header>
<div class="wrap">${inner}</div></body></html>`;
}

const fmtWhen = (t) => (t ? new Date(t).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'never');

async function usersPage(user, flash = {}) {
  const r = await q('SELECT id, username, name, role, active, last_login FROM monitor.users ORDER BY role, lower(username)');
  const rows = r.rows.map((u) => {
    const me = u.id === user.id;
    const form = (action, label, cls = '', extra = '', confirmMsg = '') =>
      `<form method="POST" action="/users/${u.id}/${action}"${confirmMsg ? ` onsubmit="return confirm('${esc(confirmMsg)}')"` : ''}>${extra}<button class="btn tiny ${cls}">${label}</button></form>`;
    return `<div class="row ${u.active ? '' : 'off'}">
      <div><div class="t">${esc(u.name || u.username)} <span class="chip ${u.role}">${ROLE_LABEL[u.role]}</span>${u.active ? '' : '<span class="chip off">Disabled</span>'}${me ? ' <span class="m">(you)</span>' : ''}</div>
        <div class="m">@${esc(u.username)} · last sign-in ${esc(fmtWhen(u.last_login))}</div></div>
      <div class="acts">
        <form method="POST" action="/users/${u.id}/password" onsubmit="var p=prompt('New password for ${esc(u.username)} (8+ characters):');if(!p)return false;this.password.value=p;"><input type="hidden" name="password"><button class="btn tiny">Reset password</button></form>
        ${me ? '' : form('role', u.role === 'admin' ? 'Make technician' : 'Make admin', '', `<input type="hidden" name="role" value="${u.role === 'admin' ? 'technician' : 'admin'}">`)
          + form('active', u.active ? 'Disable' : 'Enable', '', `<input type="hidden" name="active" value="${u.active ? '0' : '1'}">`)
          + form('delete', 'Delete', 'danger', '', `Delete the account ${u.username}? This cannot be undone.`)}
      </div></div>`;
  }).join('');
  return shell(user, 'Accounts', `
    ${flash.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}${flash.bad ? `<div class="bad">${esc(flash.bad)}</div>` : ''}
    <div class="card"><h2>Accounts</h2>${rows}</div>
    <form class="card" method="POST" action="/users/add"><h2>Add an account</h2>
      <div class="grid">
        <div><label>Name</label><input name="name" placeholder="e.g. Juan Dela Cruz"></div>
        <div><label>Username</label><input name="username" placeholder="e.g. juan" autocapitalize="none" spellcheck="false" required></div>
        <div><label>Password (8+ characters)</label><input name="password" autocomplete="off" required></div>
        <div><label>Access</label><select name="role"><option value="technician" selected>Technician — dashboard only</option><option value="admin">Administrator — also manages accounts</option></select></div>
      </div>
      <button class="btn primary" style="margin-top:14px">Create account</button>
      <p class="hint">Give the technician their username and password in person. They can change it after signing in (Password).</p>
    </form>`);
}

function passwordPage(user, flash = {}) {
  return shell(user, 'My password', `
    ${flash.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}${flash.bad ? `<div class="bad">${esc(flash.bad)}</div>` : ''}
    <form class="card" method="POST" action="/account/password" style="max-width:440px"><h2>Change my password</h2>
      <label>Current password</label><input type="password" name="current" autocomplete="current-password" required>
      <label>New password (8+ characters)</label><input type="password" name="password" autocomplete="new-password" required>
      <label>Repeat new password</label><input type="password" name="password2" autocomplete="new-password" required>
      <button class="btn primary" style="margin-top:14px">Change password</button>
      <p class="hint">Other phones or computers signed in as you will be signed out.</p>
    </form>`);
}

/* ------------------------------- routes -------------------------------
 * Returns true when it answered the request. Runs before the dashboard's own
 * sign-in check, so these pages work without being signed in where they must. */
const html = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
const redirect = (res, to, headers = {}) => { res.writeHead(302, { Location: to, ...headers }); res.end(); };

const ASSETS = { '/logo.png': 'logo.png', '/icon.png': 'icon.png' };

async function handle(req, res, urlPath) {
  /* the map library (FTTH Map tab) — served from this service, no outside CDN */
  const vm = urlPath.match(/^\/vendor\/leaflet\/((?:images\/)?[a-z0-9.-]+\.(js|css|png))$/i);
  if (vm) {
    const type = { js: 'application/javascript', css: 'text/css', png: 'image/png' }[vm[2].toLowerCase()];
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'vendor', 'leaflet', vm[1]));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
      res.end(buf);
    } catch (e) { res.writeHead(404); res.end(); }
    return true;
  }

  /* brand images — public, they are on the sign-in page */
  if (ASSETS[urlPath]) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, ASSETS[urlPath]));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) { res.writeHead(404); res.end(); }
    return true;
  }

  const needsSetup = async () => accountsOn() && ready && (await userCount()) === 0;

  if (urlPath === '/login' && req.method === 'GET') {
    if (await needsSetup()) return redirect(res, '/setup'), true;
    html(res, 200, loginPage({ message: !accountsOn() && !DASHBOARD_PASSWORD ? 'DASHBOARD_PASSWORD is not set on this service.' : '' }));
    return true;
  }

  if (urlPath === '/setup') {
    if (!(await needsSetup())) return redirect(res, '/login'), true;
    if (req.method !== 'POST') { html(res, 200, loginPage({ setup: true, setupKey: !!DASHBOARD_PASSWORD })); return true; }
    const f = await readForm(req);
    const page = (msg) => html(res, 400, loginPage({ setup: true, setupKey: !!DASHBOARD_PASSWORD, message: msg, values: f }));
    if (throttled(ipOf(req))) return page('Too many tries. Wait 15 minutes.'), true;
    if (DASHBOARD_PASSWORD && !safeEqual(f.setup_key || '', DASHBOARD_PASSWORD)) { noteFail(ipOf(req)); return page('The current monitor password is not right.'), true; }
    const username = cleanUsername(f.username);
    const bad = usernameProblem(username) || passwordProblem(f.password) || (f.password !== f.password2 ? 'The two passwords are not the same.' : null);
    if (bad) return page(bad), true;
    const r = await q(`INSERT INTO monitor.users (username, name, pass_hash, role, last_login) VALUES ($1,$2,$3,'admin', now()) RETURNING *`,
      [username, String(f.name || '').trim() || null, hashPassword(f.password)]);
    console.log(`[auth] first admin account created: ${username}`);
    redirect(res, '/', { 'Set-Cookie': sessionCookie(req, r.rows[0]) });
    return true;
  }

  if (urlPath === '/login' && req.method === 'POST') {
    const f = await readForm(req);
    const ip = ipOf(req);
    if (throttled(ip)) { html(res, 429, loginPage({ message: 'Too many wrong passwords. Wait 15 minutes and try again.', values: f })); return true; }
    if (!accountsOn()) {
      /* old single-password sign-in (no DATABASE_URL) */
      if (!DASHBOARD_PASSWORD) { html(res, 503, loginPage({ message: 'DASHBOARD_PASSWORD is not set on this service.' })); return true; }
      if (!safeEqual(f.password || '', DASHBOARD_PASSWORD)) { noteFail(ip); html(res, 401, loginPage({ message: 'Wrong password.' })); return true; }
      redirect(res, '/', { 'Set-Cookie': `${LEGACY_COOKIE}=${legacyToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
      return true;
    }
    const r = await q('SELECT * FROM monitor.users WHERE lower(username) = $1', [cleanUsername(f.username)]);
    const u = r.rows[0];
    if (!u || !checkPassword(f.password, u.pass_hash)) { noteFail(ip); html(res, 401, loginPage({ message: 'Wrong username or password.', values: f })); return true; }
    if (!u.active) { html(res, 403, loginPage({ message: 'This account is disabled. Ask the administrator.', values: f })); return true; }
    fails.delete(ip);
    await q('UPDATE monitor.users SET last_login = now() WHERE id = $1', [u.id]);
    redirect(res, '/', { 'Set-Cookie': sessionCookie(req, u) });
    return true;
  }

  if (urlPath === '/logout') {
    res.writeHead(302, { 'Set-Cookie': [`${COOKIE}=; Path=/; Max-Age=0`, `${LEGACY_COOKIE}=; Path=/; Max-Age=0`], Location: '/login' });
    res.end();
    return true;
  }

  /* ---- signed-in pages ---- */
  if (urlPath === '/account/password' || urlPath === '/users' || urlPath.startsWith('/users/')) {
    const user = await currentUser(req);
    if (!user) return redirect(res, '/login'), true;
    if (!accountsOn()) { html(res, 200, shell(user, 'Accounts', '<div class="bad">Accounts need the database. Set DATABASE_URL on this service in Railway (reference the Postgres service).</div>')); return true; }

    if (urlPath === '/account/password') {
      if (req.method !== 'POST') { html(res, 200, passwordPage(user)); return true; }
      const f = await readForm(req);
      const r = await q('SELECT * FROM monitor.users WHERE id = $1', [user.id]);
      if (!checkPassword(f.current, r.rows[0].pass_hash)) { html(res, 400, passwordPage(user, { bad: 'Your current password is not right.' })); return true; }
      const bad = passwordProblem(f.password) || (f.password !== f.password2 ? 'The two new passwords are not the same.' : null);
      if (bad) { html(res, 400, passwordPage(user, { bad })); return true; }
      const up = await q('UPDATE monitor.users SET pass_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *', [user.id, hashPassword(f.password)]);
      userCache.delete(user.id);
      html(res, 200, passwordPage(up.rows[0], { ok: 'Password changed.' }), { 'Set-Cookie': sessionCookie(req, up.rows[0]) });
      return true;
    }

    if (user.role !== 'admin') { html(res, 403, shell(user, 'Accounts', '<div class="bad">Only an administrator can manage accounts.</div>')); return true; }
    if (urlPath === '/users') { html(res, 200, await usersPage(user)); return true; }
    if (req.method !== 'POST') return redirect(res, '/users'), true;
    const f = await readForm(req);
    const done = async (flash) => { userCache.clear(); html(res, flash.bad ? 400 : 200, await usersPage(user, flash)); return true; };

    if (urlPath === '/users/add') {
      const username = cleanUsername(f.username);
      const role = ROLES.includes(f.role) ? f.role : 'technician';
      const bad = usernameProblem(username) || passwordProblem(f.password);
      if (bad) return done({ bad });
      const dup = await q('SELECT 1 FROM monitor.users WHERE lower(username) = $1', [username]);
      if (dup.rowCount) return done({ bad: `The username "${username}" is already taken.` });
      await q('INSERT INTO monitor.users (username, name, pass_hash, role) VALUES ($1,$2,$3,$4)', [username, String(f.name || '').trim() || null, hashPassword(f.password), role]);
      console.log(`[auth] ${user.username} created ${role} account ${username}`);
      return done({ ok: `Account "${username}" created (${ROLE_LABEL[role]}).` });
    }
    const m = urlPath.match(/^\/users\/(\d+)\/(password|role|active|delete)$/);
    if (!m) return redirect(res, '/users'), true;
    const id = Number(m[1]), act = m[2];
    const r0 = await q('SELECT * FROM monitor.users WHERE id = $1', [id]);
    const target = r0.rows[0];
    if (!target) return done({ bad: 'Account not found.' });
    const lastAdmin = target.role === 'admin' && target.active && (await otherActiveAdmins(id)) === 0;
    if (act === 'password') {
      const bad = passwordProblem(f.password);
      if (bad) return done({ bad });
      await q('UPDATE monitor.users SET pass_hash = $2, token_version = token_version + 1 WHERE id = $1', [id, hashPassword(f.password)]);
      if (id === user.id) {   // keep the admin signed in on this browser
        const me = (await q('SELECT * FROM monitor.users WHERE id = $1', [id])).rows[0];
        userCache.clear();
        html(res, 200, await usersPage(me, { ok: 'Your password was changed.' }), { 'Set-Cookie': sessionCookie(req, me) });
        return true;
      }
      return done({ ok: `Password reset for ${target.username}. They are signed out until they use the new one.` });
    }
    if (id === user.id) return done({ bad: 'You cannot change your own access here.' });
    if (act === 'role') {
      const role = ROLES.includes(f.role) ? f.role : null;
      if (!role) return done({ bad: 'Unknown role.' });
      if (lastAdmin && role !== 'admin') return done({ bad: 'This is the only administrator. Make another admin first.' });
      await q('UPDATE monitor.users SET role = $2, token_version = token_version + 1 WHERE id = $1', [id, role]);
      return done({ ok: `${target.username} is now ${ROLE_LABEL[role]}.` });
    }
    if (act === 'active') {
      const active = f.active === '1';
      if (lastAdmin && !active) return done({ bad: 'This is the only administrator.' });
      await q('UPDATE monitor.users SET active = $2, token_version = token_version + $3 WHERE id = $1', [id, active, active ? 0 : 1]);
      return done({ ok: `${target.username} ${active ? 'enabled' : 'disabled and signed out'}.` });
    }
    if (act === 'delete') {
      if (lastAdmin) return done({ bad: 'This is the only administrator.' });
      await q('DELETE FROM monitor.users WHERE id = $1', [id]);
      return done({ ok: `Account ${target.username} deleted.` });
    }
  }
  return false;
}

/* The header bar of the dashboard: who is signed in and their links. */
function userBarHtml(user) {
  if (!user) return '';
  const name = esc(user.name || user.username);
  return `<span class="who">${name} <span class="chip ${user.role}">${ROLE_LABEL[user.role] || user.role}</span></span>
    ${user.role === 'admin' && accountsOn() ? '<a class="hb" href="/users">Users</a>' : ''}
    ${accountsOn() ? '<a class="hb" href="/account/password">Password</a>' : ''}
    <a class="hb" href="/logout">Sign out</a>`;
}

module.exports = { init, handle, currentUser, loginPage, userBarHtml, accountsOn, dbPool: () => (ready ? pool : null) };
