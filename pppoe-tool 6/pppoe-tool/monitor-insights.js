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
/* Non-payment cuts: username -> { cutAt, seen, backAt }.
   seen = true when the monitor watched it happen; otherwise cutAt is the router's
   "last logged out" time (billing ends the session when it disables the account). */
let cuts = new Map();
const KEEP_CUTS_MS = 8 * 24 * 3600e3;
/* ISP latency history, for the per-link detail view:
     ispRaw     every check of the last 6 h:   name -> [[t, ms | -1 when down], …]
     ispHours   hourly roll-up for 30 days:     [{ t, isp: { name: [sum, count, down, min, max] } }]
     ispOutages each time a link went down:     name -> [{ start, end | null }]  (30 days) */
const RAW_KEEP_MS = 6 * 3600e3;
const HOUR_MS = 3600e3;
const KEEP_HOURS = 30 * 24;
const KEEP_OUTAGE_MS = 30 * 24 * 3600e3;
let ispRaw = {};
let ispHours = [];
let ispOutages = {};
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
  trackCuts(prev, next);
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

  /* trend bucket — non-payment cuts are kept out of "offline" */
  const on = next.filter(a => a.status === 'online').length;
  const off = next.filter(a => a.status === 'offline').length;
  const b = currentBucket();
  b.on += on; b.off += off; b.dis = (b.dis || 0) + (next.length - on - off); b.n += 1;
  dirty = true;
}

function trackCuts(prev, next) {
  const now = new Date().toISOString();
  const before = new Map((prev || []).map(a => [a.username, a.status]));
  const watching = before.size > 0;      // false on the first poll after a restart
  const newlyCut = [], paid = [];
  for (const a of next) {
    const c = cuts.get(a.username);
    if (a.status === 'disabled') {
      if (!c || c.backAt) {
        const seen = watching && before.has(a.username) && before.get(a.username) !== 'disabled';
        const cutAt = seen ? now : (a.lastLogout || null);
        if (!cutAt) continue;                                        // disabled long ago, no date: nothing to show
        cuts.set(a.username, { cutAt, seen });
        if (seen) newlyCut.push(a);
      }
    } else if (c && !c.backAt) {
      c.backAt = now;
      c.backSeen = watching && before.get(a.username) === 'disabled';
      if (c.backSeen) paid.push(a);
    }
  }
  if (newlyCut.length > 15) addEvent('cut', `${newlyCut.length} accounts disconnected for non-payment`, { count: newlyCut.length });
  else newlyCut.forEach(a => addEvent('cut', `${label(a)} disconnected for non-payment`, { user: a.username }));
  if (paid.length > 15) addEvent('paid', `${paid.length} accounts reconnected after payment`, { count: paid.length });
  else paid.forEach(a => addEvent('paid', `${label(a)} reconnected (paid)`, { user: a.username }));
  const cutoff = Date.now() - KEEP_CUTS_MS;
  for (const [u, c] of cuts) if (new Date(c.backAt || c.cutAt).getTime() < cutoff) cuts.delete(u);
  if (newlyCut.length || paid.length) dirty = true;
}

/* For the dashboard: cuts of the last 36 h (the page decides what "today" is in
   the viewer's own time zone) plus totals. */
function cutsView(accounts) {
  const byUser = new Map((accounts || []).map(a => [a.username, a]));
  const since = Date.now() - 36 * 3600e3;
  const list = [];
  for (const [u, c] of cuts) {
    const cutT = new Date(c.cutAt).getTime(), backT = c.backAt ? new Date(c.backAt).getTime() : 0;
    if (cutT < since && backT < since) continue;
    const a = byUser.get(u) || {};
    list.push({ username: u, name: a.customerName || '', accountNo: a.accountNo || '', area: a.area || '',
      contactNo: a.contactNo || '', cutAt: c.cutAt, seen: !!c.seen, backAt: c.backAt || null, nowStatus: a.status || 'unknown' });
  }
  list.sort((x, y) => new Date(y.cutAt) - new Date(x.cutAt));
  return { disabledNow: (accounts || []).filter(a => a.status === 'disabled').length, list };
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
  const h = currentHour();
  const now = Date.now();
  for (const i of next) {
    const up = i.online && i.latencyMs != null, ms = up ? Math.round(Number(i.latencyMs)) : null;
    for (const s of [b.isp[i.name] || (b.isp[i.name] = [0, 0, 0]), h.isp[i.name] || (h.isp[i.name] = [0, 0, 0, null, null])]) {
      if (up) {
        s[0] += ms; s[1] += 1;
        s[3] = s[3] == null ? ms : Math.min(s[3], ms);
        s[4] = s[4] == null ? ms : Math.max(s[4], ms);
      } else if (i.online === false) s[2] += 1;
    }
    if (i.online == null) continue;            // not checked yet
    const raw = ispRaw[i.name] || (ispRaw[i.name] = []);
    raw.push([now, up ? ms : -1]);
    while (raw.length && raw[0][0] < now - RAW_KEEP_MS) raw.shift();
    /* outage log */
    const list = ispOutages[i.name] || (ispOutages[i.name] = []);
    const open = list.length && !list[list.length - 1].end ? list[list.length - 1] : null;
    if (i.online === false && !open) list.push({ start: new Date(now).toISOString(), end: null });
    else if (i.online === true && open) open.end = new Date(now).toISOString();
    while (list.length && list[0].end && new Date(list[0].end).getTime() < now - KEEP_OUTAGE_MS) list.shift();
  }
  dirty = true;
}

function currentHour() {
  const t = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  let h = ispHours[ispHours.length - 1];
  if (!h || h.t !== t) {
    h = { t, isp: {} };
    ispHours.push(h);
    const cutoff = t - KEEP_HOURS * HOUR_MS;
    ispHours = ispHours.filter(x => x.t > cutoff);
  }
  return h;
}

/* One ISP link in detail: points for the chosen range, summary figures and outages.
   range: 1h | 6h (every check), 24h (5-minute averages), 7d | 30d (hourly averages). */
function ispHistory(name, range) {
  const spans = { '1h': HOUR_MS, '6h': 6 * HOUR_MS, '24h': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, '30d': 30 * 24 * HOUR_MS };
  if (!spans[range]) range = '24h';
  const t1 = Date.now(), t0 = t1 - spans[range];
  let points = [], stepMs;
  const raw = (ispRaw[name] || []).filter(r => r[0] >= t0);
  /* just after an update there are few single checks yet: use the 5-minute averages until there are */
  const rawOk = raw.length && raw[0][0] <= t0 + spans[range] * 0.5;
  if ((range === '1h' || range === '6h') && rawOk) {
    stepMs = null;
    points = (ispRaw[name] || []).filter(r => r[0] >= t0).map(r => ({ t: r[0], avg: r[1] >= 0 ? r[1] : null, min: r[1] >= 0 ? r[1] : null, max: r[1] >= 0 ? r[1] : null, down: r[1] < 0 ? 1 : 0, n: 1 }));
  } else {
    const fine = range === '1h' || range === '6h' || range === '24h';
    const src = fine ? buckets : ispHours;
    stepMs = fine ? BUCKET_MS : HOUR_MS;
    points = src.filter(b => b.t >= t0 - stepMs && b.isp && b.isp[name]).map(b => {
      const v = b.isp[name], n = v[1] + v[2];
      return { t: b.t, avg: v[1] ? Math.round(v[0] / v[1]) : null, min: v[3] != null ? v[3] : (v[1] ? Math.round(v[0] / v[1]) : null),
        max: v[4] != null ? v[4] : (v[1] ? Math.round(v[0] / v[1]) : null), down: n ? v[2] / n : 0, n };
    });
  }
  /* summary — from every check when we have them, otherwise weighted by checks */
  let checks = 0, downChecks = 0, sum = 0, upChecks = 0, min = null, max = null;
  const vals = [];
  points.forEach(p => {
    checks += p.n; downChecks += Math.round(p.down * p.n);
    const up = p.n - Math.round(p.down * p.n);
    if (p.avg != null && up > 0) {
      sum += p.avg * up; upChecks += up; vals.push(p.avg);
      min = min == null ? p.min : Math.min(min, p.min); max = max == null ? p.max : Math.max(max, p.max);
    }
  });
  vals.sort((a, b) => a - b);
  const p95 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))] : null;
  const outages = (ispOutages[name] || [])
    .filter(o => !o.end || new Date(o.end).getTime() >= t0)
    .map(o => ({ start: o.start, end: o.end, minutes: Math.max(1, Math.round(((o.end ? new Date(o.end).getTime() : t1) - new Date(o.start).getTime()) / 60000)) }))
    .reverse();
  const downMin = outages.reduce((a, o) => a + Math.round((Math.min(t1, o.end ? new Date(o.end).getTime() : t1) - Math.max(t0, new Date(o.start).getTime())) / 60000), 0);
  /* how far back we actually have data for this range */
  const since = points.length ? points[0].t : null;
  return {
    name, range, t0, t1, stepMs, since, points,
    stats: { avg: upChecks ? Math.round(sum / upChecks) : null, min, max, p95, checks,
      uptimePct: checks ? Math.round((1 - downChecks / checks) * 10000) / 100 : null, downMin: Math.max(0, downMin), outages: outages.length },
    outages: outages.slice(0, 50),
  };
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
    if (a.status === 'disabled') continue;          // cut for non-payment — not a box problem
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
      dis: b.n && b.dis != null ? Math.round(b.dis / b.n) : null,
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
    const r = await pool.query(`SELECT key, value FROM monitor.kv WHERE key IN ('events','trend','cuts','isp')`);
    for (const row of r.rows) {
      if (row.key === 'events' && Array.isArray(row.value.events)) {
        events = row.value.events.slice(-KEEP_EVENTS); seq = Number(row.value.seq) || 0;
        activeIncidents = new Map(Object.entries(row.value.incidents || {}));   // do not re-announce an outage after a restart
      }
      if (row.key === 'cuts' && row.value && typeof row.value === 'object') cuts = new Map(Object.entries(row.value));
      if (row.key === 'trend' && Array.isArray(row.value)) {
        const cutoff = Date.now() - KEEP_BUCKETS * BUCKET_MS;
        buckets = row.value.filter(b => b && b.t > cutoff);
      }
      if (row.key === 'isp' && row.value && typeof row.value === 'object') {
        const v = row.value;
        if (v.raw && typeof v.raw === 'object') {
          const cut = Date.now() - RAW_KEEP_MS;
          for (const [k, arr] of Object.entries(v.raw)) if (Array.isArray(arr)) ispRaw[k] = arr.filter(x => x[0] >= cut);
        }
        if (Array.isArray(v.hours)) { const cut = Date.now() - KEEP_HOURS * HOUR_MS; ispHours = v.hours.filter(h => h && h.t > cut); }
        if (v.outages && typeof v.outages === 'object') ispOutages = v.outages;
      }
    }
    /* first start with this version: build the hourly history from the 24 h we already have */
    if (!ispHours.length && buckets.length) {
      const byHour = new Map();
      for (const b of buckets) {
        const t = Math.floor(b.t / HOUR_MS) * HOUR_MS;
        const h = byHour.get(t) || { t, isp: {} }; byHour.set(t, h);
        for (const [k, v] of Object.entries(b.isp || {})) {
          const s = h.isp[k] || (h.isp[k] = [0, 0, 0, null, null]);
          s[0] += v[0]; s[1] += v[1]; s[2] += v[2];
          if (v[1]) { const a = v[3] != null ? v[3] : v[0] / v[1], z = v[4] != null ? v[4] : v[0] / v[1];
            s[3] = s[3] == null ? Math.round(a) : Math.min(s[3], Math.round(a)); s[4] = s[4] == null ? Math.round(z) : Math.max(s[4], Math.round(z)); }
        }
      }
      ispHours = [...byHour.values()].sort((a, b) => a.t - b.t);
    }
    console.log(`[insights] restored ${events.length} events and ${buckets.length} trend points`);
  } catch (e) { console.error('[insights] could not restore history:', e.message); }
  setInterval(save, 3 * 60 * 1000).unref?.();
}
async function save() {
  if (!pool || !dirty) return;
  dirty = false;
  try {
    await pool.query(`INSERT INTO monitor.kv (key, value, updated_at) VALUES ('events', $1, now()), ('trend', $2, now()), ('cuts', $3, now()), ('isp', $4, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ seq, events, incidents: Object.fromEntries(activeIncidents) }), JSON.stringify(buckets), JSON.stringify(Object.fromEntries(cuts)),
       JSON.stringify({ raw: ispRaw, hours: ispHours, outages: ispOutages })]);
  } catch (e) { dirty = true; console.error('[insights] save failed:', e.message); }
}

module.exports = { init, onAccounts, onIsps, napOutages, feedSince, trend, save, cutsView, ispHistory };
