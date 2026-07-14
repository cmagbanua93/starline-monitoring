/**
 * create_pppoe_accounts.js
 *
 * Reads a spreadsheet of PPPoE accounts and provisions them on a Mikrotik
 * router (e.g. CCR2116) using the RouterOS REST API, authenticating with
 * the same admin username/password you use to log into the router's web UI.
 *
 * Requires RouterOS 7.x or later (REST API was added in v7.1+).
 *
 * Spreadsheet columns expected (case-insensitive headers), see
 * PPPOE_accounts_template.xlsx:
 *   Username | Password | Type | Profile | Local IP | Remote IP | Comment
 *
 * "Type" is expected to be PPPOE for every row (kept as a column in case you
 * later mix in other service types) - rows with another type are skipped.
 * "Profile" must match an existing PPP profile name on the router (e.g. Plan100).
 *
 * Usage:
 *   npm install
 *   cp .env.example .env   # fill in router host/user/pass
 *   node create_pppoe_accounts.js accounts.xlsx
 *
 * Flags:
 *   --dry-run      Print what would be sent, do not connect/apply
 *   --update       If a secret with that username already exists, update it
 *                  instead of skipping it (default: skip existing usernames)
 */

const fs = require('fs');
const ExcelJS = require('exceljs');
require('dotenv').config();

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const UPDATE_EXISTING = args.includes('--update');

if (!filePath) {
  console.error('Usage: node create_pppoe_accounts.js <spreadsheet.xlsx> [--dry-run] [--update]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

if (!DRY_RUN) {
  for (const key of ['MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASSWORD']) {
    if (!process.env[key]) {
      console.error(`Missing ${key} in .env (copy .env.example to .env and fill it in)`);
      process.exit(1);
    }
  }
}

const HOST = process.env.MIKROTIK_HOST;
const PORT = process.env.MIKROTIK_PORT || 80;
const USER = process.env.MIKROTIK_USER;
const PASS = process.env.MIKROTIK_PASSWORD;
const VERIFY_CERT = String(process.env.MIKROTIK_VERIFY_CERT || '').toLowerCase() === 'true';

// Auto-select protocol based on port: 443/8729 = https, everything else = http
const PROTOCOL = (PORT == 443 || PORT == 8729) ? 'https' : 'http';
const BASE_URL = `${PROTOCOL}://${HOST}:${PORT}/rest`;

if (PROTOCOL === 'https' && !VERIFY_CERT) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// ---------- Helpers ----------

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function isValidIp(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

function normalizeHeader(h) {
  return String(h).trim().toLowerCase().replace(/\s+/g, '');
}

async function readRows(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0];

  const headerRow = sheet.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const rows = [];
  for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);
    if (row.cellCount === 0 || row.values.length === 0) continue;

    const norm = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      let val = cell.value;
      if (val && typeof val === 'object' && 'text' in val) val = val.text; // rich text
      if (val && typeof val === 'object' && 'result' in val) val = val.result; // formula
      norm[key] = val === null || val === undefined ? '' : String(val).trim();
    });

    if (Object.values(norm).every(v => v === '')) continue; // skip fully blank rows

    rows.push({
      rowNum,
      username: norm['username'] || '',
      password: norm['password'] || '',
      type: (norm['type'] || 'PPPOE').toUpperCase(),
      profile: norm['profile'] || '',
      localIp: norm['localip'] || '',
      remoteIp: norm['remoteip'] || '',
      comment: norm['comment'] || '',
    });
  }
  return rows;
}

function validateRow(row) {
  const errors = [];
  if (!row.username) errors.push('missing Username');
  if (!row.password) errors.push('missing Password');
  if (row.type !== 'PPPOE') errors.push(`unsupported Type "${row.type}" (expected PPPOE) - skipped`);
  if (!row.profile) errors.push('missing Profile');
  if (row.localIp && !isValidIp(row.localIp)) errors.push(`invalid Local IP "${row.localIp}"`);
  if (row.remoteIp && !isValidIp(row.remoteIp)) errors.push(`invalid Remote IP "${row.remoteIp}"`);
  return errors;
}

function toSecretPayload(row) {
  const payload = {
    name: row.username,
    password: row.password,
    service: 'pppoe',
    profile: row.profile,
  };
  if (row.localIp) payload['local-address'] = row.localIp;
  if (row.remoteIp) payload['remote-address'] = row.remoteIp;
  if (row.comment) payload.comment = row.comment;
  return payload;
}

async function restRequest(method, endpoint, body) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && data.message) || (data && data.detail) || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ---------- Main ----------

async function main() {
  const rows = await readRows(filePath);
  if (rows.length === 0) {
    console.error('No data rows found in spreadsheet.');
    process.exit(1);
  }

  const validRows = [];
  const seenUsernames = new Set();
  let hadErrors = false;

  for (const row of rows) {
    const errors = validateRow(row);
    if (seenUsernames.has(row.username)) {
      errors.push('duplicate Username within spreadsheet');
    }
    if (errors.length) {
      hadErrors = true;
      console.warn(`Row ${row.rowNum} (${row.username || '(blank)'}): ${errors.join('; ')}`);
      continue;
    }
    seenUsernames.add(row.username);
    validRows.push(row);
  }

  console.log(`\nParsed ${rows.length} rows -> ${validRows.length} valid, ${rows.length - validRows.length} skipped.\n`);

  if (validRows.length === 0) {
    console.error('Nothing valid to provision. Fix the spreadsheet and try again.');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('--dry-run: REST payloads that would be sent (PUT /rest/ppp/secret):\n');
    for (const row of validRows) {
      console.log(JSON.stringify(toSecretPayload(row)));
    }
    return;
  }

  console.log(`Connecting to ${BASE_URL} ...`);
  const existing = await restRequest('GET', '/ppp/secret');
  const existingByName = new Map(existing.map(s => [s.name, s['.id']]));
  console.log(`Connected. ${existingByName.size} existing PPP secrets found.\n`);

  const results = { created: [], updated: [], skipped: [], failed: [] };

  for (const row of validRows) {
    const existingId = existingByName.get(row.username);

    if (existingId && !UPDATE_EXISTING) {
      console.log(`SKIP   ${row.username} (already exists, rerun with --update to overwrite)`);
      results.skipped.push(row.username);
      continue;
    }

    try {
      if (existingId) {
        await restRequest('PATCH', `/ppp/secret/${existingId}`, toSecretPayload(row));
        console.log(`UPDATE ${row.username}`);
        results.updated.push(row.username);
      } else {
        await restRequest('PUT', '/ppp/secret', toSecretPayload(row));
        console.log(`CREATE ${row.username}`);
        results.created.push(row.username);
      }
    } catch (err) {
      console.error(`FAIL   ${row.username}: ${err.message}`);
      results.failed.push(row.username);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Created: ${results.created.length}`);
  console.log(`Updated: ${results.updated.length}`);
  console.log(`Skipped (already existed): ${results.skipped.length}`);
  console.log(`Failed: ${results.failed.length}`);
  if (results.failed.length) {
    console.log(`Failed usernames: ${results.failed.join(', ')}`);
    process.exitCode = 1;
  }

  if (hadErrors) {
    console.log('\nNote: some spreadsheet rows were skipped due to validation errors (see warnings above).');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
