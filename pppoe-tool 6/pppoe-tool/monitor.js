/**
 * monitor.js
 *
 * Monitors PPPoE accounts for StarLine Internet.
 *
 * Online/offline status and exact "logged out at" timestamps come directly
 * from the Mikrotik router itself, over SSH — monitor.js runs `/ppp active
 * print` and `/ppp secret print` on the router's CLI via an SSH connection.
 * This works from anywhere, including cloud hosts like Railway, as long as
 * the router's SSH port is reachable — for StarLine that's the remote-access
 * provider's relayed SSH port (remoteanyx888.jrandombytes.com:26248), the
 * same port TaokiNinam itself uses to reach the router.
 *
 * Customer info (name, account number, contact number, area, NAP box) is
 * an OPTIONAL enrichment layer sourced from the TaokiNinam billing system
 * (activesP.php / inactivesP.php), matched onto router accounts by PPPoE
 * username. If TaokiNinam isn't configured or its fetch fails, monitoring
 * still works fine — those fields are just left blank. Router status/
 * timestamps never depend on TaokiNinam being up.
 *
 * "Logged out at" times come straight from each PPP secret's own
 * "last-logged-out" field (the same value Winbox shows under PPP > Secrets
 * > Last Logged Out) — no log-scraping or guesswork involved. If that field
 * is ever empty, it falls back to recording the time monitor.js itself
 * first observed the account go offline. The dashboard tags each time as
 * SECRET (from the router) or POLL (detected locally) accordingly.
 *
 * Also monitors ISP uplinks by pinging their gateway IPs directly from
 * this machine (edit the ISP_LINKS array below to add/remove/rename links).
 * Note: this only reflects real uplink status when monitor.js runs on the
 * same network as those links — running it in the cloud would just test
 * the cloud host's own connectivity to those IPs.
 *
 * MIKROTIK_HOST/PORT/USER/PASSWORD (used by create_pppoe_accounts.js, the
 * separate bulk provisioner, over the REST API) are NOT used by this file.
 * This file uses its own MIKROTIK_SSH_* vars, since it talks to the router
 * over SSH rather than the REST API.
 *
 * Usage:
 *   node monitor.js
 *   Open http://localhost:3000 in your browser
 *
 * .env options:
 *   MIKROTIK_SSH_HOST=remoteanyx888.jrandombytes.com   (required)
 *   MIKROTIK_SSH_PORT=26248                            (required)
 *   MIKROTIK_SSH_USER=admin                            (required) same router admin login
 *   MIKROTIK_SSH_PASSWORD=yourpassword                 (required)
 *   TAOKININAM_USERNAME=you@example.com   (optional) enables customer-info enrichment
 *   TAOKININAM_PASSWORD=yourpassword      (optional)
 *   TAOKININAM_BASE_URL=https://taokininam.com   (optional, this is the default)
 *   MONITOR_PORT=3000                     (optional; PORT env var wins if set)
 *   MONITOR_POLL_INTERVAL=30              seconds between polls
 *   MONITOR_ALERT_THRESHOLD=5             how many offline (since today) triggers the alarm
 *   BILLING_DEBUG=true                    (optional) verbose TaokiNinam login/fetch logging
 */

require('dotenv').config();
const http = require('http');
const { NodeSSH } = require('node-ssh');

// ---------- Config ----------

// Railway (and most PaaS hosts) inject PORT and require the app to bind to
// it. Fall back to MONITOR_PORT / 3000 for local runs.
const DASHBOARD_PORT   = parseInt(process.env.PORT || process.env.MONITOR_PORT || '3000');
const POLL_INTERVAL_MS = parseInt(process.env.MONITOR_POLL_INTERVAL || '30') * 1000;
const ALERT_THRESHOLD  = parseInt(process.env.MONITOR_ALERT_THRESHOLD || '5');
const FETCH_TIMEOUT_MS = parseInt(process.env.MONITOR_FETCH_TIMEOUT_MS || '15000');

// ---- Router SSH connection (primary source — live status + exact log timestamps) ----
const SSH_HOST     = process.env.MIKROTIK_SSH_HOST;
const SSH_PORT     = parseInt(process.env.MIKROTIK_SSH_PORT || '22');
const SSH_USER     = process.env.MIKROTIK_SSH_USER;
const SSH_PASSWORD = process.env.MIKROTIK_SSH_PASSWORD;
const SSH_TIMEOUT_MS = parseInt(process.env.MIKROTIK_SSH_TIMEOUT_MS || '15000');

if (!SSH_HOST || !SSH_USER || !SSH_PASSWORD) {
  console.error('Missing MIKROTIK_SSH_HOST, MIKROTIK_SSH_USER or MIKROTIK_SSH_PASSWORD in .env — these are required (monitor.js talks to the router over SSH).');
  process.exit(1);
}

// ---- TaokiNinam billing system (OPTIONAL — customer-info enrichment only) ----
// If unset, monitoring still works fully via SSH; customer name/account/
// contact/area/NAP box just stay blank.
const BILLING_BASE_URL = (process.env.TAOKININAM_BASE_URL || 'https://taokininam.com').replace(/\/$/, '');
const BILLING_USERNAME = process.env.TAOKININAM_USERNAME;
const BILLING_PASSWORD = process.env.TAOKININAM_PASSWORD;
const BILLING_DEBUG    = String(process.env.BILLING_DEBUG || '').toLowerCase() === 'true';
const BILLING_ENABLED  = Boolean(BILLING_USERNAME && BILLING_PASSWORD);

// ---- ISP uplink monitoring (pings each gateway IP directly from this machine) ----
// Edit this list to add/remove/rename ISP links.
const ISP_LINKS = [
  { name: 'Globe 1Gbps',        ip: '222.127.255.192', plan: '1Gbps'   },
  { name: 'Globe Biz+ 500Mbps', ip: '180.191.137.7',    plan: '500Mbps' },
  { name: 'Globe Biz 500Mbps',  ip: '180.191.229.3',    plan: '500Mbps' },
  { name: 'PLDT 500Mbps',       ip: '115.147.14.124',   plan: '500Mbps' },
  { name: 'PLDT SME - 500 Mbps', ip: '122.3.130.109',   plan: '500Mbps' },
];
const ISP_PING_TIMEOUT_MS = parseInt(process.env.ISP_PING_TIMEOUT_MS || '2000');

if (!BILLING_ENABLED) {
  console.warn('TAOKININAM_USERNAME / TAOKININAM_PASSWORD not set — running without billing enrichment (customer name/account/contact/area/NAP box will be blank).');
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
  routerHost: `${SSH_HOST}:${SSH_PORT} (SSH)`,
  pollIntervalSec: Math.round(POLL_INTERVAL_MS / 1000),
  alertThreshold: ALERT_THRESHOLD,
  billingEnabled: BILLING_ENABLED,
  billingLastSync: null,
  billingError: null,
  billingCustomerCount: 0,
  isps: ISP_LINKS.map(isp => ({ ...isp, online: null, latencyMs: null })),
  ispsLastCheck: null,
};

const sseClients = new Set();

// ---------- Shared fetch helpers ----------

// Node's fetch collapses DNS failures, connection refused, TLS errors, and
// timeouts into one generic "fetch failed" message. Surface the real reason
// (from err.cause) so poll errors are actually actionable.
function describeFetchError(err) {
  const cause = err && err.cause;
  if (err && err.name === 'TimeoutError') return `timed out after ${FETCH_TIMEOUT_MS}ms connecting to ${BILLING_BASE_URL}`;
  if (cause && cause.code) return `${err.message} — ${cause.code}${cause.message ? ': ' + cause.message : ''}`;
  if (cause && cause.message) return `${err.message} — ${cause.message}`;
  return err ? err.message : String(err);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

// ---------- Router SSH client ----------
//
// Runs RouterOS CLI commands over SSH (the same relayed port TaokiNinam
// itself uses: remoteanyx888.jrandombytes.com:26248). RouterOS supports
// running a single command non-interactively over SSH exec, same as
// `ssh user@host '/ppp active print'` from a terminal.
//
// `print terse` output puts one record per line as `<index> key=value
// key="quoted value" ...`, which is much easier to parse reliably than the
// human-formatted table RouterOS prints by default.

async function sshExec(command) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      password: SSH_PASSWORD,
      readyTimeout: SSH_TIMEOUT_MS,
      // RouterOS (especially older RouterOS 6.x) may only offer algorithms
      // that newer ssh2 defaults don't include — widen the accepted set so
      // the handshake doesn't fail on an otherwise-reachable router.
      algorithms: {
        kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group1-sha1', 'ecdh-sha2-nistp256'],
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc'],
        serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
        hmac: ['hmac-sha2-256', 'hmac-sha1'],
      },
    });
    const result = await ssh.execCommand(command);
    if (result.code !== 0 && result.stderr) {
      throw new Error(`router returned an error for "${command}": ${result.stderr.trim()}`);
    }
    return result.stdout;
  } catch (err) {
    if (err && err.level === 'client-timeout') throw new Error(`SSH connection to ${SSH_HOST}:${SSH_PORT} timed out after ${SSH_TIMEOUT_MS}ms`);
    throw new Error(err && err.message ? err.message : String(err));
  } finally {
    ssh.dispose();
  }
}

// Parses RouterOS "print terse" output into an array of field objects.
// Each line looks like:  0   name="user1" service=pppoe address=10.0.0.5 uptime=1h2m3s
function parseTerse(output) {
  const rows = [];
  const lines = String(output || '').split('\n');
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || !/^\d+\s/.test(line)) continue; // skip blank lines / anything not starting with a record index
    // RouterOS emits date/time fields unquoted but with an embedded space
    // (e.g. `time=jul/12/2026 09:10:00` or `last-logged-out=jul/12/2026
    // 09:10:00`), which breaks the generic key=value split below —
    // normalize any such field to a quoted value first so it parses as
    // one field instead of two.
    line = line.replace(/([\w-]+)=([a-z]{3}\/\d{1,2}\/\d{4}) (\d{2}:\d{2}:\d{2})/gi, '$1="$2 $3"');
    line = line.replace(/([\w-]+)=(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/g, '$1="$2 $3"');
    const fields = {};
    const fieldRe = /(\S+?)=("(?:[^"\\]|\\.)*"|\S*)/g;
    let m;
    while ((m = fieldRe.exec(line))) {
      let val = m[2];
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
      fields[m[1]] = val;
    }
    if (Object.keys(fields).length) rows.push(fields);
  }
  return rows;
}

// ---------- TaokiNinam billing system (optional customer-info enrichment) ----------
//
// TaokiNinam is a classic PHP session-cookie app:
//   1. POST cusername/cpassword to /actions/login_check.php -> PHPSESSID cookie
//   2. GET /activesP.php and /inactivesP.php (with that cookie) -> full HTML
//      tables of currently-online and currently-offline PPPoE accounts,
//      already joined with billing/customer/NAP data server-side.
//
// Used here only to enrich router-sourced accounts with customer name,
// account number, contact number, area, and NAP box — matched onto the
// router's PPPoE username. If this fails or isn't configured, monitoring
// still works fully via SSH; these fields are just left blank.

let billingCookie = null;

async function billingLogin() {
  const loginUrl = `${BILLING_BASE_URL}/actions/login_check.php`;
  if (BILLING_DEBUG) console.log(`[billing debug] BILLING_BASE_URL = ${JSON.stringify(BILLING_BASE_URL)} | POST ${loginUrl}`);

  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; monitor.js)',
    },
    body: new URLSearchParams({ cusername: BILLING_USERNAME, cpassword: BILLING_PASSWORD, submit: '' }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);

  if (BILLING_DEBUG) {
    console.log(`[billing debug] login_check.php -> status ${res.status}, location: ${res.headers.get('location') || '(none)'}, set-cookie count: ${setCookies.length}`);
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

async function fetchSubscriberPage(path) {
  if (!billingCookie) await billingLogin();

  const url = `${BILLING_BASE_URL}/${path}`;
  const doFetch = () => fetch(url, {
    headers: {
      Cookie: billingCookie,
      'User-Agent': 'Mozilla/5.0 (compatible; monitor.js)',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  let res, text;
  try {
    res = await doFetch();
    text = await res.text();
  } catch (err) {
    throw new Error(describeFetchError(err));
  }

  // Session expired / not logged in -> the subscriber table won't be
  // present. Re-login once and retry.
  if (!/id="dataTable"/.test(text)) {
    if (BILLING_DEBUG) console.log(`[billing debug] ${path} -> status ${res.status}, no dataTable found, re-logging in`);
    await billingLogin();
    try {
      res = await doFetch();
      text = await res.text();
    } catch (err) {
      throw new Error(describeFetchError(err));
    }
    if (!/id="dataTable"/.test(text)) {
      throw new Error(`${path} did not return the subscriber table after re-login (set BILLING_DEBUG=true in .env for more detail)`);
    }
  }

  return text;
}

// Splits a TaokiNinam subscriber-table HTML page into an array of rows,
// each row being an array of raw (still-HTML) cell contents in column
// order. Column layout (0-indexed) is fixed by the page's <thead>:
//   0 Account+Name link   1 Recurring Dates   2 Mobile+Area   3 Subscription
//   4 Billing+Service     5 Credentials       6 Status+Profile 7 Balance
//   8 Area (full)         9-10 (unused)       11 Inst.Date dup 12 (unused)
//   13 billing-cycle date 14 local IP (shared) 15 (unused)
//   16 PON type           17 PON count        18 NAP box       19 NAP port
//   20-22 (unused)
function parseSubscriberRows(html) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRe.exec(html))) {
    const rowHtml = trMatch[1];
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdRe.exec(rowHtml))) cells.push(tdMatch[1]);
    if (cells.length >= 8) rows.push(cells);
  }
  return rows;
}

function extractAccount(cells) {
  const c = i => cells[i] || '';

  const nameBlock  = stripTags(c(0));
  const accountNo  = (nameBlock.match(/Account:\s*(.*)/)   || [])[1]?.split('\n')[0].trim() || '';
  const customerName = (nameBlock.match(/Name:\s*(.*)/)    || [])[1]?.split('\n')[0].trim() || '';

  const detailsBlock = stripTags(c(2));
  const contactNo = (detailsBlock.match(/Mobile:\s*([^\n]*)/) || [])[1]?.trim() || '';
  const visibleArea = (detailsBlock.match(/Area:\s*([^\n]*)/) || [])[1]?.trim() || '';

  const secretMatch = c(5).match(/<span class="text-info">([^<]*)<\/span>/);
  const username = secretMatch ? secretMatch[1].trim() : '';

  const statusBlock = stripTags(c(6));
  const profile = (statusBlock.match(/Profile:\s*([^\n]*)/) || [])[1]?.trim() || '';

  const hiddenArea = stripTags(c(8));
  const area = hiddenArea || visibleArea;

  const napType = stripTags(c(16));
  const napPort = stripTags(c(19));
  const napBoxText = stripTags(c(18));
  const napBox = [napBoxText, napPort].filter(Boolean).join(' / ') || napType;

  if (!username) return null;

  return { username, customerName, accountNo, contactNo, area, profile, napBox };
}

// ---------- ISP uplink monitoring ----------
// Pings each ISP gateway IP directly from this machine (shells out to the OS
// ping command — works cross-platform without needing raw-socket permissions).

// ICMP ping needs a raw socket, which most containerized hosts (Railway
// included) don't grant — child_process.exec('ping ...') just fails there
// regardless of whether the target is actually reachable, which is why
// every ISP link used to show offline once this ran in the cloud. A plain
// TCP connect attempt needs no special privileges: a real connection, or
// even an immediate "connection refused" (a TCP RST — the host is there,
// it just isn't listening on that exact port), both prove the host
// answered. Only a timeout counts as unreachable. Tries a few common
// ports since we don't know what's actually listening on these gateways.
function pingHost(ip, timeoutMs = ISP_PING_TIMEOUT_MS) {
  const net = require('net');
  const PORTS = [443, 80, 53, 22];

  return new Promise((resolve) => {
    const start = Date.now();
    let i = 0;

    function tryNextPort() {
      if (i >= PORTS.length) { resolve({ online: false, latencyMs: null }); return; }
      const port = PORTS[i++];
      const socket = new net.Socket();
      let settled = false;

      const finish = (online) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (online) resolve({ online: true, latencyMs: Date.now() - start });
        else tryNextPort();
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('error', (err) => finish(err && err.code === 'ECONNREFUSED'));
      socket.once('timeout', () => finish(false));
      socket.connect(port, ip);
    }

    tryNextPort();
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

// ---------- Poll (router via SSH; TaokiNinam only enriches customer fields) ----------

const MONTH_ABBR = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// RouterOS renders date/time fields in a couple of formats depending on
// context: "YYYY-MM-DD HH:MM:SS", "mon/dd/yyyy HH:MM:SS", or just
// "HH:MM:SS" for something that happened earlier today.
function parseRouterOsTime(raw) {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}`);
  const todayOnly = raw.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (todayOnly) {
    const d = new Date();
    d.setHours(+todayOnly[1], +todayOnly[2], +todayOnly[3], 0);
    return d;
  }
  const full = raw.match(/^([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/i);
  if (full) {
    const month = MONTH_ABBR[full[1].toLowerCase()];
    if (month === undefined) return null;
    return new Date(+full[3], month, +full[2], +full[4], +full[5], +full[6]);
  }
  return null;
}

// Fetches TaokiNinam's online/offline pages purely for customer-info
// enrichment. Never throws — a failure here just means blank customer
// fields, since router status/timestamps don't depend on it.
async function fetchBillingEnrichment() {
  if (!BILLING_ENABLED) return { map: new Map(), error: null };
  try {
    const [onlineHtml, offlineHtml] = await Promise.all([
      fetchSubscriberPage('activesP.php'),
      fetchSubscriberPage('inactivesP.php'),
    ]);
    const rows = [
      ...parseSubscriberRows(onlineHtml).map(extractAccount).filter(Boolean),
      ...parseSubscriberRows(offlineHtml).map(extractAccount).filter(Boolean),
    ];
    return { map: new Map(rows.map(r => [r.username, r])), error: null };
  } catch (err) {
    return { map: new Map(), error: describeFetchError(err) };
  }
}

async function pollRouter() {
  try {
    const [activeOut, secretOut] = await Promise.all([
      sshExec('/ppp active print terse'),
      sshExec('/ppp secret print terse'),
    ]);

    const activeByName = new Map(parseTerse(activeOut).map(r => [r.name, r]));
    const secretRows   = parseTerse(secretOut);

    const now = new Date();
    const prevByUsername = new Map(state.accounts.map(a => [a.username, a]));
    const enrichment = await fetchBillingEnrichment();

    const updated = [];
    for (const secret of secretRows) {
      const username = secret.name;
      if (!username) continue;

      const active   = activeByName.get(username);
      const isOnline = Boolean(active);
      const prev     = prevByUsername.get(username);
      const justWentOffline = !isOnline && prev && prev.status === 'online';

      // RouterOS tracks this per-secret already — same value shown in
      // Winbox under PPP > Secrets > Last Logged Out. Far more reliable
      // than trying to pattern-match /log message text.
      let lastLogout = null, logSource = null;
      if (!isOnline) {
        const parsed = parseRouterOsTime(secret['last-logged-out']);
        // RouterOS uses the epoch (jan/01/1970) as a sentinel for "this
        // secret has never logged out" — treat that as no data, not a
        // real timestamp.
        if (parsed && parsed.getFullYear() <= 1971) {
          if (justWentOffline) { lastLogout = now.toISOString(); logSource = 'poll'; }
          else if (prev) { lastLogout = prev.lastLogout; logSource = prev.logSource; }
        } else if (parsed) {
          lastLogout = parsed.toISOString();
          logSource = 'secret';
        } else if (justWentOffline) {
          lastLogout = now.toISOString();
          logSource = 'poll';
        } else if (prev) {
          lastLogout = prev.lastLogout;
          logSource = prev.logSource;
        }
      }

      const enrich = enrichment.map.get(username) || {};

      updated.push({
        username,
        profile: secret.profile || '',
        comment: secret.comment || '',
        localIp: secret['local-address'] || '',
        remoteIp: isOnline ? (active.address || secret['remote-address'] || '') : (secret['remote-address'] || ''),
        status: isOnline ? 'online' : 'offline',
        lastSeen: isOnline ? now.toISOString() : (prev ? prev.lastSeen : null),
        lastLogout,
        logSource,
        customerName: enrich.customerName || '',
        accountNo: enrich.accountNo || '',
        contactNo: enrich.contactNo || '',
        area: enrich.area || '',
        napBox: enrich.napBox || '',
      });
    }

    // Default sort: offline (most recently logged out) first
    updated.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'offline' ? -1 : 1;
      if (a.status === 'offline') {
        const ta = a.lastLogout ? new Date(a.lastLogout).getTime() : 0;
        const tb = b.lastLogout ? new Date(b.lastLogout).getTime() : 0;
        return tb - ta;
      }
      return a.username.localeCompare(b.username);
    });

    const downCount = updated.filter(a => a.status === 'offline').length;

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
      billingLastSync: enrichment.error ? state.billingLastSync : (BILLING_ENABLED ? now.toISOString() : null),
      billingError: enrichment.error,
      billingCustomerCount: enrichment.map.size,
    };

    broadcast();
  } catch (err) {
    const msg = describeFetchError(err);
    state = { ...state, pollError: msg, lastPoll: new Date().toISOString() };
    broadcast();
    console.error(`[${new Date().toISOString()}] Poll error:`, msg);
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
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
                <div class="lc-stat-l">🔴 Offline (This Month)</div>
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
  if (data.pollError) { eb.textContent='⚠ Poll error: '+data.pollError; eb.classList.add('active'); }
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
    : (data.billingError ? '⚠ ' + data.billingError : (data.billingCustomerCount + ' accounts synced ' + fmt(data.billingLastSync)));

  clearInterval(cdTimer);
  let rem = data.pollIntervalSec || 30;
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
  const online  = allAccounts.filter(a=>a.status==='online').length;
  const offlineThisMonth = allAccounts.filter(a =>
    a.status==='offline' && a.lastLogout && inPeriod(a.lastLogout, 'month')
  ).length;

  // Live card
  document.getElementById('dn-live').textContent    = total;
  document.getElementById('cn-live-on').textContent  = online;
  document.getElementById('cn-live-off').textContent = offlineThisMonth;
  drawDonut('svg-live', online, offlineThisMonth, total);

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

  // Debug: view raw ISP ping results
  // Open http://localhost:3000/api/isps in your browser to inspect
  if (req.url === '/api/isps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.isps, null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(dashboardHtml());
});

server.listen(DASHBOARD_PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         StarLine PPPoE Monitor               ║
╠══════════════════════════════════════════════╣
║  Dashboard    →  http://localhost:${DASHBOARD_PORT}      ║
║  Router (SSH) →  ${SSH_HOST}:${SSH_PORT}
║  Polling every ${Math.round(POLL_INTERVAL_MS/1000)}s                          ║
║  Alert when ${ALERT_THRESHOLD}+ accounts offline              ║
╚══════════════════════════════════════════════╝

Status comes directly from the router (/ppp active, /ppp secret) over SSH.
Billing enrichment (customer name/account/contact/area/NAP): ${BILLING_ENABLED ? 'ON — ' + BILLING_BASE_URL : 'OFF (TAOKININAM_USERNAME/PASSWORD not set)'}

Offline time source:
  [SECRET] = the PPP secret's own "last logged out" field (same value
             shown in Winbox under PPP > Secrets > Last Logged Out)
  [POLL]   = fallback — first poll where monitor.js itself saw the
             account go offline (only used if that field is empty)
`);
  pollRouter();
  setInterval(pollRouter, POLL_INTERVAL_MS);
  pollIsps();
  setInterval(pollIsps, POLL_INTERVAL_MS);
});
