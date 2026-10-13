/* ------------------------- monitor insights -------------------------
 * Three things the live snapshot alone cannot show:
 *   1. Events  — who went offline / came back and when, ISP links going down /
 *                up, and suspected box or fiber outages (newest first).
 *   2. Trend   — 24 hours of 5-minute buckets: subscribers online / offline and
 *                each ISP link's latency, for the charts.
 *   3. NAP outages — offline subscribers grouped by NAP box / area, with a flag
 *                when several on one box drop together (a box, splitter or fiber
 *                problem rather than one house).
 *
 * Kept in memory and saved to Postgres (schema "monitor", the same database as
 * the sign-in accounts) every few minutes, so a redeploy does not wipe the
 * history. Without DATABASE_URL it simply starts fresh after each restart.
 */
const BUCKET_MS = 5 * 60 * 1000;
const KEEP_BUCKETS = 288;              // 24 h
const KEEP_EVENTS = 400;
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;   // drops this close together count as one incident
const CLUSTER_MIN = 3;                      // …and at least this many on one NAP

let events = [];          // newest last; { seq, t, kind, text, user?, nap? }
let seq = 0;
let buckets = [];         // oldest first; { t, on, off, n, isp: { name: [sum, count, downCount] } }
let activeIncidents = new Map();   // nap -> since (ISO) for "suspected" NAPs already announced
let pool = null;
let dirty = false;

function addEvent(kind, text, extra = {}) {
  events.push({ seq: ++seq, t: new Date().toISOString(), kind, text, ...extra });
  if (events.length > KEEP_EVENTS) events = events.slice(-KEEP_EVENTS);
  dirty = true;
}

const label = (a) => a.customerName ? `${a.customerName} (${a.username})` : a.username;
/* The box a subscriber hangs off. Billing files subscribers under their box in
   the Area field; its NAP field carries "box / port", so the port is dropped. */
const napOf = (a) => String(a.area || String(a.napBox || '').split(' / ')[0] || '').trim();

/* Called after every router poll with the previous and new account lists. */
function onAccounts(prev, next) {
  if (prev && prev.length) {
    const before = new Map(prev.map(a => [a.username, a.status]));
    const downs = [], ups = [];
    for (const a of next) {
      const was = before.get(a.username);
      if (was === 'online' && a.status === 'offline') downs.push(a);
      else if (was === 'offline' && a.status === 'online') ups.push(a);
    }
    /* A mass event (router restart, uplink cut) would flood the feed: summarise it. */
    if (downs.length > 15) addEvent('down', `${downs.length} subscribers went offline at once`, { count: downs.length });
    else downs.forEach(a => addEvent('down', `${label(a)} went offline`, { user: a.username, nap: napOf(a) }));
    if (ups.length > 15) addEvent('up', `${ups.length} subscribers came back online`, { count: ups.length });
    else ups.forEach(a => addEvent('up', `${label(a)} is back online`, { user: a.username, nap: napOf(a) }));
  }

  /* NAP incidents: announce once when a box crosses the line, once when it clears. */
  const now = napOutages(next);
  const suspectedNow = new Set(now.filter(n => n.suspected).map(n => n.nap));
  for (const n of now) {
    if (n.suspected && !activeIncidents.has(n.nap)) {
      activeIncidents.set(n.nap, new Date().toISOString());
      addEvent('nap', `Possible box / fiber problem at ${n.nap}: ${n.offline} of ${n.total} offline${n.cluster ? `, ${n.cluster} dropped within 10 min` : ''}`, { nap: n.nap });
    }
  }
  for (const [nap] of activeIncidents) {
    if (!suspectedNow.has(nap)) { activeIncidents.delete(nap); addEvent('nap-ok', `${nap} recovered`, { nap }); }
  }

  /* trend bucket */
  const on = next.filter(a => a.status === 'online').length;
  const b = currentBucket();
  b.on += on; b.off += next.length - on; b.n += 1;
  dirty = true;
}

/* Called after every ISP ping round. */
function onIsps(prev, next) {
  const before = new Map((prev || []).map(i => [i.name, i.online]));
  for (const i of next) {
    const was = before.get(i.name);
    if (was === true && i.online === false) addEvent('isp-down', `ISP link ${i.name} is DOWN`);
    else if (was === false && i.online === true) addEvent('isp-up', `ISP link ${i.name} is back up`);
  }
  const b = currentBucket();
  for (const i of next) {
    const s = b.isp[i.name] || (b.isp[i.name] = [0, 0, 0]);
    if (i.online && i.latencyMs != null) { s[0] += Number(i.latencyMs); s[1] += 1; }
    else if (i.online === false) s[2] += 1;
  }
  dirty = true;
}

function currentBucket() {
  const t = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  let b = buckets[buckets.length - 1];
  if (!b || b.t !== t) {
    b = { t, on: 0, off: 0, n: 0, isp: {} };
    buckets.push(b);
    const cutoff = t - KEEP_BUCKETS * BUCKET_MS;
    buckets = buckets.filter(x => x.t > cutoff);
  }
  return b;
}

/* Offline subscribers grouped by NAP box (or area when the box is not known).
   suspected = several on one box dropped close together, or most of a box is down. */
function napOutages(accounts) {
  const groups = new Map();
  for (const a of accounts || []) {
    const nap = napOf(a);
    if (!nap) continue;
    let g = groups.get(nap);
    if (!g) groups.set(nap, g = { nap, total: 0, offline: 0, drops: [] });
    g.total += 1;
    if (a.status === 'offline') {
      g.offline += 1;
      if (a.lastLogout) g.drops.push(new Date(a.lastLogout).getTime());
    }
  }
  const recent = Date.now() - 6 * 3600e3;   // a cluster only matters while it is fresh-ish
  const out = [];
  for (const g of groups.values()) {
    if (!g.offline) continue;
    /* largest number of drops inside any 10-minute window */
    const d = g.drops.filter(t => t >= recent).sort((x, y) => x - y);
    let cluster = 0;
    for (let i = 0, j = 0; i < d.length; i++) {
      while (d[i] - d[j] > CLUSTER_WINDOW_MS) j++;
      cluster = Math.max(cluster, i - j + 1);
    }
    const ratio = g.offline / g.total;
    const suspected = cluster >= CLUSTER_MIN || (g.offline >= CLUSTER_MIN && ratio >= 0.5);
    const lastDrop = g.drops.length ? new Date(Math.max(...g.drops)).toISOString() : null;
    out.push({ nap: g.nap, total: g.total, offline: g.offline, cluster: cluster >= 2 ? cluster : 0, suspected, lastDrop });
  }
  out.sort((x, y) => (y.suspected - x.suspected) || (y.offline - x.offline) || (y.offline / y.total - x.offline / x.total));
  return out;
}

/* ---- what the dashboard asks for ---- */
function feedSince(since) {
  const s = Number(since) || 0;
  const list = events.filter(e => e.seq > s);
  return { seq, events: list.slice(-150) };
}
function trend() {
  return {
    bucketMs: BUCKET_MS,
    points: buckets.map(b => ({
      t: b.t,
      on: b.n ? Math.round(b.on / b.n) : null,
      off: b.n ? Math.round(b.off / b.n) : null,
      isp: Object.fromEntries(Object.entries(b.isp).map(([k, v]) => [k, v[1] ? Math.round(v[0] / v[1]) : (v[2] ? -1 : null)])),
    })),
  };
}

/* ---- persistence (optional) ---- */
async function init(dbPool) {
  pool = dbPool || null;
  if (!pool) return;
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS monitor;
      CREATE TABLE IF NOT EXISTS monitor.kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
    const r = await pool.query(`SELECT key, value FROM monitor.kv WHERE key IN ('events','trend')`);
    for (const row of r.rows) {
      if (row.key === 'events' && Array.isArray(row.value.events)) {
        events = row.value.events.slice(-KEEP_EVENTS); seq = Number(row.value.seq) || 0;
        activeIncidents = new Map(Object.entries(row.value.incidents || {}));   // do not re-announce an outage after a restart
      }
      if (row.key === 'trend' && Array.isArray(row.value)) {
        const cutoff = Date.now() - KEEP_BUCKETS * BUCKET_MS;
        buckets = row.value.filter(b => b && b.t > cutoff);
      }
    }
    console.log(`[insights] restored ${events.length} events and ${buckets.length} trend points`);
  } catch (e) { console.error('[insights] could not restore history:', e.message); }
  setInterval(save, 3 * 60 * 1000).unref?.();
}
async function save() {
  if (!pool || !dirty) return;
  dirty = false;
  try {
    await pool.query(`INSERT INTO monitor.kv (key, value, updated_at) VALUES ('events', $1, now()), ('trend', $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ seq, events, incidents: Object.fromEntries(activeIncidents) }), JSON.stringify(buckets)]);
  } catch (e) { dirty = true; console.error('[insights] save failed:', e.message); }
}

module.exports = { init, onAccounts, onIsps, napOutages, feedSince, trend, save };
