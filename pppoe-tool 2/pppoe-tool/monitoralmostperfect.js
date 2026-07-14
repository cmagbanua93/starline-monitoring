/**
 * monitor.js
 *
 * Monitors PPPoE accounts on a Mikrotik router.
 * - Online/offline status: from /ppp/active (live sessions)
 * - "Went offline at" time: from /log (actual logout events in Mikrotik log)
 * - Alert + audio alarm: when ALERT_THRESHOLD or more accounts are offline simultaneously
 *
 * Also pulls customer name, account number, contact number, area, and NAP box
 * from the TaokiNinam billing system (taokininam.com), joined to each PPPoE
 * account by username.
 *
 * Also monitors 4 ISP uplinks by pinging their gateway IPs directly from this
 * machine (edit the ISP_LINKS array in this file to add/remove/rename links).
 *
 * Uses the same .env credentials as create_pppoe_accounts.js
 *
 * Usage:
 *   node monitor.js
 *   Open http://localhost:3000 in your browser
 *
 * .env options:
 *   MONITOR_PORT=3000
 *   MONITOR_POLL_INTERVAL=10    seconds between polls
 *   MONITOR_ALERT_THRESHOLD=5   how many offline triggers the alarm
 *
 *   TAOKININAM_USERNAME=you@example.com   your TaokiNinam admin login
 *   TAOKININAM_PASSWORD=yourpassword
 *   TAOKININAM_BASE_URL=https://taokininam.com   (optional, this is the default)
 *   BILLING_SYNC_INTERVAL_MIN=10   minutes between billing re-syncs (customer
 *                                  data changes rarely, so this is separate
 *                                  from and much less frequent than the
 *                                  Mikrotik poll interval)
 *
 *   If TAOKININAM_USERNAME/PASSWORD are omitted, monitor.js runs exactly as
 *   before, just without the extra customer columns.
 */

require('dotenv').config();
const http = require('http');
const { exec } = require('child_process');

// ---------- Config ----------

const MIKROTIK_HOST     = process.env.MIKROTIK_HOST;
const MIKROTIK_PORT     = process.env.MIKROTIK_PORT || 80;
const MIKROTIK_USER     = process.env.MIKROTIK_USER;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;
const VERIFY_CERT       = String(process.env.MIKROTIK_VERIFY_CERT || '').toLowerCase() === 'true';
const PROTOCOL          = (MIKROTIK_PORT == 443 || MIKROTIK_PORT == 8729) ? 'https' : 'http';
const BASE_URL          = `${PROTOCOL}://${MIKROTIK_HOST}:${MIKROTIK_PORT}/rest`;

const DASHBOARD_PORT   = parseInt(process.env.MONITOR_PORT || '3000');
const POLL_INTERVAL_MS = parseInt(process.env.MONITOR_POLL_INTERVAL || '10') * 1000;
const ALERT_THRESHOLD  = parseInt(process.env.MONITOR_ALERT_THRESHOLD || '5');

// ---- TaokiNinam billing system (customer name / account / contact / area / NAP box) ----
const BILLING_BASE_URL   = (process.env.TAOKININAM_BASE_URL || 'https://taokininam.com').replace(/\/$/, '');
const BILLING_USERNAME   = process.env.TAOKININAM_USERNAME;
const BILLING_PASSWORD   = process.env.TAOKININAM_PASSWORD;
const BILLING_SYNC_MS    = parseInt(process.env.BILLING_SYNC_INTERVAL_MIN || '10') * 60 * 1000;
const BILLING_ENABLED    = Boolean(BILLING_USERNAME && BILLING_PASSWORD);
const BILLING_DEBUG      = String(process.env.BILLING_DEBUG || '').toLowerCase() === 'true';

// ---- ISP uplink monitoring (pings each gateway IP directly from this machine) ----
// Edit this list to add/remove/rename ISP links.
const ISP_LINKS = [
  { name: 'Globe 1Gbps',        ip: '222.127.255.192', plan: '1Gbps'   },
  { name: 'Globe Biz+ 500Mbps', ip: '180.191.137.7',    plan: '500Mbps' },
  { name: 'Globe Biz 500Mbps',  ip: '180.191.229.3',    plan: '500Mbps' },
  { name: 'PLDT 500Mbps',       ip: '115.147.14.124',   plan: '500Mbps' },
];
const ISP_PING_TIMEOUT_MS = parseInt(process.env.ISP_PING_TIMEOUT_MS || '2000');

if (!MIKROTIK_HOST || !MIKROTIK_USER || !MIKROTIK_PASSWORD) {
  console.error('Missing MIKROTIK_HOST, MIKROTIK_USER or MIKROTIK_PASSWORD in .env');
  process.exit(1);
}

if (!BILLING_ENABLED) {
  console.warn('TAOKININAM_USERNAME / TAOKININAM_PASSWORD not set in .env — running without billing data (customer name/account/contact/area/NAP box will be blank).');
}

if (!VERIFY_CERT && PROTOCOL === 'https') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ---------- State ----------

let state = {
  accounts: [],
  downCount: 0,
  totalCount: 0,
  alertActive: false,
  alertSince: null,
  lastPoll: null,
  pollError: null,
  routerHost: `${PROTOCOL}://${MIKROTIK_HOST}:${MIKROTIK_PORT}`,
  pollIntervalSec: Math.round(POLL_INTERVAL_MS / 1000),
  alertThreshold: ALERT_THRESHOLD,
  billingEnabled: BILLING_ENABLED,
  billingLastSync: null,
  billingError: BILLING_ENABLED ? null : 'not configured',
  billingCustomerCount: 0,
  isps: ISP_LINKS.map(isp => ({ ...isp, online: null, latencyMs: null })),
  ispsLastCheck: null,
};

const sseClients = new Set();

// ---------- Router API ----------

async function routerGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${MIKROTIK_USER}:${MIKROTIK_PASSWORD}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`Router returned HTTP ${res.status} for ${endpoint}`);
  return res.json();
}

// ---------- TaokiNinam billing system ----------
//
// TaokiNinam has no public JSON API. It's a classic PHP session-cookie app:
//   1. POST cusername/cpassword to /actions/login_check.php -> PHPSESSID cookie
//   2. GET /actions/exportRecords.php (with that cookie) -> full customer CSV
// The CSV's USERNAME column is the same PPPoE secret name used on the Mikrotik,
// so it's used as the join key against /ppp/secret data.

let billingCookie = null;
let customerIndex = new Map(); // key: lowercased pppoe username -> customer info

async function billingLogin() {
  const loginUrl = `${BILLING_BASE_URL}/actions/login_check.php`;
  if (BILLING_DEBUG) console.log(`[billing debug] BILLING_BASE_URL = ${JSON.stringify(BILLING_BASE_URL)} | POST ${loginUrl}`);

  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; monitor.js billing sync)',
    },
    body: new URLSearchParams({ cusername: BILLING_USERNAME, cpassword: BILLING_PASSWORD, submit: '' }).toString(),
    redirect: 'manual',
  });

  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);

  if (BILLING_DEBUG) {
    console.log(`[billing debug] login_check.php -> status ${res.status}, location: ${res.headers.get('location') || '(none)'}, set-cookie count: ${setCookies.length}, getSetCookie supported: ${typeof res.headers.getSetCookie === 'function'} (node ${process.version})`);
  }

  const sessionCookie = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('PHPSESSID='));
  if (!sessionCookie) {
    if (BILLING_DEBUG) {
      const bodySnippet = (await res.text().catch(() => '')).slice(0, 300);
      console.log(`[billing debug] login response body (first 300 chars): ${bodySnippet}`);
    }
    throw new Error('billing login failed — no PHPSESSID returned (check TAOKININAM_USERNAME/PASSWORD, or set BILLING_DEBUG=true in .env for more detail)');
  }

  billingCookie = sessionCookie;
}

async function billingFetchCsv() {
  if (!billingCookie) await billingLogin();

  const exportUrl = `${BILLING_BASE_URL}/actions/exportRecords.php`;
  if (BILLING_DEBUG) console.log(`[billing debug] GET ${exportUrl} | cookie: ${billingCookie ? billingCookie.split('=')[0] : '(none)'}=***`);

  const doFetch = () => fetch(exportUrl, {
    headers: {
      Cookie: billingCookie,
      'User-Agent': 'Mozilla/5.0 (compatible; monitor.js billing sync)',
    },
  });

  let res = await doFetch();
  let text = await res.text();

  // Session expired / not logged in -> exportRecords.php won't return CSV. Re-login once and retry.
  if (!text.trimStart().startsWith('ID,ACCOUNT')) {
    if (BILLING_DEBUG) {
      console.log(`[billing debug] exportRecords.php -> status ${res.status}, first 200 chars: ${text.slice(0, 200)}`);
    }
    await billingLogin();
    res = await doFetch();
    text = await res.text();
    if (!text.trimStart().startsWith('ID,ACCOUNT')) {
      if (BILLING_DEBUG) {
        console.log(`[billing debug] retry exportRecords.php -> status ${res.status}, first 200 chars: ${text.slice(0, 200)}`);
      }
      throw new Error('billing export did not return CSV — login may have failed (set BILLING_DEBUG=true in .env for more detail)');
    }
  }

  return text;
}

// Minimal RFC4180 CSV parser — handles quoted fields, escaped quotes ("")
// and embedded newlines inside quoted fields (TaokiNinam's export uses these).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function syncBilling() {
  if (!BILLING_ENABLED) return;
  try {
    const csvText = await billingFetchCsv();
    const rows = parseCsv(csvText);
    if (!rows.length) throw new Error('billing export returned no rows');

    const header = rows[0];
    const col = name => header.indexOf(name);
    const iAccount  = col('ACCOUNT');
    const iFname    = col('FNAME');
    const iLname    = col('LNAME');
    const iArea     = col('AREA');
    const iPhone    = col('PHONE');
    const iUsername = col('USERNAME');
    const iNap      = col('NAP');
    const iPort     = col('PORT');

    if (iUsername === -1) throw new Error('billing export missing USERNAME column');

    const newIndex = new Map();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const username = (row[iUsername] || '').trim();
      if (!username) continue;

      const fname = (row[iFname] || '').trim();
      const lname = (row[iLname] || '').trim();
      const nap   = (row[iNap]   || '').trim();
      const port  = (row[iPort]  || '').trim();

      newIndex.set(username.toLowerCase(), {
        account:  (row[iAccount] || '').trim(),
        name:     [fname, lname].filter(Boolean).join(' '),
        contact:  (row[iPhone]   || '').trim(),
        area:     (row[iArea]    || '').trim(),
        napBox:   [nap, port].filter(Boolean).join(' / '),
      });
    }

    customerIndex = newIndex;
    state.billingLastSync = new Date().toISOString();
    state.billingError = null;
    state.billingCustomerCount = customerIndex.size;
    console.log(`[${new Date().toISOString()}] Billing sync OK — ${customerIndex.size} customer records loaded from TaokiNinam`);
  } catch (err) {
    state.billingError = err.message;
    console.error(`[${new Date().toISOString()}] Billing sync error:`, err.message);
  }
}

// ---------- ISP uplink monitoring ----------
// Pings each ISP gateway IP directly from this machine (shells out to the OS
// ping command — works cross-platform without needing raw-socket permissions).

function pingHost(ip, timeoutMs = ISP_PING_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? `ping -n 1 -w ${timeoutMs} ${ip}` : `ping -c 1 ${ip}`;

    exec(cmd, { timeout: timeoutMs + 1000 }, (err, stdout) => {
      if (err) { resolve({ online: false, latencyMs: null }); return; }
      const match = stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
      resolve({ online: true, latencyMs: match ? parseFloat(match[1]) : null });
    });
  });
}

async function pollIsps() {
  const results = await Promise.all(ISP_LINKS.map(async isp => {
    const r = await pingHost(isp.ip);
    return { ...isp, online: r.online, latencyMs: r.latencyMs };
  }));
  state = { ...state, isps: results, ispsLastCheck: new Date().toISOString() };
  broadcast();
}

// ---------- Parse Mikrotik timestamp ----------
// Format from PPP secret: "2026-07-02 04:27:27"
function parseMikrotikTime(timeStr) {
  if (!timeStr) return null;
  // "YYYY-MM-DD HH:MM:SS"
  const m = timeStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (m) return new Date(`${m[1]}T${m[2]}`);
  return null;
}

// ---------- Poll ----------

async function poll() {
  try {
    const [secrets, active] = await Promise.all([
      routerGet('/ppp/secret?service=pppoe'),
      routerGet('/ppp/active'),
    ]);

    const activeUsernames = new Set(active.map(a => a.name));
    const now = new Date();

    const updated = secrets.map(secret => {
      const username  = secret.name;
      const isOnline  = activeUsernames.has(username);
      const prev      = state.accounts.find(a => a.username === username);

      // "last-logged-out" field comes directly from the PPP secret — same
      // value shown in Winbox under PPP > Secrets > Last Logged Out column.
      const rawLogout   = secret['last-logged-out'] || null;
      const lastLogout  = rawLogout ? parseMikrotikTime(rawLogout) : null;
      const lastLogoutIso = lastLogout ? lastLogout.toISOString() : null;

      // Track poll-detected offline time as fallback if field is empty
      const justWentOffline = !isOnline && prev && prev.status === 'online';
      const pollDetected    = justWentOffline ? now.toISOString()
                            : (!isOnline && prev ? prev.pollDetected : null);

      const customer = customerIndex.get(username.toLowerCase());

      return {
        username,
        profile:     secret.profile || '',
        comment:     secret.comment || '',
        localIp:     secret['local-address'] || '',
        remoteIp:    secret['remote-address'] || '',
        status:      isOnline ? 'online' : 'offline',
        lastSeen:    isOnline ? now.toISOString() : (prev ? prev.lastSeen : null),
        lastLogout:  lastLogoutIso || pollDetected || null,
        logSource:   lastLogoutIso ? 'secret' : (pollDetected ? 'poll' : null),
        pollDetected,
        customerName: customer ? customer.name    : '',
        accountNo:    customer ? customer.account : '',
        contactNo:    customer ? customer.contact : '',
        area:         customer ? customer.area    : '',
        napBox:       customer ? customer.napBox  : '',
      };
    });

    // Default sort: offline (most recently logged out) first
    updated.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'offline' ? -1 : 1;
      if (a.status === 'offline') {
        const ta = a.lastLogout ? new Date(a.lastLogout).getTime() : 0;
        const tb = b.lastLogout ? new Date(b.lastLogout).getTime() : 0;
        return tb - ta; // most recent first
      }
      return a.username.localeCompare(b.username);
    });

    const downCount = updated.filter(a => a.status === 'offline').length;

    // Alarm fires only when 5+ subscribers went offline TODAY and are still down
    const todayStr = now.toDateString();
    const todayDownCount = updated.filter(a =>
      a.status === 'offline' &&
      a.lastLogout &&
      new Date(a.lastLogout).toDateString() === todayStr
    ).length;
    const alertActive = todayDownCount >= ALERT_THRESHOLD;

    state = {
      ...state,
      accounts: updated,
      downCount,
      todayDownCount,
      totalCount: updated.length,
      alertActive,
      alertSince: alertActive ? (state.alertSince || now.toISOString()) : null,
      lastPoll: now.toISOString(),
      pollError: null,
    };

    broadcast();
  } catch (err) {
    state = { ...state, pollError: err.message, lastPoll: new Date().toISOString() };
    broadcast();
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

// ---------- Dashboard HTML ----------

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StarLine Internet Customer Uptime Monitor</title>
<style>
:root {
  --bg:       #0e1018;
  --sidebar:  #13151f;
  --card:     #181b28;
  --card2:    #1e2130;
  --border:   #252840;
  --green:    #8dc63f;
  --red:      #e84040;
  --amber:    #f59e0b;
  --blue:     #4a8fd4;
  --purple:   #9b59b6;
  --text:     #c8d0e0;
  --dim:      #48506a;
  --accent:   #4f6ef7;
  --isp-up:     #38bdf8;
  --isp-down:   #fb923c;
  --isp-accent: #818cf8;
}
* { box-sizing: border-box; margin:0; padding:0; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height:100vh; display:flex; flex-direction:column; }

/* ---- Alert banner ---- */
#alert-banner {
  display:none; background:var(--red); color:#fff;
  padding:12px 24px; font-size:14px; font-weight:600; letter-spacing:.3px;
  animation: abpulse 1.3s infinite; gap:14px; z-index:200; flex-shrink:0;
}
#alert-banner.active { display:flex; align-items:center; justify-content:center; }
@keyframes abpulse { 0%,100%{background:#e84040} 50%{background:#7f1d1d} }
#mute-btn { background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); border-radius:5px; color:#fff; font-size:12px; padding:4px 12px; cursor:pointer; flex-shrink:0; }
#mute-btn:hover { background:rgba(255,255,255,.25); }

/* ---- Layout ---- */
#app { display:flex; flex:1; overflow:hidden; }

/* ---- Sidebar ---- */
.sidebar {
  width:60px; background:var(--sidebar); border-right:1px solid var(--border);
  display:flex; flex-direction:column; align-items:center; padding:12px 0; gap:4px;
  flex-shrink:0;
}
.slogo {
  font-size:20px; padding:10px 0 16px; border-bottom:1px solid var(--border);
  width:100%; text-align:center; margin-bottom:8px;
}
.snav {
  width:44px; height:44px; border-radius:8px; display:flex; align-items:center; justify-content:center;
  font-size:18px; cursor:pointer; transition:background .15s; color:var(--dim); position:relative;
}
.snav:hover { background:var(--card2); color:var(--text); }
.snav.active { background:var(--accent); color:#fff; }
.snav .stip {
  position:absolute; left:54px; background:#1e2130; border:1px solid var(--border);
  color:var(--text); font-size:11px; padding:4px 8px; border-radius:4px;
  white-space:nowrap; display:none; pointer-events:none; z-index:100;
}
.snav:hover .stip { display:block; }

/* ---- Main ---- */
.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }

/* ---- Top bar ---- */
.topbar {
  background:var(--card); border-bottom:1px solid var(--border);
  padding:14px 24px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;
}
.topbar h1 { font-size:17px; font-weight:700; color:#e8ecf5; display:flex; align-items:center; gap:8px; }
.topbar .meta { font-size:11px; color:var(--dim); display:flex; gap:16px; flex-wrap:wrap; }
.topbar .meta span strong { color:#8090a8; }

/* ---- Scrollable content ---- */
.content { flex:1; overflow-y:auto; padding:20px 24px 32px; display:flex; flex-direction:column; gap:20px; }

/* ---- ISP uplink monitoring ---- */
.isp-panel {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 4px;
}
.isp-card {
  background: linear-gradient(150deg, #171b34, #1c2148);
  border: 1px solid #2c3568; border-radius: 12px;
  padding: 16px 18px; position: relative; overflow: hidden;
  display: flex; flex-direction: column; gap: 8px;
}
.isp-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
  background: var(--isp-up);
}
.isp-card[data-online="false"]::before { background: var(--isp-down); }
.isp-card[data-online="null"]::before  { background: var(--isp-accent); }
.isp-top { display: flex; align-items: center; gap: 6px; }
.isp-status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--isp-up); box-shadow: 0 0 6px var(--isp-up);
}
.isp-card[data-online="false"] .isp-status-dot { background: var(--isp-down); box-shadow: 0 0 6px var(--isp-down); }
.isp-card[data-online="null"] .isp-status-dot  { background: var(--isp-accent); box-shadow: 0 0 6px var(--isp-accent); }
.isp-status-label {
  font-size: 10px; font-weight: 700; letter-spacing: .6px;
  color: #7dd3fc; text-transform: uppercase;
}
.isp-card[data-online="false"] .isp-status-label { color: #fdba74; }
.isp-card[data-online="null"]  .isp-status-label { color: #c7d2fe; }
.isp-name { font-size: 14px; font-weight: 700; color: #e2e8f5; }
.isp-plan { font-size: 11px; color: #8b93b8; }
.isp-ip   { font-size: 11px; color: #7a85a0; font-family: monospace; }
.isp-latency { font-size: 13px; color: var(--isp-up); font-weight: 700; margin-top: auto; }
.isp-card[data-online="false"] .isp-latency { color: var(--isp-down); }
.isp-card[data-online="null"]  .isp-latency { color: var(--isp-accent); }

/* ---- Overview: left big live card + right 2x2 history grid ---- */
.overview-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 20px;
}

/* Big live card (left half) */
.live-card {
  background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  padding: 28px; cursor: pointer; transition: border-color .2s, background .2s;
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 320px;
}
.live-card:hover    { border-color: var(--accent); background: var(--card2); }
.live-card.selected { border-color: var(--accent); background: var(--card2); }
.live-card.selected::before {
  content:''; position:absolute; left:0; top:0; bottom:0; width:4px;
  background: var(--accent); border-radius: 12px 0 0 12px;
}
.lc-header {
  align-self: flex-start; margin-bottom: 24px;
}
.lc-label {
  font-size: 13px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .7px; color: #e2e8f5;
}
.lc-sub {
  font-size: 12px; color: #7a85a0; margin-top: 3px;
}
.lc-donut-wrap { position: relative; margin-bottom: 28px; }
.lc-donut-wrap svg { display: block; }
.lc-donut-center {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; pointer-events: none;
}
.lc-big-num { font-size: 48px; font-weight: 700; line-height: 1; color: var(--text); }
.lc-big-lbl { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin-top: 5px; }
.lc-stats   { display: flex; gap: 36px; }
.lc-stat    { text-align: center; }
.lc-stat-n  { font-size: 32px; font-weight: 700; line-height: 1; }
.lc-stat-n.green { color: var(--green); }
.lc-stat-n.red   { color: var(--red); }
.lc-stat-l  { font-size: 12px; color: #9aa8c0; margin-top: 5px; text-transform: uppercase; letter-spacing: .4px; }

/* Right 2×2 history grid */
.history-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 14px;
}

/* History cards */
.dcard {
  background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  padding: 18px 20px; cursor: pointer; transition: border-color .2s, background .2s;
  position: relative; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between;
}
.dcard:hover    { border-color: var(--accent); background: var(--card2); }
.dcard.selected { border-color: var(--accent); background: var(--card2); }
.dcard.selected::before {
  content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background: var(--accent); border-radius: 10px 0 0 10px;
}
.dcard-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; color: #e2e8f5; margin-bottom: 14px; }
.dcard-body  { display: flex; align-items: center; gap: 16px; flex: 1; }

/* Donut (history cards) */
.donut-wrap { position: relative; flex-shrink: 0; }
.donut-wrap svg { display: block; }
.donut-center {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; pointer-events: none;
}
.donut-num { font-size: 20px; font-weight: 700; line-height: 1; }
.donut-lbl { font-size: 9px; color: var(--dim); text-transform: uppercase; margin-top: 3px; letter-spacing: .4px; }

.dcard-counts { display: flex; flex-direction: column; gap: 10px; flex: 1; }
.count-row    { display: flex; align-items: center; gap: 9px; }
.count-dot    { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.count-dot.green { background: var(--green); box-shadow: 0 0 5px var(--green)44; }
.count-dot.red   { background: var(--red); }
.count-num   { font-size: 22px; font-weight: 700; line-height: 1; min-width: 36px; }
.count-label { color: #9aa8c0; font-size: 12px; font-weight: 500; }

/* ---- Section header ---- */
.section-header { display:flex; align-items:center; gap:12px; margin-bottom:2px; }
.section-title  { font-size:13px; font-weight:600; color:#8090a8; text-transform:uppercase; letter-spacing:.5px; }
.section-line   { flex:1; height:1px; background:var(--border); }

/* ---- Toolbar ---- */
.toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.tb-input {
  background:var(--card2); border:1px solid var(--border); border-radius:7px;
  padding:7px 12px; color:var(--text); font-size:13px; width:210px; outline:none;
}
.tb-input:focus { border-color:var(--accent); }
.tb-btn {
  background:var(--card2); border:1px solid var(--border); border-radius:7px;
  padding:7px 13px; color:var(--dim); font-size:12px; cursor:pointer; transition:all .15s; white-space:nowrap;
}
.tb-btn.active { background:var(--accent); border-color:var(--accent); color:#fff; }
.tb-btn:hover:not(.active) { border-color:var(--accent); color:var(--text); }
.tb-divider { width:1px; height:24px; background:var(--border); }
.tb-select {
  background:var(--card2); border:1px solid var(--border); border-radius:7px;
  padding:7px 12px; color:var(--text); font-size:12px; outline:none; cursor:pointer;
}
.tb-select:focus { border-color:var(--accent); }
label.tb-label { font-size:11px; color:var(--dim); }

/* ---- Table ---- */
.table-wrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
thead th {
  text-align:left; padding:9px 12px; font-size:10px; font-weight:600;
  text-transform:uppercase; letter-spacing:.5px; color:var(--dim);
  border-bottom:1px solid var(--border); cursor:pointer; user-select:none; white-space:nowrap;
  background:var(--card);
}
thead th:hover { color:#8090a8; }
thead th .arr { margin-left:3px; opacity:.3; }
thead th.sorted .arr { opacity:1; color:var(--accent); }
tbody tr { border-bottom:1px solid #151720; transition:background .1s; }
tbody tr:hover { background:var(--card2); }
tbody tr.new-offline { animation:rowpop 2.5s ease-out forwards; }
@keyframes rowpop { 0%{background:#7f1d1d44} 100%{background:transparent} }
tbody td { padding:9px 12px; color:#9aa3bc; vertical-align:middle; }

/* Status badges */
.badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:20px; font-size:11px; font-weight:600; }
.badge::before { content:''; width:6px; height:6px; border-radius:50%; }
.badge.online  { background:#14532d33; color:#4ade80; border:1px solid #166534; }
.badge.offline { background:#7f1d1d33; color:#f87171; border:1px solid #991b1b; }
.badge.online::before  { background:var(--green); box-shadow:0 0 4px var(--green); }
.badge.offline::before { background:var(--red); }

.src-tag { display:inline-block; font-size:9px; padding:1px 5px; border-radius:3px; margin-left:5px; font-weight:600; vertical-align:middle; }
.src-tag.secret { background:#1e3a5f; color:#60a5fa; border:1px solid #1e40af; }
.src-tag.poll   { background:#2d2a1e; color:#fbbf24; border:1px solid #78350f; }

.mono  { font-family:monospace; font-size:12px; }
.bold  { font-weight:600; color:#c8d0e0; }

#error-bar { display:none; background:#7f1d1d; color:#fca5a5; padding:9px 24px; font-size:12px; }
#error-bar.active { display:block; }
#no-results { text-align:center; color:var(--dim); padding:36px; font-size:13px; }
</style>
</head>
<body>

<div id="alert-banner">
  <span>⚠️ ALARM — <span id="al-count">0</span> subscribers went offline TODAY and are still down! Since: <span id="al-since">—</span></span>
  <button id="mute-btn" onclick="toggleMute()">🔇 Mute</button>
</div>

<div id="app">

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="slogo">📡</div>
    <div class="snav active" id="snav-dash" onclick="setView('dashboard')">
      ⊞ <span class="stip">Dashboard</span>
    </div>
    <div class="snav" id="snav-table" onclick="setView('table')">
      ☰ <span class="stip">Account List</span>
    </div>
  </nav>

  <!-- Main -->
  <div class="main">
    <div id="error-bar"></div>

    <!-- Top bar -->
    <div class="topbar">
      <h1>📡 StarLine Internet Customer Uptime Monitor <span style="font-size:12px;color:var(--dim);font-weight:400" id="tb-host"></span></h1>
      <div class="meta">
        <span>Last poll: <strong id="tb-poll">—</strong></span>
        <span>Next: <strong id="tb-next">—</strong>s</span>
        <span>Interval: <strong id="tb-interval">—</strong>s</span>
        <span>Alert at: <strong id="tb-thresh">—</strong>+ offline</span>
        <span>Billing: <strong id="tb-billing">—</strong></span>
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="content">

      <!-- Dashboard view -->
      <div id="view-dashboard">

        <div class="section-header"><span class="section-title">ISP Links</span><div class="section-line"></div></div>

        <div class="isp-panel" id="isp-panel"></div>

        <div class="section-header"><span class="section-title">Overview</span><div class="section-line"></div></div>

        <div class="overview-panel">

          <!-- LEFT: Big live status card -->
          <div class="live-card selected" id="card-live" onclick="selectCard('live')">
            <div class="lc-header">
              <div class="lc-label">All Accounts — Live Status</div>
              <div class="lc-sub" id="lc-router">Connecting…</div>
            </div>
            <div class="lc-donut-wrap">
              <svg id="svg-live" width="180" height="180" viewBox="0 0 180 180"></svg>
              <div class="lc-donut-center">
                <div class="lc-big-num" id="dn-live">—</div>
                <div class="lc-big-lbl">Total</div>
              </div>
            </div>
            <div class="lc-stats">
              <div class="lc-stat">
                <div class="lc-stat-n green" id="cn-live-on">—</div>
                <div class="lc-stat-l">🟢 Online</div>
              </div>
              <div class="lc-stat">
                <div class="lc-stat-n red" id="cn-live-off">—</div>
                <div class="lc-stat-l">🔴 Offline</div>
              </div>
            </div>
          </div>

          <!-- RIGHT: 2×2 history cards -->
          <div class="history-grid">

            <div class="dcard" id="card-today" onclick="selectCard('today')">
              <div class="dcard-title">Today</div>
              <div class="dcard-body">
                <div class="donut-wrap">
                  <svg id="svg-today" width="90" height="90" viewBox="0 0 90 90"></svg>
                  <div class="donut-center"><div class="donut-num" id="dn-today">—</div><div class="donut-lbl">Events</div></div>
                </div>
                <div class="dcard-counts">
                  <div class="count-row"><div class="count-dot red"></div><div class="count-num" id="cn-today-off">—</div><div class="count-label">Still Down</div></div>
                  <div class="count-row"><div class="count-dot green"></div><div class="count-num" id="cn-today-on">—</div><div class="count-label">Recovered</div></div>
                </div>
              </div>
            </div>

            <div class="dcard" id="card-week" onclick="selectCard('week')">
              <div class="dcard-title">This Week</div>
              <div class="dcard-body">
                <div class="donut-wrap">
                  <svg id="svg-week" width="90" height="90" viewBox="0 0 90 90"></svg>
                  <div class="donut-center"><div class="donut-num" id="dn-week">—</div><div class="donut-lbl">Events</div></div>
                </div>
                <div class="dcard-counts">
                  <div class="count-row"><div class="count-dot red"></div><div class="count-num" id="cn-week-off">—</div><div class="count-label">Still Down</div></div>
                  <div class="count-row"><div class="count-dot green"></div><div class="count-num" id="cn-week-on">—</div><div class="count-label">Recovered</div></div>
                </div>
              </div>
            </div>

            <div class="dcard" id="card-month" onclick="selectCard('month')">
              <div class="dcard-title">This Month</div>
              <div class="dcard-body">
                <div class="donut-wrap">
                  <svg id="svg-month" width="90" height="90" viewBox="0 0 90 90"></svg>
                  <div class="donut-center"><div class="donut-num" id="dn-month">—</div><div class="donut-lbl">Events</div></div>
                </div>
                <div class="dcard-counts">
                  <div class="count-row"><div class="count-dot red"></div><div class="count-num" id="cn-month-off">—</div><div class="count-label">Still Down</div></div>
                  <div class="count-row"><div class="count-dot green"></div><div class="count-num" id="cn-month-on">—</div><div class="count-label">Recovered</div></div>
                </div>
              </div>
            </div>

            <div class="dcard" id="card-year" onclick="selectCard('year')">
              <div class="dcard-title">This Year</div>
              <div class="dcard-body">
                <div class="donut-wrap">
                  <svg id="svg-year" width="90" height="90" viewBox="0 0 90 90"></svg>
                  <div class="donut-center"><div class="donut-num" id="dn-year">—</div><div class="donut-lbl">Events</div></div>
                </div>
                <div class="dcard-counts">
                  <div class="count-row"><div class="count-dot red"></div><div class="count-num" id="cn-year-off">—</div><div class="count-label">Still Down</div></div>
                  <div class="count-row"><div class="count-dot green"></div><div class="count-num" id="cn-year-on">—</div><div class="count-label">Recovered</div></div>
                </div>
              </div>
            </div>

          </div><!-- /history-grid -->
        </div><!-- /overview-panel -->

        <div class="section-header"><span class="section-title" id="table-section-title">All Accounts — Live</span><div class="section-line"></div></div>

      </div>
      <!-- /Dashboard view -->

      <!-- Toolbar (always shown) -->
      <div class="toolbar">
        <input class="tb-input" id="search" type="text" placeholder="Search username, customer, account #, area, NAP…" oninput="applyDisplay()">
        <div class="tb-divider" id="filt-div"></div>
        <span id="filt-btns">
          <button class="tb-btn active" id="btn-all"     onclick="setFilter('all')">All</button>
          <button class="tb-btn"        id="btn-online"  onclick="setFilter('online')">🟢 Online</button>
          <button class="tb-btn"        id="btn-offline" onclick="setFilter('offline')">🔴 Offline</button>
        </span>
        <div class="tb-divider"></div>
        <label class="tb-label">Sort:</label>
        <select class="tb-select" id="sort-select" onchange="applyDisplay()">
          <option value="offline-recent">Offline — recent logout first</option>
          <option value="offline-oldest">Offline — oldest logout first</option>
          <option value="status-az">Status (offline → online)</option>
          <option value="username-az">Username A–Z</option>
          <option value="username-za">Username Z–A</option>
          <option value="customer-az">Customer A–Z</option>
          <option value="lastseen-desc">Last Seen (newest)</option>
        </select>
      </div>

      <!-- Table -->
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th onclick="setSort('status-az')">Status <span class="arr" id="arr-status"></span></th>
              <th onclick="setSort('username-az')">Username <span class="arr" id="arr-username"></span></th>
              <th onclick="setSort('customer-az')">Customer <span class="arr" id="arr-customer"></span></th>
              <th>Account #</th>
              <th>Contact #</th>
              <th>Area</th>
              <th>NAP Box</th>
              <th>Profile</th>
              <th>Remote IP</th>
              <th>Comment</th>
              <th onclick="setSort('lastseen-desc')">Last Seen <span class="arr" id="arr-lastseen"></span></th>
              <th onclick="setSort('offline-recent')">Logged Out At <span class="arr" id="arr-logout"></span></th>
            </tr>
          </thead>
          <tbody id="tbody"></tbody>
        </table>
        <div id="no-results"></div>
      </div>

    </div><!-- /content -->
  </div><!-- /main -->
</div><!-- /app -->

<script>
// ---- State ----
let allAccounts   = [];
let selectedCard  = 'live';
let currentFilter = 'all';
let currentView   = 'dashboard';
let muted         = false;
let alarmCtx      = null;
let alarmTimer    = null;
let wasAlert      = false;
let cdTimer       = null;

// ---- SSE ----
const evtSource = new EventSource('/events');
evtSource.onmessage = e => render(JSON.parse(e.data));
evtSource.onerror   = () => {
  document.getElementById('error-bar').textContent = 'Lost connection — is node monitor.js still running?';
  document.getElementById('error-bar').classList.add('active');
};

// ---- Audio ----
function getACtx()  { if (!alarmCtx) alarmCtx = new (window.AudioContext||window.webkitAudioContext)(); return alarmCtx; }
function beep(f,t,d,ctx) {
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.type='square'; o.frequency.setValueAtTime(f,t);
  g.gain.setValueAtTime(.15,t); g.gain.exponentialRampToValueAtTime(.001,t+d);
  o.start(t); o.stop(t+d);
}
function playAlarm() { if(muted) return; try{ const c=getACtx(),t=c.currentTime; beep(1047,t,.15,c); beep(880,t+.2,.15,c); beep(1047,t+.4,.15,c); }catch(e){} }
function startAlarm() { if(alarmTimer) return; playAlarm(); alarmTimer=setInterval(playAlarm,2200); }
function stopAlarm()  { clearInterval(alarmTimer); alarmTimer=null; }
function toggleMute() {
  muted=!muted;
  document.getElementById('mute-btn').textContent = muted ? '🔔 Unmute' : '🔇 Mute';
  if(muted) stopAlarm(); else if(wasAlert) startAlarm();
}

// ---- ISP links panel ----
function renderIsps(isps) {
  const panel = document.getElementById('isp-panel');
  if (!panel) return;
  if (!isps || !isps.length) {
    panel.innerHTML = '<div style="color:var(--dim);font-size:12px;">No ISP links configured.</div>';
    return;
  }
  panel.innerHTML = isps.map(isp => {
    const state = isp.online === null ? 'null' : (isp.online ? 'true' : 'false');
    const label = isp.online === null ? 'Checking…' : (isp.online ? 'Online' : 'Offline');
    const lat   = isp.online && isp.latencyMs != null ? Math.round(isp.latencyMs) + ' ms' : '—';
    return \`<div class="isp-card" data-online="\${state}">
      <div class="isp-top">
        <span class="isp-status-dot"></span>
        <span class="isp-status-label">\${label}</span>
      </div>
      <div class="isp-name">\${esc(isp.name)}</div>
      <div class="isp-plan">\${esc(isp.plan)}</div>
      <div class="isp-ip">\${esc(isp.ip)}</div>
      <div class="isp-latency">\${lat}</div>
    </div>\`;
  }).join('');
}

// ---- Donut chart ----
function drawDonut(svgId, good, bad, total) {
  const svg = document.getElementById(svgId);
  if (!svg) return;

  // Detect size from viewBox: large (180) for live card, small (90) for history
  const size = parseInt(svg.getAttribute('viewBox').split(' ')[2]);
  const isLarge = size >= 180;
  const cx = size/2, cy = size/2;
  const r  = isLarge ? 68 : 32;
  const sw = isLarge ? 18 : 11;

  const circ = 2 * Math.PI * r;
  const track = \`<circle cx="\${cx}" cy="\${cy}" r="\${r}" fill="none" stroke="#252840" stroke-width="\${sw}"/>\`;

  if (total === 0) {
    svg.innerHTML = track;
    return;
  }

  const badRatio  = bad  / total;
  const goodRatio = good / total;
  const badDash   = badRatio  * circ;
  const goodDash  = goodRatio * circ;

  const badArc = bad > 0
    ? \`<circle cx="\${cx}" cy="\${cy}" r="\${r}" fill="none" stroke="#e84040" stroke-width="\${sw}"
        stroke-dasharray="\${badDash} \${circ - badDash}"
        transform="rotate(-90 \${cx} \${cy})"/>\`
    : '';

  const greenRotate = -90 + (badRatio * 360);
  const goodArc = good > 0
    ? \`<circle cx="\${cx}" cy="\${cy}" r="\${r}" fill="none" stroke="#8dc63f" stroke-width="\${sw}"
        stroke-dasharray="\${goodDash} \${circ - goodDash}"
        transform="rotate(\${greenRotate} \${cx} \${cy})"/>\`
    : '';

  svg.innerHTML = track + badArc + goodArc;
}

// ---- Period helpers ----
function inPeriod(iso, p) {
  if (!iso) return false;
  const d = new Date(iso), now = new Date();
  switch(p) {
    case 'today': return d.toDateString() === now.toDateString();
    case 'week':  { const m=new Date(now); m.setHours(0,0,0,0); m.setDate(now.getDate()-((now.getDay()+6)%7)); return d>=m; }
    case 'month': return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    case 'year':  return d.getFullYear()===now.getFullYear();
    default: return false;
  }
}

// ---- Format ----
function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})
       + ' ' + d.toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---- Render from SSE ----
function render(data) {
  const eb = document.getElementById('error-bar');
  if (data.pollError) { eb.textContent='⚠ Router poll error: '+data.pollError; eb.classList.add('active'); }
  else eb.classList.remove('active');

  const banner = document.getElementById('alert-banner');
  if (data.alertActive) {
    document.getElementById('al-count').textContent = data.todayDownCount;
    document.getElementById('al-since').textContent = fmt(data.alertSince);
    banner.classList.add('active');
    if (!wasAlert) startAlarm();
  } else { banner.classList.remove('active'); stopAlarm(); }
  wasAlert = data.alertActive;

  document.getElementById('tb-host').textContent     = data.routerHost;
  if (document.getElementById('lc-router')) document.getElementById('lc-router').textContent = data.routerHost;
  document.getElementById('tb-poll').textContent     = fmt(data.lastPoll);
  document.getElementById('tb-interval').textContent = data.pollIntervalSec;
  document.getElementById('tb-thresh').textContent   = data.alertThreshold;
  document.getElementById('tb-billing').textContent  = !data.billingEnabled
    ? 'not configured'
    : (data.billingError ? '⚠ ' + data.billingError : (data.billingCustomerCount + ' customers synced ' + fmt(data.billingLastSync)));

  clearInterval(cdTimer);
  let rem = data.pollIntervalSec || 10;
  document.getElementById('tb-next').textContent = rem;
  cdTimer = setInterval(() => { rem=Math.max(0,rem-1); document.getElementById('tb-next').textContent=rem; }, 1000);

  allAccounts = data.accounts || [];
  updateCards();
  applyDisplay();
  renderIsps(data.isps);
}

// ---- Update donut cards ----
function updateCards() {
  const total   = allAccounts.length;
  const offline = allAccounts.filter(a=>a.status==='offline').length;
  const online  = total - offline;

  // Live card
  document.getElementById('dn-live').textContent    = total;
  document.getElementById('cn-live-on').textContent  = online;
  document.getElementById('cn-live-off').textContent = offline;
  drawDonut('svg-live', online, offline, total);

  // Period cards
  ['today','week','month','year'].forEach(p => {
    const inP    = allAccounts.filter(a => a.lastLogout && inPeriod(a.lastLogout, p));
    const pTotal = inP.length;
    const pDown  = inP.filter(a=>a.status==='offline').length;
    const pBack  = pTotal - pDown;

    document.getElementById('dn-'+p).textContent       = pTotal;
    document.getElementById('cn-'+p+'-off').textContent = pDown;
    document.getElementById('cn-'+p+'-on').textContent  = pBack;
    drawDonut('svg-'+p, pBack, pDown, pTotal);
  });
}

// ---- Card selection ----
function selectCard(id) {
  selectedCard = id;
  document.querySelectorAll('.dcard').forEach(c => c.classList.remove('selected'));
  document.getElementById('card-'+id).classList.add('selected');

  const isLive = id === 'live';
  document.getElementById('filt-btns').style.display = isLive ? '' : 'none';
  document.getElementById('filt-div').style.display  = isLive ? '' : 'none';

  const labels = { live:'All Accounts — Live', today:"Today's Outages", week:"This Week's Outages", month:"This Month's Outages", year:"This Year's Outages" };
  document.getElementById('table-section-title').textContent = labels[id] || id;

  if (!isLive) document.getElementById('sort-select').value = 'offline-recent';
  applyDisplay();
}

// ---- View switching (sidebar) ----
function setView(v) {
  currentView = v;
  document.getElementById('view-dashboard').style.display = v==='dashboard' ? '' : 'none';
  document.getElementById('snav-dash').classList.toggle('active',  v==='dashboard');
  document.getElementById('snav-table').classList.toggle('active', v==='table');
  if (v==='table') { document.getElementById('filt-btns').style.display=''; document.getElementById('filt-div').style.display=''; }
}

// ---- Filter ----
function setFilter(f) {
  currentFilter = f;
  ['all','online','offline'].forEach(id => document.getElementById('btn-'+id).classList.toggle('active', id===f));
  applyDisplay();
}

// ---- Sort ----
function setSort(val) { document.getElementById('sort-select').value=val; applyDisplay(); }

const ARROW_CFG = {
  'offline-recent':{col:'logout',  dir:'▼'},
  'offline-oldest':{col:'logout',  dir:'▲'},
  'status-az':     {col:'status',  dir:'▲'},
  'username-az':   {col:'username',dir:'▲'},
  'username-za':   {col:'username',dir:'▼'},
  'lastseen-desc': {col:'lastseen',dir:'▼'},
  'customer-az':   {col:'customer',dir:'▲'},
};
function updateArrows(v) {
  ['status','username','customer','lastseen','logout'].forEach(c => {
    const el=document.getElementById('arr-'+c); el.textContent=''; el.parentElement.classList.remove('sorted');
  });
  const cfg=ARROW_CFG[v];
  if(cfg){ const el=document.getElementById('arr-'+cfg.col); el.textContent=cfg.dir; el.parentElement.classList.add('sorted'); }
}

function sortAccounts(list, v) {
  const ts = i => i ? new Date(i).getTime() : 0;
  const c  = [...list];
  switch(v) {
    case 'offline-recent': return c.sort((a,b)=>{ if(a.status!==b.status) return a.status==='offline'?-1:1; if(a.status==='offline') return ts(b.lastLogout)-ts(a.lastLogout); return a.username.localeCompare(b.username); });
    case 'offline-oldest': return c.sort((a,b)=>{ if(a.status!==b.status) return a.status==='offline'?-1:1; if(a.status==='offline') return ts(a.lastLogout)-ts(b.lastLogout); return a.username.localeCompare(b.username); });
    case 'status-az':      return c.sort((a,b)=> a.status!==b.status?a.status.localeCompare(b.status):a.username.localeCompare(b.username));
    case 'username-az':    return c.sort((a,b)=> a.username.localeCompare(b.username));
    case 'username-za':    return c.sort((a,b)=> b.username.localeCompare(a.username));
    case 'lastseen-desc':  return c.sort((a,b)=> ts(b.lastSeen)-ts(a.lastSeen));
    case 'customer-az':    return c.sort((a,b)=> (a.customerName||'').localeCompare(b.customerName||''));
    default: return c;
  }
}

// ---- Main display ----
function applyDisplay() {
  const q   = document.getElementById('search').value.toLowerCase();
  const sv  = document.getElementById('sort-select').value;
  updateArrows(sv);

  let list;

  const matchesQuery = a => !q
    || a.username.toLowerCase().includes(q)
    || (a.comment||'').toLowerCase().includes(q)
    || (a.remoteIp||'').includes(q)
    || (a.profile||'').toLowerCase().includes(q)
    || (a.customerName||'').toLowerCase().includes(q)
    || (a.accountNo||'').toLowerCase().includes(q)
    || (a.contactNo||'').toLowerCase().includes(q)
    || (a.area||'').toLowerCase().includes(q)
    || (a.napBox||'').toLowerCase().includes(q);

  if (selectedCard === 'live' || currentView === 'table') {
    list = allAccounts.filter(a => {
      const mf = currentFilter==='all' || a.status===currentFilter;
      return mf && matchesQuery(a);
    });
    list = sortAccounts(list, sv);
  } else {
    list = allAccounts.filter(a => {
      const inP = a.lastLogout && inPeriod(a.lastLogout, selectedCard);
      return inP && matchesQuery(a);
    });
    list = list.sort((a,b) => { const ts=i=>i?new Date(i).getTime():0; return ts(b.lastLogout)-ts(a.lastLogout); });
    if (sv !== 'offline-recent') list = sortAccounts(list, sv);
  }

  const tbody = document.getElementById('tbody');
  const nr    = document.getElementById('no-results');

  if (list.length === 0) {
    tbody.innerHTML = '';
    nr.textContent  = selectedCard==='live' ? 'No accounts match your filter.' : 'No outages recorded for this period.';
    return;
  }
  nr.textContent = '';

  tbody.innerHTML = list.map(a => {
    const src = a.lastLogout
      ? \`\${fmt(a.lastLogout)} <span class="src-tag \${a.logSource||'poll'}">\${a.logSource==='secret'?'SECRET':'POLL'}</span>\`
      : '—';
    return \`<tr class="\${selectedCard==='live' && a.status==='offline' ? 'new-offline' : ''}">
      <td><span class="badge \${a.status}">\${a.status}</span></td>
      <td class="bold mono">\${esc(a.username)}</td>
      <td style="font-size:12px">\${esc(a.customerName)||'—'}</td>
      <td class="mono" style="color:var(--dim);font-size:12px">\${esc(a.accountNo)||'—'}</td>
      <td class="mono" style="color:var(--dim);font-size:12px">\${esc(a.contactNo)||'—'}</td>
      <td style="color:var(--dim);font-size:12px">\${esc(a.area)||'—'}</td>
      <td style="color:var(--dim);font-size:12px">\${esc(a.napBox)||'—'}</td>
      <td style="color:var(--dim);font-size:12px">\${esc(a.profile)||'—'}</td>
      <td class="mono" style="color:var(--dim);font-size:12px">\${esc(a.remoteIp)||'—'}</td>
      <td style="color:var(--dim);font-size:12px">\${esc(a.comment)||'—'}</td>
      <td style="color:var(--dim);font-size:12px">\${fmt(a.lastSeen)}</td>
      <td style="font-size:12px">\${src}</td>
    </tr>\`;
  }).join('');
}
</script>
</body>
</html>`;
}

// ---------- HTTP Server ----------

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  // Debug: view raw PPPoE log entries from the router
  // Open http://localhost:3000/api/logs in your browser to inspect
  if (req.url === '/api/logs') {
    (async () => {
      try {
        const logs = await routerGet('/log');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // Debug: view raw ISP ping results
  // Open http://localhost:3000/api/isps in your browser to inspect
  if (req.url === '/api/isps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.isps, null, 2));
    return;
  }

  // Debug: view the customer index pulled from TaokiNinam billing
  // Open http://localhost:3000/api/customers in your browser to inspect
  if (req.url === '/api/customers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(customerIndex), null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(dashboardHtml());
});

server.listen(DASHBOARD_PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         Mikrotik PPPoE Monitor               ║
╠══════════════════════════════════════════════╣
║  Dashboard  →  http://localhost:${DASHBOARD_PORT}        ║
║  Router     →  ${BASE_URL.padEnd(30)} ║
║  Polling every ${Math.round(POLL_INTERVAL_MS/1000)}s                           ║
║  Alert when ${ALERT_THRESHOLD}+ accounts offline              ║
╚══════════════════════════════════════════════╝

Offline time source:
  [LOG]  = exact timestamp from Mikrotik log (/log)
  [POLL] = fallback (log entry not found for that user)
`);
  (async () => {
    if (BILLING_ENABLED) await syncBilling(); // load customer data before first render
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
    if (BILLING_ENABLED) setInterval(syncBilling, BILLING_SYNC_MS);
    pollIsps();
    setInterval(pollIsps, POLL_INTERVAL_MS);
  })();
});
