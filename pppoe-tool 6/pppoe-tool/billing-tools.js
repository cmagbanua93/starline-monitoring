/* ---------------- one-time billing clean-up tools ----------------
 * Two batch jobs on TaokiNinam, run one record at a time in the background:
 *
 *   accounts — give every real subscriber that has no account number a unique one
 *              (same 6-digit style as new installs).
 *   details  — put back the Area / NAP box (and port) on installs whose billing
 *              record lost them. The values come from the ticketing jobs.
 *
 * TaokiNinam saves the whole record from its edit page, and boxes that page fills
 * in by script read back blank — that is how earlier saves lost the Area and the
 * account number. So every save here also writes back what the export says the
 * record already has (name, phone, Area, NAP, port, account), and every record is
 * checked against the export afterwards; anything lost is written back once more.
 * Records are checked in groups of 10 so the (slow) export is read once per group.
 */
module.exports = function billingTools(ctx) {
  const { billingRecordsAll, billingGet, billingPost, parseFormFields, accountFieldName,
    newAccountNumber, billingCatalog, billingAddArea, liveStatus, invalidate, log } = ctx;

  const CHUNK = 10;
  const normName = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const named = r => { const n = normName([r.fname, r.lname].join(' ')); return !!n && n !== normName(r.username); };
  const lc = v => String(v || '').trim().toLowerCase();
  /* export column -> edit-form field */
  const FORM_OF = { fname: 'fname', lname: 'lname', phone: 'phone', area: 'area', nap: 'nap', port: 'nport' };
  const billingOn = r => { const v = lc(r.billing); return v !== '' && v !== '0' && v !== 'inactive' && v !== 'none'; };

  let job = null;          // the one batch allowed at a time

  /* ---- what needs doing ---- */
  async function missingAccounts() {
    const all = await billingRecordsAll();
    return all.filter(r => !String(r.account || '').trim() && named(r) && r.username).map(r => ({
      username: r.username, name: [r.fname, r.lname].filter(Boolean).join(' '), area: r.area,
      billingActive: billingOn(r), state: r.state || '', live: liveStatus(r.username),
    })).sort((a, b) => (b.billingActive - a.billingActive) || a.username.localeCompare(b.username, undefined, { numeric: true }));
  }
  async function recordsFor(usernames) {
    const want = new Set((usernames || []).map(lc));
    const out = {};
    for (const r of await billingRecordsAll()) {
      const u = lc(r.username);
      if (!want.has(u)) continue;
      if (out[u]) { out[u] = { found: false, duplicate: true }; continue; }
      out[u] = { found: true, area: r.area, nap: r.nap, port: r.port, account: r.account, name: [r.fname, r.lname].filter(Boolean).join(' '), billingActive: billingOn(r) };
    }
    return out;
  }

  /* ---- one save, carrying what the record already has ---- */
  function formValues(form, values, accF) {
    const p = Object.assign({}, form);
    for (const [col, f] of Object.entries(FORM_OF)) if (f in form && values[col]) p[f] = values[col];
    if (accF && values.account) p[accF] = values.account;
    p.submit = form.submit || 'Submit';
    return p;
  }
  async function save(rec, values, onlySet) {
    const form = parseFormFields(await billingGet(`/editRecord.php?id=${encodeURIComponent(rec.id)}`), 'editRecords');
    if (!form) throw new Error('could not read the record form');
    const accF = accountFieldName(form);
    const settingAccount = onlySet ? !!onlySet.account : !!values.__newAccount;
    if (settingAccount && !accF) throw new Error('billing\'s edit form has no account-number box this tool can fill — set it in billing by hand');
    const p = onlySet ? Object.assign({}, form, accF && onlySet.account ? { [accF]: onlySet.account } : {}, { submit: form.submit || 'Submit' })
      : formValues(form, values, accF);
    await billingPost(`/actions/editRecords.php?id=${encodeURIComponent(rec.id)}`, p);
  }
  const COLS = ['fname', 'lname', 'area', 'nap', 'port', 'account'];   // phone is kept but not compared (billing may reformat it)
  const wrong = (now, want) => COLS.filter(c => want[c] && lc(now[c]) !== lc(want[c]));

  async function run(kind, items, by) {
    job = { kind, by, startedAt: Date.now(), total: items.length, done: 0, running: true, results: [] };
    const result = (item, status, detail) => { job.results.push({ username: item.username, ticket: item.ticket || '', status, detail }); job.done++; };
    let catalog = null;
    try { catalog = await billingCatalog(); } catch (e) {}
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      let all;
      try { all = await billingRecordsAll(); }
      catch (e) { chunk.forEach(it => result(it, 'failed', 'could not read billing: ' + e.message)); continue; }
      const taken = new Set(all.map(r => String(r.account || '').trim()).filter(Boolean));
      const pending = [];
      for (const it of chunk) {
        const hits = all.filter(r => lc(r.username) === lc(it.username));
        if (hits.length !== 1) { result(it, 'skipped', hits.length ? `${hits.length} billing records share this username` : 'no billing record with this username'); continue; }
        const rec = hits[0];
        const want = { fname: rec.fname, lname: rec.lname, phone: rec.phone, area: rec.area, nap: rec.nap, port: rec.port, account: rec.account };
        const set = {};
        if (kind === 'accounts') {
          if (String(rec.account || '').trim()) { result(it, 'skipped', `already has account number ${rec.account}`); continue; }
          if (!named(rec)) { result(it, 'skipped', 'no subscriber name — a spare account'); continue; }
          set.account = newAccountNumber(taken); taken.add(set.account); want.__newAccount = true;
        } else {
          const area = String(it.area || '').trim();
          if (!area) { result(it, 'skipped', 'the job has no NAP box'); continue; }
          if (!rec.area) set.area = area;
          if (!rec.nap) set.nap = area;                         // NAP mirrors the Area, as on install
          if (!rec.port && it.port) set.port = String(it.port).trim();
          if (!Object.keys(set).length) { result(it, 'skipped', `already has Area ${rec.area} / NAP ${rec.nap}`); continue; }
          if (set.area && catalog && !catalog.areas.includes(set.area)) {
            try {
              const a = await billingAddArea(set.area);
              if (!a || !a.ok) { result(it, 'failed', `"${set.area}" is not one of billing's areas and could not be added${a && a.error ? ': ' + a.error : ''}`); continue; }
              catalog.areas.push(set.area);
            } catch (e) { result(it, 'failed', `could not add area "${set.area}": ${e.message}`); continue; }
          }
        }
        Object.assign(want, set);
        try { await save(rec, want); pending.push({ it, rec, want, set }); }
        catch (e) { result(it, 'failed', e.message); }
      }
      if (!pending.length) continue;
      /* check the whole group against one export; fix what did not stick */
      let check = async () => { const a = await billingRecordsAll(); return id => a.find(r => r.id === id) || {}; };
      let byId;
      try { byId = await check(); } catch (e) { pending.forEach(p => result(p.it, 'failed', 'saved, but billing could not be read back: ' + e.message)); continue; }
      const retry = pending.filter(p => wrong(byId(p.rec.id), p.want).length);
      if (retry.length) {
        for (const p of retry) {
          try {
            const bad = wrong(byId(p.rec.id), p.want);
            /* the number refused with everything else: send it the plain way (as before 4 Nov) */
            if (bad.includes('account') && !String(byId(p.rec.id).account || '').trim()) await save(p.rec, null, { account: p.want.account });
            else await save(p.rec, p.want);
          } catch (e) {}
        }
        try { byId = await check(); } catch (e) {}
        /* a plain save can lose the Area again: one last full write for anything still off */
        const still = retry.filter(p => wrong(byId(p.rec.id), p.want).length);
        if (still.length) {
          for (const p of still) { try { await save(p.rec, Object.assign({}, p.want, { account: byId(p.rec.id).account || p.want.account })); } catch (e) {} }
          try { byId = await check(); } catch (e) {}
        }
      }
      for (const p of pending) {
        const now = byId(p.rec.id), bad = wrong(now, p.want);
        const what = Object.entries(p.set).map(([k, v]) => `${k === 'port' ? 'port' : k === 'nap' ? 'NAP' : k === 'area' ? 'Area' : 'account'} ${v}`).join(', ');
        if (!bad.length) result(p.it, 'done', what + (retry.includes(p) ? ' (needed a second save)' : ''));
        else result(p.it, 'failed', `billing did not keep ${bad.map(c => c === 'account' ? 'the account number' : c === 'area' ? 'the Area' : c === 'nap' ? 'the NAP' : c).join(', ')} — set it by hand`);
      }
    }
    job.running = false; job.finishedAt = Date.now();
    invalidate();
    const n = s => job.results.filter(r => r.status === s).length;
    log(`[billing-tools] ${kind} by ${by}: ${n('done')} done, ${n('skipped')} skipped, ${n('failed')} failed`);
  }

  function start(kind, items, by) {
    if (job && job.running) { const e = new Error('Another billing clean-up is still running — wait for it to finish.'); e.code = 409; throw e; }
    if (!['accounts', 'details'].includes(kind)) { const e = new Error('unknown job'); e.code = 400; throw e; }
    const clean = (items || []).filter(it => it && /^[\w.@-]{1,64}$/.test(String(it.username || '').trim()))
      .map(it => ({ username: String(it.username).trim(), area: String(it.area || '').trim(), port: String(it.port || '').trim(), ticket: String(it.ticket || '').trim() }));
    if (!clean.length) { const e = new Error('nothing selected'); e.code = 400; throw e; }
    run(kind, clean, by).catch(e => { if (job) { job.running = false; job.error = e.message; } });
    return status();
  }
  const status = () => job ? Object.assign({}, job, { results: job.results.slice() }) : { running: false, total: 0, done: 0, results: [] };

  /* ---- the admin page ---- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function page() {
    return `
<div class="card">
  <h2>Assign missing account numbers</h2>
  <div class="hint" style="margin-top:0">Every billing record with a real subscriber name but no account number. Spare accounts (no name, or the name is just the username) are left out. Each one gets a unique ${esc(String(ctx.digits))}-digit number, checked in billing afterwards; the Area and other details are kept. Disconnected / deactivated subscribers are listed but not ticked.</div>
  <div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="load">Find subscribers without a number</button>
  <button class="btn primary" id="go" disabled>Assign to ticked</button><span id="sum" class="hint" style="margin:0;align-self:center"></span></div>
  <div id="list"></div>
</div>
<div class="card" id="jobcard" style="display:none"><h2>Progress</h2><div id="job"></div></div>
<script>
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
var rows=[];
function sum(){var n=document.querySelectorAll('.pick:checked').length;document.getElementById('go').disabled=!n;document.getElementById('sum').textContent=rows.length?(n+' of '+rows.length+' ticked'):'';}
document.getElementById('load').onclick=function(){
  var b=this;b.disabled=true;b.textContent='Reading billing… (can take a minute)';
  fetch('/api/billing-missing-accounts',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){
    b.disabled=false;b.textContent='Find again';
    if(d.error){document.getElementById('list').innerHTML='<div class="bad">'+esc(d.error)+'</div>';return;}
    rows=d.records||[];
    document.getElementById('list').innerHTML=rows.length?rows.map(function(r,i){
      var on=r.billingActive&&r.state!=='disabled';
      return '<label class="row" style="font-weight:400;cursor:pointer"><span style="display:flex;gap:10px;align-items:center"><input type="checkbox" class="pick" data-i="'+i+'" style="width:18px;height:18px" '+(on?'checked':'')+'>'+
        '<span><span class="t">'+esc(r.name)+'</span> <span class="m">· '+esc(r.username)+(r.area?' · '+esc(r.area):'')+'</span><br><span class="m">'+(r.billingActive?'billing on':'billing off / deactivated')+(r.state==='disabled'?' · disconnected':'')+(r.live?' · '+esc(r.live):'')+'</span></span></span></label>';
    }).join(''):'<div class="ok">Every subscriber already has an account number.</div>';
    document.querySelectorAll('.pick').forEach(function(c){c.onchange=sum;});sum();
  }).catch(function(e){b.disabled=false;b.textContent='Find again';document.getElementById('list').innerHTML='<div class="bad">'+esc(e.message)+'</div>';});
};
document.getElementById('go').onclick=function(){
  var items=[].map.call(document.querySelectorAll('.pick:checked'),function(c){return {username:rows[+c.dataset.i].username};});
  if(!confirm('Give '+items.length+' subscriber'+(items.length===1?'':'s')+' a new account number in billing?'))return;
  this.disabled=true;
  fetch('/api/billing-batch',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'accounts',items:items})})
    .then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);return;}poll();});
};
function show(j){
  document.getElementById('jobcard').style.display='';
  var c=function(s){return j.results.filter(function(r){return r.status===s;}).length;};
  document.getElementById('job').innerHTML='<div class="'+(j.running?'hint':'ok')+'" style="margin-top:0">'+(j.running?'Working… '+j.done+' of '+j.total:'Finished: '+c('done')+' done, '+c('skipped')+' skipped, '+c('failed')+' need a look')+'</div>'+
    j.results.slice().reverse().map(function(r){return '<div class="row"><span><span class="t">'+esc(r.username)+'</span> <span class="m">'+esc(r.detail)+'</span></span><span class="chip '+(r.status==='done'?'admin':r.status==='failed'?'off':'technician')+'">'+esc(r.status)+'</span></div>';}).join('');
}
function poll(){fetch('/api/billing-batch',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(j){show(j);if(j.running)setTimeout(poll,3000);else document.getElementById('load').click();});}
fetch('/api/billing-batch',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(j){if(j.total){show(j);if(j.running)poll();}});
</script>`;
  }

  return { missingAccounts, recordsFor, start, status, page };
};
