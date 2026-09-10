'use strict';
// Sedmá rota — interaktivní žebříček.
// z-skóre = (hodnota − průměr) / výběrová směrodatná odchylka (STDEV, n-1),
//   na LKH se počítá z hodnoty PO ligové korekci.
// spolehlivost LKH = √(min(legy/Lref, 1)) — sráží LKH málo prokázaných hráčů.
// vážené skóre = Σ(váha·z[·spolehlivost u LKH]) / Σ(vah přítomných metrik).
// návrh A = pořadí ≤ velikost A-týmu; ruční zámek přebíjí; vyřazený mimo.

const METRICS = ['lkh', 'bt', 'turnaje'];
const LS_PARAMS = '7rota_params_v2';  // v2: data-grounded ligová korekce (% z reálných zápasů)
const LS_OVR = '7rota_overrides';

let DATA = null, params = null, overrides = {}, LIGA_INDEX = {}, TEAM_HISTORY = {};
let SCOUT = null, scoutTeam = null;   // scouting: rozpis + soupeři (index otevřeného týmu)
const $ = (id) => document.getElementById(id);

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function defaults() {
  return { wLkh: DATA.weights_default.lkh, wBt: DATA.weights_default.bt,
    wTurn: DATA.weights_default.turnaje, aSize: DATA.a_team_size,
    ligaOn: DATA.liga_korekce_on !== false, ligaKor: { ...(DATA.liga_korekce || {}) },
    relOn: DATA.reliability_on !== false, lref: DATA.lref || 120 };
}
// Předvolby = konzistentní kombinace ligové korekce + vah (kvůli dvojímu počítání s BT)
const PRESETS = {
  mirna: { label: 'Mírná', liga: { A: 1.03, B: 1.0, C: 0.83, D: 0.81 }, w: { lkh: 0.5, bt: 0.5, turnaje: 0.4 },
    desc: 'MÍRNÁ: ligová korekce LKH lehká (2. liga −17 %, 3. liga −19 %). Sílu napříč ligami nese hlavně Vzájemná síla (BT) — proto má vyšší váhu. Vyhneš se dvojímu počítání téhož.' },
  vyvazena: { label: 'Vyvážená', liga: { A: 1.04, B: 1.0, C: 0.76, D: 0.73 }, w: { lkh: 0.5, bt: 0.4, turnaje: 0.5 },
    desc: 'VYVÁŽENÁ (doporučeno): ligová korekce i váha BT střední (2. liga −24 %, 3. liga −27 %). Dobrý výchozí bod.' },
  plna: { label: 'Plná', liga: { A: 1.08, B: 1.0, C: 0.52, D: 0.46 }, w: { lkh: 0.6, bt: 0.25, turnaje: 0.4 },
    desc: 'PLNÁ: LKH plně koriguje rozdíl lig dle reálných dat (2. liga −48 %, 3. liga −54 %). Protože to už zahrnuje sílu, váha Vzájemné síly (BT) je nízká, ať se nezapočítává dvakrát.' },
};
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  params.ligaKor = { ...p.liga }; params.ligaOn = true;
  params.wLkh = p.w.lkh; params.wBt = p.w.bt; params.wTurn = p.w.turnaje;
  saveParams(); syncControls(); render();
  $('presetDesc').textContent = p.desc;
}
function legStats() {
  const ls = DATA.players.map(p => p.legy).filter(v => v != null).sort((a, b) => a - b);
  if (!ls.length) { $('legInfo').textContent = ''; return; }
  const med = ls[Math.floor(ls.length / 2)];
  $('legInfo').innerHTML = `V této sezóně mají hráči <b>${ls[0]}–${ls[ls.length - 1]}</b> odehraných legů (medián ${med}). `
    + `Lref = od kolika legů bereš výkon jako plně prokázaný — nad Lref plná důvěra, pod ním se LKH úměrně srazí.`;
}

function loadParams() {
  const def = defaults();
  try { const s = JSON.parse(localStorage.getItem(LS_PARAMS)); if (!s) return def;
    return { ...def, ...s, ligaKor: { ...def.ligaKor, ...(s.ligaKor || {}) } }; }
  catch { return def; }
}
const saveParams = () => localStorage.setItem(LS_PARAMS, JSON.stringify(params));
const loadOverrides = () => { try { return JSON.parse(localStorage.getItem(LS_OVR)) || {}; } catch { return {}; } };
const saveOverrides = () => localStorage.setItem(LS_OVR, JSON.stringify(overrides));
const ovr = (n) => overrides[n] || (overrides[n] = { lock: null, excluded: false });

// LKH po ligove korekci
function lkhVal(p) {
  if (p.lkh == null) return null;
  if (params.ligaOn && p.kat && params.ligaKor[p.kat] != null) return p.lkh * params.ligaKor[p.kat];
  return p.lkh;
}
function mval(p, m) { return m === 'lkh' ? lkhVal(p) : p[m]; }
// spolehlivostni faktor LKH dle poctu legu
function reliab(p) {
  if (!params.relOn || p.legy == null) return 1;
  return Math.sqrt(Math.min(p.legy / params.lref, 1));
}

function compute() {
  // provizorní kandidáti zařazení do žebříčku (aktivní + má aspoň 1 srovnatelnou metriku).
  // LKH/legy/kat dotáhneme z ligového indexu i pro dříve uložené kandidáty (robustní).
  const cands = loadCand().filter(c => c.active).map(c => {
    const li = LIGA_INDEX[c.jmeno] || {};
    return {
      jmeno: c.jmeno, tym: '?', kat: c.kat || li.kat || null,
      lkh: c.lkh != null ? c.lkh : (li.lkh != null ? li.lkh : null),
      legy: c.legy != null ? c.legy : (li.legy != null ? li.legy : null),
      turnaje: c.turnaje != null ? c.turnaje : null,
      bt: null, utkani: null, hral: null, isCand: true, klub: c.klub || li.tym,
    };
  }).filter(p => p.turnaje != null || p.lkh != null);
  const ps = DATA.players.concat(cands);
  const z = {};
  for (const m of METRICS) {
    const vals = ps.map(p => mval(p, m)).filter(v => v != null);
    const mu = vals.length ? mean(vals) : 0, sd = stdev(vals);
    z[m] = {};
    for (const p of ps) { const v = mval(p, m); z[m][p.jmeno] = (v != null && sd > 0) ? (v - mu) / sd : null; }
  }
  const W = { lkh: params.wLkh, bt: params.wBt, turnaje: params.wTurn };
  const out = ps.map(p => {
    let num = 0, den = 0;
    for (const m of METRICS) {
      const zz = z[m][p.jmeno];
      if (zz != null) { const rel = m === 'lkh' ? reliab(p) : 1; num += W[m] * zz * rel; den += W[m]; }
    }
    const score = den > 0 ? num / den : null;
    const o = ovr(p.jmeno);
    const jenLiga = p.turnaje == null;          // nehraje turnaje
    return { ...p, score, inPlay: score != null && !o.excluded, lock: o.lock,
      excluded: o.excluded, jenLiga };
  });
  const ranked = out.filter(p => p.inPlay).sort((a, b) => b.score - a.score);
  ranked.forEach((p, i) => { p.rank = i + 1; });
  for (const p of out) {
    if (p.excluded) { p.team = null; continue; }
    if (p.lock) { p.team = p.lock; continue; }
    p.team = (p.rank && p.rank <= params.aSize) ? 'A' : 'B';
  }
  out.sort((a, b) => {
    if (a.inPlay !== b.inPlay) return a.inPlay ? -1 : 1;
    if (a.score == null) return 1; if (b.score == null) return -1;
    return b.score - a.score;
  });
  return out;
}

const na = (v, d = 1) => v == null ? '<span class="na">—</span>' : (+v).toFixed(d);

function render() {
  const rows = compute(), tb = $('rows'); tb.innerHTML = '';
  for (const p of rows) {
    const tr = document.createElement('tr');
    if (p.excluded) tr.className = 'dim';
    if (p.lock) tr.classList.add('locked');
    if (p.isCand) tr.classList.add('candrow');
    const badge = p.team ? `<span class="badge ${p.team.toLowerCase()}">${p.team}</span>` : '—';
    const jl = p.isCand ? ' <span class="tag cand">KANDIDÁT</span>'
      : (p.jenLiga ? ' <span class="tag jl">jen liga</span>' : '');
    const total = (DATA.liga_zapasu && DATA.liga_zapasu[p.tym]) || 24;
    const doch = p.utkani != null
      ? ` <span class="tag doch" title="${dochN() ? `letos na soupisce ${p.utkani_n || 0}/${dochN()}, hrál ${p.hral_n || 0}× · ` : ''}loni ${p.utkani}/${total}, hrál ${p.hral}×">📋 ${dochVal(p, total)}</span>` : '';
    tr.innerHTML = `
      <td>${p.rank || ''}</td>
      <td class="l name">${p.jmeno}${jl}${doch}</td>
      <td>${badge}</td>
      <td class="score">${p.score == null ? '—' : p.score.toFixed(2)}</td>
      <td>${na(p.lkh, 1)}</td>
      <td>${p.turnaje == null ? '<span class="na">—</span>' : p.turnaje}</td>
      <td>${na(p.bt, 2)}</td>
      <td><select class="lock" data-n="${p.jmeno}">
        <option value=""${!p.lock ? ' selected' : ''}>—</option>
        <option value="A"${p.lock === 'A' ? ' selected' : ''}>A</option>
        <option value="B"${p.lock === 'B' ? ' selected' : ''}>B</option></select></td>
      <td><span class="xbtn${p.excluded ? ' on' : ''}" data-n="${p.jmeno}">✕</span></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('select.lock').forEach(s => s.onchange = e => {
    ovr(e.target.dataset.n).lock = e.target.value || null; saveOverrides(); render(); });
  tb.querySelectorAll('.xbtn').forEach(x => x.onclick = e => {
    const o = ovr(e.target.dataset.n); o.excluded = !o.excluded; saveOverrides(); render(); });
  LAST = {}; rows.forEach(p => LAST[p.jmeno] = p);
  tb.querySelectorAll('td.name').forEach(td => td.onclick = () => openDetail(td.textContent));
  renderScout();   // scouting listy sdílejí ligovou korekci se žebříčkem → re-render při změně params
}

let LAST = {};
// cestina: 1 leg / 2-4 legy / 5+ legu
const legStr = (n) => `${n} ${n === 1 ? 'leg' : (n >= 2 && n <= 4 ? 'legy' : 'legů')}`;

// Dochazka: hlavni cislo = BEZICI sezona (od 1. kola nove ligy), lonska v podtitulku.
// Dokud nova sezona nema odehrane kolo (liga_zapasu_n = 0), ukaze se rovnou lonska.
const dochN = () => (DATA && DATA.liga_zapasu_n) || 0;
function dochVal(p, total) {
  if (p.isCand || p.utkani == null) return '—';
  return dochN() ? `${p.utkani_n || 0}/${dochN()}` : `${p.utkani}/${total}`;
}
function dochSub(p, total) {
  if (p.isCand) return 'kandidát (cizí klub)';
  if (p.utkani == null) return '—';
  if (!dochN()) return `reálně hrál ${p.hral}×`;
  return `letos hrál ${p.hral_n || 0}× · loni ${p.utkani}/${total} (hrál ${p.hral}×)`;
}

function tile(label, val, sub) {
  return `<div class="tile"><span class="tl">${label}</span><span class="tv">${val}</span>${sub ? `<span class="ts">${sub}</span>` : ''}</div>`;
}
function openDetail(jmeno) {
  // td.name textContent obsahuje i tagy (jen liga / docházka) — najdi hráče dle prefixu
  const p = LAST[jmeno] || DATA.players.map(x => LAST[x.jmeno]).find(x => x && jmeno.startsWith(x.jmeno));
  if (!p) return;
  const total = (DATA.liga_zapasu && DATA.liga_zapasu[p.tym]) || 24;
  const liga = (DATA.liga_popis && DATA.liga_popis[p.kat]) || p.kat || '?';
  $('dInit').textContent = p.jmeno.split(' ').map(w => w[0] || '').slice(0, 2).join('');
  $('dName').textContent = p.jmeno + (p.isCand ? ' ⟨kandidát⟩' : '');
  $('dSub').innerHTML = `${p.team ? `<span class="badge ${p.team.toLowerCase()}">${p.team}</span>` : ''} `
    + `tým ${p.klub || p.tym || '—'} · ${liga}` + (p.rank ? ` · pořadí #${p.rank}` : '');
  $('dStats').innerHTML =
    tile('Vážené skóre', p.score == null ? '—' : p.score.toFixed(2))
    + tile('LKH (liga)', p.lkh == null ? '—' : p.lkh.toFixed(1), p.legy != null ? legStr(p.legy) : 'bez ligy')
    + tile('LKH letos', p.lkh_n == null ? '—' : p.lkh_n.toFixed(1),
        p.leg_n ? `${legStr(p.leg_n)}${p.zap_n ? ' · ' + p.zap_n + ' záp.' : ''}` : 'letos ještě nehrál')
    + tile('Pohár pořadí', (p.turn_season && p.turn_season.pohar_pozice) ? p.turn_season.pohar_pozice + '/' + p.turn_season.pohar_total : '—', 'Středočeský pohár (živé)')
    + tile('Síla (BT)', p.bt == null ? '—' : p.bt.toFixed(2),
        p.bt == null ? 'bez turnajových singlů' : `z ${p.bt_n} zápasů`)
    + tile('Docházka', dochVal(p, total), dochSub(p, total));
  const notes = [];
  if (p.jenLiga) notes.push('„Jen liga" — nehraje turnaje, soudí se hlavně z LKH.');
  if (p.lkh == null) notes.push('Bez ligových dat — posuzuje se z turnajů (BT).');
  if (p.legy != null && p.legy < (params.lref || 120)) notes.push(`Málo odehraných legů (${p.legy}) → LKH méně prokázané (spolehlivostní faktor).`);
  if (p.bt != null && (p.bt_n || 0) < 30) notes.push(`Síla BT stojí jen na ${p.bt_n} zápasech — málo průkazné.`);
  if (p.lkh_n != null && (p.leg_n || 0) < 4) notes.push(`„LKH letos" je zatím z ${legStr(p.leg_n)} — neprůkazné, do pořadí se nepočítá.`);
  else if (p.lkh_n != null && p.lkh != null) {
    const d = p.lkh_n - p.lkh;
    if (Math.abs(d) >= 8) notes.push(`Letošní forma ${d > 0 ? 'nad' : 'pod'} loňským LKH o ${Math.abs(d).toFixed(1)} (z ${legStr(p.leg_n)}).`);
  }
  $('dNote').textContent = notes.join(' ');
  renderLkh(p);
  renderTurn(p);
  renderH2H(p);
  renderHistory(p);
  history.replaceState(null, '', '?p=' + encodeURIComponent(p.jmeno));
  $('dShare').onclick = () => shareProfile(p);
  $('detail').classList.remove('hidden');
}

// Vygeneruje grafickou kartu profilu (canvas) pro sdílení — pro tymovou poradu.
function drawProfileCard(p) {
  const ts = p.turn_season, d = p.lkh_detail, S = 2;
  const W = 660, TEAL = '#0f766e', DARK = '#0f172a', MUT = '#64748b';
  // aktualni liga z historie (NE z kat — kat je kategorie hrace, ne liga)
  const hist = TEAM_HISTORY[p.jmeno] || [];
  const cur = hist.find(h => !h.pauza);
  const ligaTxt = cur ? cur.liga : ((DATA.liga_popis && DATA.liga_popis[p.kat]) || '');
  // radky (label, hodnota, sub)
  const rows = [];
  if (ts && ts.cur) rows.push(['Aktuální sezóna (turnaje)', (ts.cur.turnaju || 0) + ' her', ts.cur.winpct != null ? ts.cur.winpct + '% výher' : '']);
  if (ts && ts.last) rows.push(['Minulá sezóna (turnaje)', (ts.last.turnaju || 0) + ' her', ts.last.winpct != null ? ts.last.winpct + '% výher' : '']);
  if (d && d.her != null) rows.push(['Liga — odehráno', d.her + ' her', `${Math.round(100 * d.legy_v / d.legy_o)}% výher legů`]);
  const HEAD = 150, HERO = 96, H = HEAD + HERO + 20 + rows.length * 60 + 54;
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S;
  const x = c.getContext('2d'); x.scale(S, S);
  const RR = (l, t, w, h, r) => { x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); };
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  // HEADER
  x.fillStyle = TEAL; x.fillRect(0, 0, W, HEAD);
  x.fillStyle = '#0b5b54'; x.beginPath(); x.arc(70, 70, 40, 0, 7); x.fill();
  x.fillStyle = '#fff'; x.font = 'bold 34px system-ui,sans-serif'; x.textAlign = 'center';
  x.fillText(p.jmeno.split(' ').map(w => w[0] || '').slice(0, 2).join(''), 70, 83);
  x.textAlign = 'left'; x.font = 'bold 30px system-ui,sans-serif';
  x.fillText(p.jmeno + (p.isCand ? ' ⟨kandidát⟩' : ''), 128, 62);
  x.font = '16px system-ui,sans-serif'; x.fillStyle = 'rgba(255,255,255,.88)';
  x.fillText(`${p.klub || p.tym || ''}${ligaTxt ? ' · ' + ligaTxt : ''}`, 128, 92);
  if (p.rank && p.team) { // chip s poradim v nasem zebricku
    x.fillStyle = p.team === 'A' ? '#15803d' : '#1d4ed8'; RR(128, 108, 168, 28, 14); x.fill();
    x.fillStyle = '#fff'; x.font = 'bold 14px system-ui,sans-serif';
    x.fillText(`${p.team}-tým · #${p.rank} v žebříčku`, 142, 127);
  }
  // HERO — 2 velke staty (LKH + Pohar poradi)
  const hero = (l, t, lab, val, sub) => {
    x.fillStyle = '#f1f5f9'; RR(l, t, (W - 60) / 2, HERO, 14); x.fill();
    x.fillStyle = MUT; x.font = '13px system-ui,sans-serif'; x.fillText(lab.toUpperCase(), l + 18, t + 26);
    x.fillStyle = TEAL; x.font = 'bold 38px system-ui,sans-serif'; x.fillText(val, l + 18, t + 66);
    if (sub) { x.fillStyle = MUT; x.font = '13px system-ui,sans-serif'; x.fillText(sub, l + 18, t + 86); }
  };
  let y = HEAD + 18;
  hero(20, y, 'LKH (liga)', p.lkh != null ? String(p.lkh) : '—', p.bt != null ? 'Síla BT ' + p.bt.toFixed(2) : '');
  hero(40 + (W - 60) / 2, y, 'Pohár pořadí', ts && ts.pohar_pozice ? ts.pohar_pozice + '/' + ts.pohar_total : '—', 'Středočeský pohár');
  y += HERO + 20;
  // RADKY
  for (const [label, val, sub] of rows) {
    x.fillStyle = '#f8fafc'; RR(20, y, W - 40, 50, 10); x.fill();
    x.fillStyle = MUT; x.font = '13px system-ui,sans-serif'; x.fillText(label.toUpperCase(), 36, y + 20);
    x.fillStyle = DARK; x.font = 'bold 21px system-ui,sans-serif'; x.fillText(val, 36, y + 42);
    if (sub) { x.fillStyle = TEAL; x.font = 'bold 16px system-ui,sans-serif'; x.textAlign = 'right'; x.fillText(sub, W - 36, y + 34); x.textAlign = 'left'; }
    y += 60;
  }
  x.fillStyle = '#94a3b8'; x.font = '13px system-ui,sans-serif'; x.textAlign = 'center';
  x.fillText('🎯 Sedmá rota Praha — statistický asistent · ' + new Date().toLocaleDateString('cs'), W / 2, H - 22);
  return c;
}

function shareProfile(p) {
  const url = location.origin + location.pathname + '?p=' + encodeURIComponent(p.jmeno);
  const canvas = drawProfileCard(p);
  canvas.toBlob(async (blob) => {
    const file = new File([blob], (p.jmeno.replace(/\s/g, '_')) + '.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ title: p.jmeno + ' — Sedmá rota', text: p.jmeno + ' — profil', files: [file] }); return; } catch { }
    }
    // fallback: stáhni obrázek
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = file.name; a.click();
  }, 'image/png');
}

function renderLkh(p) {
  const box = $('dLkh'), d = p.lkh_detail;
  if (!d) { box.innerHTML = ''; return; }
  const B = { n95: 10, n133: 20, n170: 30, z6: 40, z5: 80, z4: 120, z3: 200, legy_v: 50, zapasy_v: 70 };
  const body = Object.keys(B).reduce((s, k) => s + (d[k] || 0) * B[k], 0);
  const lwpct = d.legy_o ? Math.round(100 * d.legy_v / d.legy_o) : 0;
  const zav = d.z6 + d.z5 + d.z4 + d.z3;
  const r = (label, val) => `<div class="h2hrow"><span class="h2hn">${label}</span><span class="turnstat">${val}</span></div>`;
  box.innerHTML = `<h3>LKH — z čeho se skládá (liga)</h3>`
    + (d.her != null ? r('Her zahráno', `${d.her} <span class="na">(1 hra = best of 3 legy)</span>`) : '')
    + r('Legy odehrané / vyhrané', `${d.legy_o} / ${d.legy_v} (${lwpct}% výher legů)`)
    + r('Zápasy vyhrané', d.zapasy_v)
    + r('Náhozy 95+ / 133+ / 170+', `${d.n95} / ${d.n133} / ${d.n170}`)
    + r('Zavření (6./5./4./3. kolo)', `${d.z6} / ${d.z5} / ${d.z4} / ${d.z3}`)
    + `<div class="h2htot">LKH = <b>${body}</b> bodů / ${d.legy_o} legů = <b>${(body / d.legy_o).toFixed(1)}</b></div>`;
}

function renderTurn(p) {
  const box = $('dTurn'), ts = p.turn_season;
  if (!ts) { box.innerHTML = ''; return; }
  const row = (label, s) => `<div class="h2hrow"><span class="h2hn">${label}</span>`
    + `<span class="turnstat">${s && s.turnaju
      ? `${s.turnaju} turn. · ${s.winpct != null ? s.winpct + '% výher' : ''} (${s.v}–${s.p})`
      : '<span class="na">—</span>'}</span></div>`;
  const pos = (ts.pohar_pozice && ts.pohar_total)
    ? `<div class="h2htot">Pořadí v poháru (živé): <b>${ts.pohar_pozice}/${ts.pohar_total}</b></div>` : '';
  box.innerHTML = `<h3>Turnajová aktivita (Středočeský pohár)</h3>${pos}`
    + row('Aktuální sezóna (od 1.6.)', ts.cur)
    + row('Minulá sezóna', ts.last);
}

function renderH2H(p) {
  const box = $('dH2H'); const hh = p.h2h || {};
  const keys = Object.keys(hh);
  if (!keys.length) {
    box.innerHTML = `<h3>Vzájemná bilance na turnajích (vs naši hráči)</h3>`
      + `<p class="hint">Žádné vzájemné zápasy v datech${p.isCand ? ' (kandidát — bilanci proti našim doplníme později)' : ''}.</p>`;
    return;
  }
  let tv = 0, tp = 0, rows = '';
  for (const opp of keys) {
    const [v, l] = hh[opp]; tv += v; tp += l; const tot = v + l, pct = Math.round(100 * v / tot);
    const cls = v > l ? 'win' : (v < l ? 'loss' : 'even');
    rows += `<div class="h2hrow"><span class="h2hn">${opp}</span>`
      + `<span class="h2hbar"><span class="${cls}" style="width:${pct}%"></span></span>`
      + `<span class="h2hv ${cls}">${v}–${l}</span></div>`;
  }
  const tpct = Math.round(100 * tv / (tv + tp));
  box.innerHTML = `<h3>Vzájemná bilance na turnajích (vs naši hráči)</h3>`
    + `<div class="h2htot">Celkem <b>${tv}–${tp}</b> · ${tpct}% výher</div>${rows}`;
}

async function renderHistory(p) {
  const box = $('dHistory');
  // Náš roster: kompletní historie z team_history.json (sezóna → tým → liga).
  const hist = TEAM_HISTORY[p.jmeno];
  if (hist && hist.length) {
    box.innerHTML = `<h3>Kariéra (sezóna · tým · liga · LKH)</h3>`
      + hist.map(h => h.pauza
        ? `<div class="histrow pauza"><span><b>${h.season}</b> · — pauza / neregistrován —</span><span></span></div>`
        : `<div class="histrow"><span><b>${h.season}</b> · ${h.tym}`
          + `<span class="histliga"> ${h.liga || ''}</span></span>`
          + `<span class="histlkh">${h.lkh != null ? 'LKH ' + h.lkh : ''}</span></div>`).join('');
    return;
  }
  // Kandidát / mimo roster: live z profilu (aktuální tým).
  if (!p.reg) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3>Historie</h3><p class="hint">Načítám…</p>`;
  try {
    const html = await proxyGet(`https://turnaje.org/profily-hracu/${p.reg}`);
    const seg = (html.match(/Družstva([\s\S]*?)(Platnost|<\/body)/) || [])[1] || '';
    const lines = seg.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').split('\n').map(s => s.trim()).filter(Boolean);
    const teams = [];
    for (let i = 0; i < lines.length; i++)
      if (/^od /.test(lines[i]) && lines[i + 1]) teams.push(`${lines[i + 1]} (${lines[i]})`);
    box.innerHTML = `<h3>Aktuální tým</h3>`
      + (teams.length ? teams.map(t => `<div class="histrow">${t}</div>`).join('')
        : '<p class="hint">Tým není v profilu k dispozici.</p>');
  } catch {
    box.innerHTML = `<h3>Historie</h3><p class="hint">Nepodařilo se načíst (jen online).</p>`;
  }
}

function renderLigaInputs() {
  const box = $('ligaBox'); box.style.display = params.ligaOn ? '' : 'none';
  const popis = DATA.liga_popis || {}; box.innerHTML = '';
  for (const k of Object.keys(params.ligaKor || {})) {
    const pct = Math.round((params.ligaKor[k] - 1) * 100);  // ± % vůči 1.lize
    const w = document.createElement('label'); w.className = 'liga-item';
    w.innerHTML = `<span>${popis[k] || k}</span>`
      + `<span class="pctwrap"><input type="number" step="1" data-k="${k}" value="${pct}" class="pctin">%</span>`;
    box.appendChild(w);
  }
  box.querySelectorAll('input').forEach(inp => inp.onchange = e => {
    params.ligaKor[e.target.dataset.k] = 1 + (+e.target.value || 0) / 100; saveParams(); render(); });
}

function syncControls() {
  $('wLkh').value = params.wLkh; $('wBt').value = params.wBt; $('wTurn').value = params.wTurn;
  $('wLkhOut').textContent = (+params.wLkh).toFixed(2);
  $('wBtOut').textContent = (+params.wBt).toFixed(2);
  $('wTurnOut').textContent = (+params.wTurn).toFixed(2);
  $('aSize').value = params.aSize;
  $('ligaOn').checked = params.ligaOn;
  $('relOn').checked = params.relOn; $('lref').value = params.lref;
  renderLigaInputs(); legStats();
}

function bind() {
  const upd = (k, el, out) => { params[k] = +el.value; if (out) $(out).textContent = (+el.value).toFixed(2);
    saveParams(); render(); };
  $('wLkh').oninput = e => upd('wLkh', e.target, 'wLkhOut');
  $('wBt').oninput = e => upd('wBt', e.target, 'wBtOut');
  $('wTurn').oninput = e => upd('wTurn', e.target, 'wTurnOut');
  $('aSize').onchange = e => { params.aSize = Math.max(1, +e.target.value || 1); saveParams(); syncControls(); render(); };
  $('ligaOn').onchange = e => { params.ligaOn = e.target.checked; saveParams(); renderLigaInputs(); render(); };
  $('relOn').onchange = e => { params.relOn = e.target.checked; saveParams(); render(); };
  $('lref').onchange = e => { params.lref = Math.max(10, +e.target.value || 120); saveParams(); render(); };
  $('reset').onclick = () => { params = defaults(); saveParams(); syncControls(); render(); };

  // menu + prepinani views
  const menu = $('menu'), scrim = $('scrim');
  const toggleMenu = (show) => { menu.classList.toggle('hidden', !show); scrim.classList.toggle('hidden', !show); };
  $('menuBtn').onclick = () => toggleMenu(menu.classList.contains('hidden'));
  scrim.onclick = () => toggleMenu(false);
  document.querySelectorAll('.menuItem[data-view]').forEach(b => b.onclick = () => {
    const v = b.dataset.view;
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + v));
    toggleMenu(false);
    if (v === 'archiv') renderArchiv();
  });

  // detail hráče
  const closeDetail = () => { $('detail').classList.add('hidden'); history.replaceState(null, '', location.pathname); };
  $('detailClose').onclick = closeDetail;
  $('detail').onclick = e => { if (e.target.id === 'detail') closeDetail(); };

  // detail týmu / soupeře
  const closeTeam = () => { $('teamDetail').classList.add('hidden'); scoutTeam = null; };
  $('teamDetailClose').onclick = closeTeam;
  $('teamDetail').onclick = e => { if (e.target.id === 'teamDetail') closeTeam(); };

  // simulátor — váha turnaj/liga
  const swt = $('simWT');
  if (swt) {
    const lab = () => { $('simWTout').textContent = `${Math.round(simWT * 100)}% turnaj / ${Math.round((1 - simWT) * 100)}% liga`; };
    swt.value = simWT; lab();
    swt.oninput = e => { simWT = +e.target.value; lab(); renderSim(); };
  }

  // předvolby
  document.querySelectorAll('.preset').forEach(b => b.onclick = () => applyPreset(b.dataset.p));
}

// ---- B: Přidat hráče (kandidáti přes Cloudflare proxy) ----
const WORKER = 'https://7rota-proxy.schramlp-1a4.workers.dev/?url=';
const LS_CAND = '7rota_candidates';
const SEARCH_TID = '110856';  // anchor turnaj (all=1 hledá globálně)

// sipky.org je v kódování windows-1250 (cp1250) — dekóduj správně, jinak mojibake (�).
// turnaje.org je UTF-8.
async function proxyGet(target) {
  const r = await fetch(WORKER + encodeURIComponent(target));
  const buf = await r.arrayBuffer();
  const cp = target.includes('sipky.org') ? 'windows-1250' : 'utf-8';
  return new TextDecoder(cp).decode(buf);
}
const loadCand = () => { try { return JSON.parse(localStorage.getItem(LS_CAND)) || []; } catch { return []; } };
const saveCand = (a) => localStorage.setItem(LS_CAND, JSON.stringify(a));

async function searchPlayers(name) {
  const url = `https://turnaje.org/modules/varan/ajax/ajaxSearchPlayer.php?tid=${SEARCH_TID}&all=1&term=${encodeURIComponent(name)}`;
  const txt = await proxyGet(url);
  let arr; try { arr = JSON.parse(txt); } catch { return []; }
  return (arr || []).map(o => {
    const parts = (o.label || '').split('|').map(s => s.trim());
    return { reg: o.id, jmeno: o.name || parts[0] || '', rok: parts[2] || '' };
  });
}

async function fetchCandidateStats(reg) {
  for (const season of ['2026', '2025', '2024']) {
    const url = `https://turnaje.org/modules/playerprofile/playerprofile.php?getstats=season&season=${season}&rn=${reg}&couples=false`;
    const txt = await proxyGet(url);
    if (txt.trim().startsWith('{')) {
      try {
        const s = JSON.parse(txt);
        if (s.total) return { season, total: s.total, wins: s.wins,
          winpct: Math.round(100 * s.wins / s.total), tours: s.totalTours,
          m1: s.firstPlacesCount, m2: s.secondPlacesCount, m3: s.thirdPlacesCount };
      } catch {}
    }
  }
  return null;
}

async function fetchCandidateClub(reg) {
  try {
    const html = await proxyGet(`https://turnaje.org/profily-hracu/${reg}`);
    const txt = html.replace(/<[^>]+>/g, ' | ').replace(/(\s*\|\s*)+/g, ' | ');
    const m = txt.match(/Klub \| ([^|]+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Pohár body (= turnajová metrika srovnatelná s našimi hráči) + kat + klub
async function fetchCandidatePohar(reg) {
  for (const rank of ['64008', '63752']) {
    try {
      const html = await proxyGet(`https://www.sipky.org/?region=stc&page=poradi-hracu-v-zebricku&rank=${rank}&players_limit=5000`);
      for (const tr of html.split('</tr>')) {
        if (!tr.includes(reg)) continue;
        const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()).filter(Boolean);
        const kat = cells.find(c => /^[A-D]$/.test(c)) || null;
        const ri = cells.findIndex(c => c === reg);
        const klub = ri >= 0 && cells[ri + 2] ? cells[ri + 2] : null;  // reg, kat, klub
        let body = null;
        for (let i = cells.length - 1; i >= 0; i--) { const d = cells[i].replace(/\s/g, ''); if (/^\d+$/.test(d)) { body = +d; break; } }
        return { body, kat, klub };
      }
    } catch {}
  }
  return { body: null, kat: null, klub: null };
}

function renderResults(list) {
  const box = $('qResults'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<p class="hint">Nic nenalezeno. Zkus jen příjmení, nebo celé jméno (Příjmení Jméno).</p>'; return; }
  if (list.length >= 20)
    box.innerHTML = '<p class="hint">⚠️ Zobrazeno prvních 20. Pokud hráče nevidíš, <b>zpřesni dotaz</b> — napiš celé jméno (Příjmení Jméno), např. „Andr Jan".</p>';
  for (const c of list) {
    const d = document.createElement('div'); d.className = 'qitem';
    d.innerHTML = `<div><b>${c.jmeno}</b><span class="sub">${c.reg}${c.rok ? ' · *' + c.rok : ''}</span></div>
      <button class="btn small add" data-reg="${c.reg}" data-j="${c.jmeno}" data-r="${c.rok}">Přidat</button>`;
    box.appendChild(d);
  }
  box.querySelectorAll('.add').forEach(b => b.onclick = async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '…';
    const reg = btn.dataset.reg;
    const [stats, pohar] = await Promise.all([fetchCandidateStats(reg), fetchCandidatePohar(reg)]);
    const li = LIGA_INDEX[btn.dataset.j] || null;           // tým + liga + LKH z ligového indexu
    const klub = (li && li.tym) || pohar.klub || await fetchCandidateClub(reg);
    const cands = loadCand();
    if (!cands.find(x => x.reg === reg))
      cands.push({ reg, jmeno: btn.dataset.j, rok: btn.dataset.r, klub,
        kat: (li && li.kat) || pohar.kat, turnaje: pohar.body, stats, active: false,
        lkh: li ? li.lkh : null, legy: li ? li.legy : null, liga: li ? li.liga : null });
    saveCand(cands); renderCandidates();
    btn.textContent = '✓ přidán';
  });
}

function renderCandidates() {
  const box = $('candList'), cands = loadCand();
  $('candEmpty').style.display = cands.length ? 'none' : '';
  box.innerHTML = '';
  for (const c of cands) {
    const s = c.stats;
    const li = LIGA_INDEX[c.jmeno] || {};            // dotáhni LKH/ligu/tým z indexu i pro starší kandidáty
    const lkh = c.lkh != null ? c.lkh : (li.lkh != null ? li.lkh : null);
    const liga = c.liga || li.liga;
    if (!c.klub && li.tym) c.klub = li.tym;
    const tb = c.turnaje != null ? `pohár ${c.turnaje} b.` : 'turnaje —';
    const winInfo = s ? `, ${s.winpct}% výher` : '';
    const ligaInfo = lkh != null ? `${liga || 'liga ?'} · LKH ${lkh}` : 'liga —';
    const rankable = c.turnaje != null || lkh != null;
    const d = document.createElement('div'); d.className = 'canditem';
    d.innerHTML = `<div style="flex:1">
        <b>${c.jmeno}</b> <span class="sub">${c.reg}${c.rok ? ' · *' + c.rok : ''}${c.kat ? ' · kat ' + c.kat : ''}</span>
        <div class="sub2">${c.klub || 'klub —'}</div>
        <div class="sub2">${ligaInfo} · ${tb}${winInfo}</div>
        <label class="candtoggle"><input type="checkbox" class="candAct" data-reg="${c.reg}"${c.active ? ' checked' : ''}>
          zařadit do žebříčku (jako kandidát)</label>
        ${!rankable ? '<div class="sub2">⚠️ bez ligy i turnajů → nelze srovnat, do žebříčku se nezařadí</div>' : ''}
      </div>
      <button class="xbtn on" data-reg="${c.reg}">✕</button>`;
    box.appendChild(d);
  }
  box.querySelectorAll('.candAct').forEach(t => t.onchange = e => {
    const cs = loadCand(); const c = cs.find(x => x.reg === e.target.dataset.reg);
    if (c) { c.active = e.target.checked; saveCand(cs); render(); }
  });
  box.querySelectorAll('.xbtn').forEach(b => b.onclick = (e) => {
    saveCand(loadCand().filter(x => x.reg !== e.target.dataset.reg)); renderCandidates(); render();
  });
}

function bindSearch() {
  const run = async () => {
    const q = $('qName').value.trim();
    if (q.length < 3) { $('qResults').innerHTML = '<p class="hint">Zadej aspoň 3 znaky.</p>'; return; }
    $('qResults').innerHTML = '<p class="hint">Hledám…</p>';
    try { renderResults(await searchPlayers(q)); }
    catch (err) { $('qResults').innerHTML = '<p class="hint">Chyba spojení (proxy). Zkus znovu.</p>'; }
  };
  $('qBtn').onclick = run;
  $('qName').onkeydown = (e) => { if (e.key === 'Enter') run(); };
}

// ================= SCOUTING (Rozpis + Soupeři) =================
// Data: scout.json (rozpis + týmy vč. našeho, per hráč {lkh, kat, legy, turnaje}).
// Síla = LKH po STEJNÉ ligové korekci jako žebříček (params.ligaKor[kat]) → předvolba
// (Mírná/Vyvážená/Plná) ovlivní i scouting. Naše liga = kat B (1. liga) = baseline.
const escH = (s) => ('' + (s == null ? '' : s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function oppLkh(pl) {
  if (pl.lkh == null) return null;
  if (params.ligaOn && pl.kat && params.ligaKor[pl.kat] != null) return pl.lkh * params.ligaKor[pl.kat];
  return pl.lkh;
}
function teamStrength(t) {
  const adj = t.hraci.map(oppLkh).filter(v => v != null);
  return { top: adj.length ? Math.max(...adj) : 0, strong: adj.filter(v => v >= 70).length };
}
const dangerCol = (v) => v >= 90 ? '#dc2626' : v >= 70 ? '#b8791a' : 'var(--teal)';
const katLiga = (kat) => (DATA.liga_popis && DATA.liga_popis[kat]) || kat || '?';
const crossKat = (kat) => (!kat || kat === 'B') ? null : ((kat === 'C' || kat === 'D') ? 'low' : 'high');
const normTeam = (s) => ('' + s).replace(/\s*Praha\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const teamIdxByShort = (short) => SCOUT ? SCOUT.teams.findIndex(t => normTeam(t.nazev) === normTeam(short)) : -1;

const RES_NM = { V: 'výhra', R: 'remíza', P: 'prohra' };

function bilanceHtml() {
  const b = SCOUT && SCOUT.bilance;
  if (!b || !b.odehrano) return '';
  const zbyva = SCOUT.rozpis.length - b.odehrano;
  return `<div class="rz-bil">
    <span class="rz-bil-sc">${b.v}–${b.r}–${b.p}</span>
    <span class="rz-bil-meta">${b.odehrano} z ${SCOUT.rozpis.length} odehráno · her ${b.her_pro}:${b.her_proti}
      · ${b.body} ${b.body === 1 ? 'bod' : (b.body < 5 ? 'body' : 'bodů')}${zbyva ? ' · zbývá ' + zbyva : ''}</span></div>`;
}

function renderRozpis() {
  const box = $('rozpisList'); if (!box || !SCOUT) return;
  // "PŘÍŠTÍ" patri prvnimu NEodehranemu, ne prvnimu v poradi
  const nextI = SCOUT.rozpis.findIndex(m => !m.res);
  box.innerHTML = bilanceHtml() + SCOUT.rozpis.map((m, i) => {
    const dm = m.datum.split('.');
    const next = i === nextI ? ' <span class="rz-next">PŘÍŠTÍ</span>' : '';
    const sc = m.res
      ? `<span class="rz-sc ${m.res}" title="${RES_NM[m.res]}">${m.my}:${m.opp}</span>`
      : '';
    return `<button class="rz-row${m.res ? ' done' : ''}" data-i="${teamIdxByShort(m.souper)}">
      <span class="rz-date"><b>${dm[0]}.${dm[1]}.</b><small>${m.den}</small></span>
      <span class="rz-main"><span class="rz-opp">${escH(m.souper)}${next}</span>
        <span class="rz-meta">${m.res ? RES_NM[m.res] : m.cas} · ${escH(m.hala)}</span></span>
      ${sc}
      <span class="rz-ha ${m.doma ? 'h' : 'a'}">${m.doma ? 'DOMA' : 'VENKU'}</span></button>`;
  }).join('');
  box.querySelectorAll('.rz-row').forEach(b => b.onclick = () => openTeam(+b.dataset.i));
}

function teamCard(t) {
  const i = SCOUT.teams.indexOf(t), s = teamStrength(t);
  const meta = t.us ? `1. liga A · ${s.strong} opor (síla ≥ 70)`
    : `${t.novy ? 'nový · z ' + (t.lonska_liga || '?') : 'v lize i loni'} · ${s.strong} silných`;
  const col = t.us ? 'var(--teal)' : dangerCol(s.top);
  return `<button class="tm-row${t.us ? ' us' : ''}" data-i="${i}">
    <span class="tm-dot" style="background:${col}"></span>
    <span class="tm-main"><span class="tm-name">${escH(t.nazev)}${t.us ? ' <span class="tm-badge">MŮJ TÝM</span>' : ''}</span>
      <span class="tm-meta">${meta}</span></span>
    <span class="tm-str"><b style="color:${col}">${s.top ? Math.round(s.top) : '–'}</b><small>síla</small></span></button>`;
}
function renderSouperiList() {
  const box = $('souperiList'); if (!box || !SCOUT) return;
  const us = SCOUT.teams.find(t => t.us);
  const opp = SCOUT.teams.filter(t => !t.us).sort((a, b) => teamStrength(b).top - teamStrength(a).top);
  let h = '';
  if (us) h += `<div class="scout-eyebrow">Můj tým</div>` + teamCard(us);
  h += `<div class="scout-eyebrow">Soupeři · ${opp.length} týmů</div>` + opp.map(teamCard).join('');
  box.innerHTML = h;
  box.querySelectorAll('.tm-row').forEach(b => b.onclick = () => openTeam(+b.dataset.i));
}

function openTeam(i) { if (i == null || i < 0) return; scoutTeam = i; renderTeamDetail(); $('teamDetail').classList.remove('hidden'); }
// LKH bezici sezony: mala hodnota vedle lonske. Pod 4 legy ji neuvadi ani web
// (overeno 2026-09-10: vsech 9 hracu bez LKH na webu melo <= 3 legy) -> ztlumit.
function nowTag(p) {
  if (p.lkh_n == null) return '';
  const low = (p.leg_n || 0) < 4;
  const t = `LKH běžící sezóny: ${p.lkh_n} z ${legStr(p.leg_n)}` + (p.zap_n ? ` (${p.zap_n} zápasy)` : '');
  return `<span class="pl-now${low ? ' low' : ''}" title="${t}">letos ${Math.round(p.lkh_n)}</span>`;
}

function renderTeamDetail() {
  if (scoutTeam == null) return; const t = SCOUT.teams[scoutTeam]; const s = teamStrength(t);
  const players = [...t.hraci].sort((a, b) => (oppLkh(b) ?? -1) - (oppLkh(a) ?? -1));
  const max = Math.max(60, s.top);
  const dangers = players.filter(p => oppLkh(p) != null && oppLkh(p) >= 70);
  const jenLiga = players.filter(p => p.lkh != null && p.turnaje == null).length;
  const crossN = players.filter(p => crossKat(p.kat)).length;
  let h = `<div class="td-head"><h2>${escH(t.nazev)}</h2><div class="td-tags">`;
  if (t.us) {
    h += `<span class="td-tag lvl">MŮJ TÝM · 1. liga A</span><span class="td-tag">${s.strong} opor (síla ≥ 70)</span>`;
  } else {
    h += t.novy ? `<span class="td-tag new">NOVÝ · z ${escH(t.lonska_liga || '?')}</span>` : `<span class="td-tag lvl">v 1. lize i loni</span>`;
    if (s.top >= 90) h += `<span class="td-tag danger">⚠️ elitní hráč</span>`;
    h += `<span class="td-tag">${s.strong} hrozeb (síla ≥ 70)</span>`;
  }
  h += `</div></div>`;
  if (dangers.length) {
    const names = dangers.slice(0, 3).map(p => `<b>${escH(p.jmeno)}</b> (${Math.round(oppLkh(p))})`).join(', ');
    h += `<div class="td-note">${t.us ? '💪 <b>Naše opory:</b>' : '🎯 <b>Pozor na:</b>'} ${names}${dangers.length > 3 ? ' a další' : ''}.`
      + (jenLiga ? ` ${jenLiga} hráčů hraje jen ligu (bez turnajů).` : '') + `</div>`;
  }
  if (crossN) h += `<div class="td-note">🔀 <b>${crossN} z jiné ligy:</b> LKH přepočteno na 1. ligu dle nastavené korekce (Nastavení). Řazení i hrozby počítám z přepočtu.</div>`;
  const hasNow = players.some(p => p.lkh_n != null);
  if (hasNow) h += `<div class="td-note">📈 <b>letos</b> = LKH běžící sezóny 2026/27. Velké číslo je loňské (stabilní báze),
    <span class="pl-now">letos</span> se počítá z málo legů — <span class="pl-now low">šedě</span> jsou pod 4 legy, tam to zatím nic neznamená.</div>`;
  h += `<div class="scout-eyebrow">Soupiska dle síly</div><div class="td-plist">`;
  players.forEach((p, idx) => {
    const a = oppLkh(p); const w = a != null ? Math.max(4, Math.round(a / max * 100)) : 0;
    const col = a >= 90 ? '#dc2626' : a >= 70 ? '#b8791a' : 'var(--teal)';
    const cc = crossKat(p.kat);
    const chips = (t.transfers && t.transfers.prisli.includes(p.jmeno) ? '<span class="pchip in">↑ přišel</span>' : '')
      + (cc ? `<span class="pchip ${cc}">${escH(katLiga(p.kat))}</span>` : '')
      + (p.lkh != null && p.turnaje == null ? '<span class="pchip jl">jen liga</span>' : '')
      + (p.lkh == null ? '<span class="pchip jl">bez dat</span>' : '');
    h += `<div class="pl-row"><span class="pl-rank">${idx + 1}</span>
      <span class="pl-main"><span class="pl-name">${escH(p.jmeno)} ${chips}</span>
        <span class="pl-bar"><i style="width:${w}%;background:${col}"></i></span></span>
      <span class="pl-lkh"><b>${p.lkh != null ? Math.round(p.lkh) : '–'}</b><small>LKH</small>${cc ? `<span class="pl-adj">≈${Math.round(a)}</span>` : ''}${nowTag(p)}</span></div>`;
  });
  h += `</div>`;
  if (t.transfers && (t.transfers.prisli.length || t.transfers.odesli.length)) {
    h += `<div class="scout-eyebrow">Přestupy oproti loňsku</div><div class="td-tr">`;
    t.transfers.prisli.forEach(n => h += `<div class="tr-l in">↑ přišel ${escH(n)}</div>`);
    t.transfers.odesli.forEach(n => h += `<div class="tr-l out">↓ odešel ${escH(n)}</div>`);
    h += `</div>`;
  }
  h += `<p class="hint">Síla = LKH po ligové korekci (mění se dle předvolby v Nastavení). ≈ = přepočet na 1. ligu · <b style="color:#dc2626">≥90 elita</b> · <b style="color:#b8791a">≥70 silný</b>.</p>`;
  $('tdBody').innerHTML = h;
}
function renderScout() {
  if (!SCOUT) return;
  renderRozpis(); renderSouperiList();
  if (scoutTeam != null && !$('teamDetail').classList.contains('hidden')) renderTeamDetail();
}

// ================= SIMULÁTOR ZÁPASU =================
// Predikce z BLENDU: turnajový rating (rt, recency-vážený z 64k zápasů) + ligové
// LKH-implikované (rl). Váha simWT laditelná sliderem (0=jen liga, 1=jen turnaj).
let SIM = null, simMatch = 0, simSel = { us: new Set(), opp: new Set() }, simWT = 0.5;
let OPP_POS = {};   // profil pozicovani souperu z lonskych zapasu (kdo hraje kterou pozici)
let simTactic = 'A';   // A=clutch (silni na konec), B=rychly start, C=zkusenost (osvedceni do ohne)
let simOrder = null;   // rucni override naseho poradi (pole jmen); null = auto dle taktiky
let simOppOrder = null; // rucni override souperova poradi (pole jmen); null = auto dle ratingu
const simWp = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));
function effR(h) {
  if (h.rt != null && h.rl != null) return Math.round(simWT * h.rt + (1 - simWT) * h.rl);
  return h.rt != null ? h.rt : h.rl;
}
const simFcol = (f) => f == null ? 'var(--mut)' : f >= 60 ? 'var(--a)' : f <= 40 ? '#dc2626' : '#b8791a';
const simShort = (n) => ('' + n).split(' ')[0];
const simNorm = (s) => ('' + s).replace(/\s*Praha\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const simUsTeam = () => SIM.teams.find(t => t.us);
const simOppTeam = () => { const m = SIM.rozpis[simMatch]; return SIM.teams.find(t => simNorm(t.n) === simNorm(m.souper || m.s)); };
const simRated = (team) => team.hraci.filter(h => effR(h) != null);
function simInitSel() {
  const top = (team) => simRated(team).slice().sort((a, b) => effR(b) - effR(a)).slice(0, 4).map(h => h.j);
  // F3: nasi = vsichni dostupni (odskrtnutim = "dnes nehraje"); souper = predpokladane jadro 4
  simSel.us = new Set(simRated(simUsTeam()).map(h => h.j));
  simSel.opp = new Set(top(simOppTeam()));
  simOrder = null; simOppOrder = null;  // zmena zapasu -> zrus rucni prehozeni
}
// F3 rozpis: pozice -> singly hry (kanonicky z 156 realnych zapisu, 100% konzistentni).
// Domaci (D) a hoste (H) maji jine PORADI her, ale POSLEDNI hra pozice je stejna: pos1->15..pos4->18.
const POS_GAMES_D = { 1: [1, 5, 11, 15], 2: [2, 6, 12, 16], 3: [3, 7, 13, 17], 4: [4, 8, 14, 18] };
const POS_GAMES_H = { 1: [3, 8, 12, 15], 2: [4, 7, 11, 16], 3: [1, 6, 14, 17], 4: [2, 5, 13, 18] };
const DECISIVE = new Set([15, 16, 17, 18]);  // pozdni rozhodujici single hry (konec utkani)
const posGames = () => (SIM && SIM.rozpis[simMatch] && SIM.rozpis[simMatch].doma) ? POS_GAMES_D : POS_GAMES_H;
const simChosen = (team, who) => simRated(team).filter(h => simSel[who].has(h.j)).sort((a, b) => effR(b) - effR(a)).slice(0, 4);

function renderSimChips() {
  const box = $('simChips'); if (!box || !SIM) return;
  box.innerHTML = SIM.rozpis.map((m, i) => {
    const dm = String(m.datum || m.dt || '').split('.');
    return `<button class="sim-chip${i === simMatch ? ' on' : ''}" data-i="${i}">
      <span class="sc-d">${m.den} ${dm[0]}.${dm[1]}.</span>
      <span class="sc-o">${escH(m.souper || m.s)}</span>
      <span class="sc-ha ${m.doma ? 'h' : 'a'}">${m.doma ? 'DOMA' : 'VENKU'}</span></button>`;
  }).join('');
  box.querySelectorAll('.sim-chip').forEach(c => c.onclick = () => { simMatch = +c.dataset.i; simInitSel(); renderSim(); });
}
function simPlayerRow(h, who) {
  const on = simSel[who].has(h.j), r = effR(h);
  const conf = h.rt != null ? 'N' + h.eN : 'z ligy';
  return `<div class="sim-pl${on ? ' on' : ' off'}" data-who="${who}" data-j="${escH(h.j)}">
    <span class="sim-cb">${on ? '✓' : ''}</span>
    <span class="sim-pi"><span class="sim-pn">${escH(h.j)}</span>
      <span class="sim-ps"><span class="sim-src${h.rt != null ? '' : ' liga'}">${conf}</span>${h.f != null ? `<span class="sim-fdot" style="background:${simFcol(h.f)}"></span>${h.f}%` : ''}</span></span>
    <span class="sim-pr">${r == null ? '–' : r}</span></div>`;
}
function renderSimLineups() {
  const opp = simOppTeam();
  $('simOppName').textContent = '🔴 ' + opp.n.replace(' Praha', '');
  $('simUs').innerHTML = simRated(simUsTeam()).sort((a, b) => effR(b) - effR(a)).map(h => simPlayerRow(h, 'us')).join('');
  $('simOpp').innerHTML = simRated(opp).sort((a, b) => effR(b) - effR(a)).map(h => simPlayerRow(h, 'opp')).join('');
  document.querySelectorAll('.sim-pl').forEach(p => p.onclick = () => {
    const w = p.dataset.who, j = p.dataset.j; simSel[w].has(j) ? simSel[w].delete(j) : simSel[w].add(j); renderSim();
  });
}
const simGcol = (p) => p >= 55 ? `rgba(21,128,61,${0.4 + (p - 55) / 110})` : p <= 45 ? `rgba(220,38,38,${0.4 + (45 - p) / 110})` : 'var(--mut)';
function renderSimGrid() {
  const us = simChosen(simUsTeam(), 'us'), opp = simChosen(simOppTeam(), 'opp'), g = $('simGrid');
  if (!us.length || !opp.length) { g.innerHTML = `<tr><td class="sim-rn">Vyber aspoň 1 hráče na každé straně.</td></tr>`; return; }
  let h = `<tr><th class="sim-corner">my / soupeř</th>${opp.map(o => `<th>${escH(simShort(o.j))}</th>`).join('')}</tr>`;
  us.forEach(u => { h += `<tr><td class="sim-rn">${escH(simShort(u.j))}</td>` + opp.map(o => { const p = Math.round(simWp(effR(u), effR(o)) * 100); return `<td class="sim-g" style="background:${simGcol(p)}">${p}</td>`; }).join('') + `</tr>`; });
  g.innerHTML = h;
}
function simPoisson(ps) { let d = [1]; for (const p of ps) { const nd = new Array(d.length + 1).fill(0); for (let i = 0; i < d.length; i++) { nd[i] += d[i] * (1 - p); nd[i + 1] += d[i] * p; } d = nd; } return d; }
// Double/Cricket: 2 nase dvojice vs 2 jejich na 2 tercich (2:0/1:1/0:2); pri 1:1 rozhodnou vitezove.
// us4/opp4 = 4 hraci (dvojice [0,1] a [2,3]). Vraci P(vyhrajeme segment).
function doublesWin(us4, opp4) {
  const pr = (a, b) => (effR(a) + effR(b)) / 2;
  if (us4.length < 4 || opp4.length < 4) {
    const uP = pr(us4[0], us4[1] || us4[0]), oP = pr(opp4[0], opp4[1] || opp4[0]);
    return simWp(uP, oP);
  }
  const P1 = pr(us4[0], us4[1]), P2 = pr(us4[2], us4[3]), Q1 = pr(opp4[0], opp4[1]), Q2 = pr(opp4[2], opp4[3]);
  const p1 = simWp(P1, Q1), p2 = simWp(P2, Q2);       // vyhra na tercich
  const d1 = simWp(P1, Q2), d2 = simWp(P2, Q1);       // rozhodujici: nas vitez vs jejich vitez
  return p1 * p2 + p1 * (1 - p2) * d1 + (1 - p1) * p2 * d2;
}
function renderSimPred() {
  const us = simChosen(simUsTeam(), 'us'), opp = simChosen(simOppTeam(), 'opp'), box = $('simPred');
  if (us.length < 1 || opp.length < 1) { box.innerHTML = '<p class="hint">Vyber hráče v sestavách níže.</p>'; return; }
  const sp = []; us.forEach(u => opp.forEach(o => sp.push(simWp(effR(u), effR(o)))));
  const dw = doublesWin(us.slice(0, 4), opp.slice(0, 4));   // double + cricket (2 dvojice + rozhodujici)
  const all = sp.concat([dw, dw]);
  const exp = all.reduce((s, x) => s + x, 0), tot = all.length, dist = simPoisson(all), half = tot / 2;
  let pw = 0, pt = 0, pl = 0; dist.forEach((v, i) => { i > half ? pw += v : i === half ? pt += v : pl += v; });
  const W = Math.round(pw * 100), T = Math.round(pt * 100), L = Math.round(pl * 100);
  const oppTop = opp[0]; let best = { p: -1 }; us.forEach(u => opp.forEach(o => { const p = simWp(effR(u), effR(o)); if (p > best.p) best = { p, u: u.j, o: o.j }; }));
  box.innerHTML = `<div class="sim-pred">
    <div class="sim-psc"><div class="v">${exp.toFixed(1)}<span style="color:var(--mut)">:</span>${(tot - exp).toFixed(1)}</div><div class="l">očekávané skóre / ${tot}</div></div>
    <div class="sim-pbwrap"><div class="sim-pbar"><div class="w" style="width:${W}%">${W > 12 ? W + '%' : ''}</div><div class="t" style="width:${T}%">${T > 8 ? T + '%' : ''}</div><div class="l" style="width:${L}%">${L > 12 ? L + '%' : ''}</div></div>
      <div class="sim-plab"><span>výhra</span><span>remíza</span><span>prohra</span></div></div></div>
    <div class="sim-callout">
      <div class="sim-co warn"><b>⚠️ Pozor na</b>${escH(oppTop.j)} · ${effR(oppTop)}${oppTop.f != null ? ` · forma ${oppTop.f}%` : ''}</div>
      <div class="sim-co arm"><b>💪 Naše zbraň</b>${escH(simShort(best.u))} vs ${escH(simShort(best.o))} · ${Math.round(best.p * 100)}% pro nás</div></div>`;
}
// F3: optimalizace paru na double + cricket (2 dvojice na 2 tercich + rozhodujici). Enumeruje rozdeleni top-4.
function renderSimDoubles() {
  const box = $('simDoubles'); if (!box) return;
  const us = simChosen(simUsTeam(), 'us'), opp = simChosen(simOppTeam(), 'opp');
  if (us.length < 2) { box.innerHTML = '<div class="hint" style="margin-top:10px">Pro páry vyber aspoň 2 hráče v naší sestavě.</div>'; return; }
  const pr = (x, y) => (effR(x) + effR(y)) / 2;
  const nm = (x, y) => `${escH(simShort(x.j))} + ${escH(simShort(y.j))} <span class="sim-pstr">~${Math.round(pr(x, y))}</span>`;
  const p = us.slice(0, 4), opp4 = opp.slice(0, 4);
  if (p.length < 4 || opp4.length < 4) {
    box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">Optimalizace párů (double + cricket)</div>
      <p class="hint">Vyber aspoň 4 hráče (na 2 dvojice) v naší i soupeřově sestavě — pak ti navrhnu páry.</p>`;
    return;
  }
  // vsechna 3 rozdeleni 4 hracu do 2 paru + P(segment); pravidlo: 501 a Cricket = RUZNE dvojice (rotace)
  const splits = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]].map(s => {
    const us4 = [p[s[0][0]], p[s[0][1]], p[s[1][0]], p[s[1][1]]];
    return { w: doublesWin(us4, opp4), a: [us4[0], us4[1]], b: [us4[2], us4[3]] };
  }).sort((x, y) => y.w - x.w);
  const dbl = splits[0], crk = splits[1];  // double = nejlepsi rozdeleni, cricket = 2. nejlepsi (JINE pary)
  box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">Optimalizace párů (double + cricket)</div>
    <div class="sim-dbl">
      <div class="sim-dbl-r"><b>🎯 Double 501 (hra 9)</b> <span class="sim-pstr">${Math.round(dbl.w * 100)} %</span><br>${nm(dbl.a[0], dbl.a[1])} · ${nm(dbl.b[0], dbl.b[1])}</div>
      <div class="sim-dbl-r" style="margin-top:7px"><b>🎯 Cricket (hra 10)</b> <span class="sim-pstr">${Math.round(crk.w * 100)} %</span><br>${nm(crk.a[0], crk.a[1])} · ${nm(crk.b[0], crk.b[1])}</div>
    </div>
    <p class="hint">⚠️ Pravidlo (PRAVIDLA_LIGA.md): stejné páry <b>NESMÍ</b> hrát 501 i Cricket — musí se rotovat. Proto double + cricket = jiné dvojice. % = šance na segment (2 terče + rozhodující při 1:1). Model volí dvě nejlepší RŮZNÁ rozdělení.</p>`;
}
// F3 taktiky: skore, dle ktereho hraci dostavaji rozhodujici pozice.
const TACTICS = {
  A: { nm: 'Rating', desc: 'Nejsilnější dle ratingu jdou na rozhodující pozdní hry.' },
  B: { nm: 'Forma', desc: 'Váží aktuální formu — kdo je teď rozehraný, jde do rozhodujících her.' },
  C: { nm: 'Zkušenost', desc: 'Osvědčení do ohně: nováčky (bez ligy / malý vzorek) posune z rozhodujících her, ať se zapracují v raných.' },
};
function tacScore(h) {
  const base = effR(h);
  if (base == null) return -1e9;
  if (simTactic === 'B') return base + (h.f != null ? (h.f - 50) * 2.5 : 0);
  if (simTactic === 'C') {
    let pen = 0;
    if (h.rl == null) pen += 70;                 // nema ligove LKH = novy/nejisty
    if (h.rt == null) pen += 40;                 // nehraje turnaje = maly vzorek
    if (h.eN != null && h.eN < 12) pen += 35;    // maly turnajovy vzorek
    return base - pen;
  }
  return base;
}
// F3: doporucena sestava — dostupni na pozice dle taktiky, nejlepsi -> pozdni rozhodujici hry + rucni override (sipky).
function renderSimRec() {
  const box = $('simRec'); if (!box || !SIM) return;
  const avail = simRated(simUsTeam()).filter(h => simSel.us.has(h.j));
  const pg = posGames(), away = !(SIM.rozpis[simMatch] && SIM.rozpis[simMatch].doma), side = away ? 'H' : 'D';
  if (avail.length < 1) {
    box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">📋 Doporučená sestava</div>
      <p class="hint">Ťukni na naše hráče výše = kdo dnes hraje. Z dostupných ti sestavím pozice.</p>`;
    return;
  }
  const auto = avail.slice().sort((a, b) => tacScore(b) - tacScore(a));
  const order = simOrder
    ? simOrder.map(j => avail.find(h => h.j === j)).filter(Boolean).concat(auto.filter(h => !simOrder.includes(h.j)))
    : auto;
  const posOrder = [4, 3, 2, 1];  // nejlepsi slot -> pozice 4 (posledni hra 18)
  const tabs = Object.entries(TACTICS).map(([k, t]) =>
    `<button class="tac-btn${simTactic === k ? ' on' : ''}" data-tac="${k}">${t.nm}</button>`).join('');
  let rows = '';
  order.forEach((h, i) => {
    const core = i < 4, pos = core ? posOrder[i] : i + 1;
    const games = core ? pg[pos] : null, lastG = games ? games[games.length - 1] : null;
    const gtxt = games ? games.map(g => DECISIVE.has(g) ? `<b class="rec-dec">${g}</b>` : g).join(' · ')
      : '<span class="rec-subnote">čtyřhry + střídání</span>';
    const up = i > 0 ? `<button class="rec-mv" data-mv="up" data-i="${i}">▲</button>` : '<span class="rec-mvx"></span>';
    const dn = i < order.length - 1 ? `<button class="rec-mv" data-mv="dn" data-i="${i}">▼</button>` : '<span class="rec-mvx"></span>';
    rows += `<tr class="${core ? 'rec-core' : 'rec-sub'}"><td class="rec-pos">${side}${pos}</td>
      <td class="rec-nm">${escH(simShort(h.j))} <span class="rec-r">${effR(h)}${h.f != null ? ` · ${h.f}%` : ''}</span>${core && DECISIVE.has(lastG) ? `<span class="rec-badge">🔑 hra ${lastG}</span>` : ''}</td>
      <td class="rec-g">${gtxt}</td><td class="rec-mvwrap">${up}${dn}</td></tr>`;
  });
  box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">📋 Doporučená sestava <span class="hint2">(${avail.length} hráčů · ${away ? 'venku' : 'doma'})</span></div>
    <div class="tac-row">${tabs}${simOrder ? '<button class="tac-btn reset" data-tac="_reset">↺ auto</button>' : ''}</div>
    <p class="hint" style="margin:2px 0 8px">${TACTICS[simTactic].desc} Nejlepší → pozice s nejpozdější (rozhodující) hrou. Šipkami ▲▼ přehodíš ručně.</p>
    <table class="rec-tbl"><thead><tr><th>Poz</th><th>Hráč (rating · forma)</th><th>Singly hry</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <button id="simSaveBtn" class="save-btn">💾 Uložit sestavu do archivu</button>`;
  box.querySelectorAll('.tac-btn').forEach(b => b.onclick = () => {
    const t = b.dataset.tac;
    if (t === '_reset') simOrder = null; else { simTactic = t; simOrder = null; }
    renderSim();
  });
  box.querySelectorAll('.rec-mv').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, j = b.dataset.mv === 'up' ? i - 1 : i + 1;
    const arr = order.map(h => h.j);[arr[i], arr[j]] = [arr[j], arr[i]];
    simOrder = arr; renderSim();
  });
  const sb = $('simSaveBtn'); if (sb) sb.onclick = saveLineup;
}
// F3: profil pozicovani souperu (kdo loni hrava kterou pozici + jak jsou predvidatelni).
function oppProfile() {
  const m = SIM.rozpis[simMatch], target = simNorm(m.souper || m.s);
  const key = Object.keys(OPP_POS).find(k => simNorm(k) === target);
  return key ? OPP_POS[key] : null;
}
function renderSimOppProfile() {
  const box = $('simOppProfile'); if (!box || !SIM) return;
  const p = oppProfile();
  if (!p) {
    box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">🕵️ Jak soupeř staví sestavu</div>
      <p class="hint">Z loňska nemám jeho pozicování — nový tým v 1. lize A (přišel z nižší soutěže). Naskáče po pár odehraných zápasech sezóny.</p>`;
    return;
  }
  const sig = p.signal === 'predvidatelni' ? '<span class="op-sig p">✅ Předvídatelní</span>'
    : p.signal === 'dost meni' ? '<span class="op-sig m">◐ Dost mění</span>'
    : '<span class="op-sig t">🎲 Hodně rotují (možná taktizují)</span>';
  // ratingy souperovych hracu (stejna skala jako nasi) — z sim_data
  const opp = simOppTeam(), rmap = {};
  if (opp) opp.hraci.forEach(h => { rmap[h.j.trim()] = effR(h); });
  const rtxt = (name) => { const r = rmap[name.trim()]; return r != null ? `<span class="op-r">${r}</span>` : ''; };
  const posRows = ['1', '2', '3', '4'].map(pos => {
    const arr = (p.pozice || {})[pos] || [];
    const pls = arr.map(x => `${escH(x.h.split(' ')[0])} ${rtxt(x.h)} <span class="op-n">${x.n}×</span>`).join(' · ');
    return `<div class="op-prow"><span class="op-pos">poz ${pos}</span><span class="op-pl">${pls || '—'}</span><span class="op-k">${(p.konzistence || {})[pos] || 0}%</span></div>`;
  }).join('');
  box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">🕵️ Jak soupeř staví sestavu <span class="hint2">(${p.zapasu} loňských zápasů)</span></div>
    <div class="op-head">${sig} <span class="hint2">stejné jádro jen ${p.predvidatelnost}% zápasů</span></div>
    <div class="op-tbl">${posRows}</div>
    <p class="hint">Kdo loni hrával kterou pozici (× kolikrát) + konzistence pozice. ${p.predvidatelnost < 15 ? '<b>Hodně rotují</b> → těžko odhadnout, koho dají do rozhodujících pozdních her; drž se svojí strategie.' : 'Docela stálí → jejich rozhodující pozice se dají odhadnout.'} Znáš-li jejich dnešní sestavu, naklikej ji nahoře u „Soupeř".</p>`;
}
// F3: editor souperovy sestavy — Petr naklika JEJICH poradi na boardy (vc. nahradniku). Krmi simOppOrder -> rozhodujici souboje.
function renderSimOppLineup() {
  const box = $('simOppLineup'); if (!box || !SIM) return;
  const opp = simOppTeam();
  const avail = simRated(opp).filter(h => simSel.opp.has(h.j));
  const away = !(SIM.rozpis[simMatch] && SIM.rozpis[simMatch].doma), oppSide = away ? 'D' : 'H';
  const oppPg = away ? POS_GAMES_D : POS_GAMES_H;  // souper je opacna strana nez my
  if (avail.length < 1) {
    box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">🔴 Jejich sestava — naklikej pořadí</div>
      <p class="hint">Ťukni na jejich hráče výše u „Soupeř" = kdo dnes hraje (přidej i náhradníky). Pak je tady ▲▼ seřadíš na boardy.</p>`;
    return;
  }
  const auto = avail.slice().sort((a, b) => effR(b) - effR(a));
  const order = simOppOrder
    ? simOppOrder.map(j => avail.find(h => h.j === j)).filter(Boolean).concat(auto.filter(h => !simOppOrder.includes(h.j)))
    : auto;
  const posOrder = [4, 3, 2, 1];  // top = jejich board 4 (rozhodujici posledni hra 18)
  let rows = '';
  order.forEach((h, i) => {
    const core = i < 4, pos = core ? posOrder[i] : i + 1;
    const games = core ? oppPg[pos] : null, lastG = games ? games[games.length - 1] : null;
    const gtxt = games ? games.map(g => DECISIVE.has(g) ? `<b class="rec-dec">${g}</b>` : g).join(' · ')
      : '<span class="rec-subnote">náhradník (čtyřhry)</span>';
    const up = i > 0 ? `<button class="rec-mv" data-mv="up" data-i="${i}">▲</button>` : '<span class="rec-mvx"></span>';
    const dn = i < order.length - 1 ? `<button class="rec-mv" data-mv="dn" data-i="${i}">▼</button>` : '<span class="rec-mvx"></span>';
    rows += `<tr class="${core ? 'rec-core' : 'rec-sub'}"><td class="rec-pos">${oppSide}${pos}</td>
      <td class="rec-nm">${escH(simShort(h.j))} <span class="rec-r">${effR(h)}${h.f != null ? ` · ${h.f}%` : ''}</span>${core && DECISIVE.has(lastG) ? `<span class="rec-badge">🔑 hra ${lastG}</span>` : ''}</td>
      <td class="rec-g">${gtxt}</td><td class="rec-mvwrap">${up}${dn}</td></tr>`;
  });
  box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">🔴 Jejich sestava — naklikej jejich pořadí <span class="hint2">(${avail.length} vybraných${simOppOrder ? ' · ručně' : ''})</span></div>
    <p class="hint" style="margin:2px 0 8px">1) Nahoře u „Soupeř" ťukni, kdo hraje (i náhradníky). 2) Tady je ▲▼ seřaď na boardy ${oppSide}1-${oppSide}8 dle jejich zápisu / tvého odhadu. Boardy 4·3·2·1 hrají rozhodující hry 18·17·16·15 — ty krmí „Rozhodující souboje".${simOppOrder ? ' <a href="#" id="oppOrdReset">↺ zpět na auto (dle ratingu)</a>' : ''}</p>
    <table class="rec-tbl"><thead><tr><th>Board</th><th>Hráč (rating · forma)</th><th>Singly hry</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll('.rec-mv').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, j = b.dataset.mv === 'up' ? i - 1 : i + 1;
    const arr = order.map(h => h.j);[arr[i], arr[j]] = [arr[j], arr[i]];
    simOppOrder = arr; renderSim();
  });
  const rst = $('oppOrdReset'); if (rst) rst.onclick = (e) => { e.preventDefault(); simOppOrder = null; renderSim(); };
}
// F3: rozhodujici souboje pozdnich her — nase pozice vs jejich pozice (games 15-18 = poz i vs poz i).
function orderedSide(team, sel, ord, tactic) {
  const avail = simRated(team).filter(h => sel.has(h.j));
  const auto = avail.slice().sort((a, b) => (tactic ? tacScore(b) - tacScore(a) : effR(b) - effR(a)));
  return ord ? ord.map(j => avail.find(h => h.j === j)).filter(Boolean).concat(auto.filter(h => !ord.includes(h.j))) : auto;
}
function renderSimClutch() {
  const box = $('simClutch'); if (!box || !SIM) return;
  const us = orderedSide(simUsTeam(), simSel.us, simOrder, true);
  const opp = orderedSide(simOppTeam(), simSel.opp, simOppOrder, false);
  if (us.length < 1 || opp.length < 1) { box.innerHTML = ''; return; }
  const away = !SIM.rozpis[simMatch].doma, usSide = away ? 'H' : 'D', oppSide = away ? 'D' : 'H';
  const posOrder = [4, 3, 2, 1], games = [18, 17, 16, 15];  // order[i] -> pos posOrder[i] -> rozhodujici hra games[i]
  let rows = '';
  for (let i = 0; i < 4; i++) {
    const u = us[i], o = opp[i];
    if (!u && !o) continue;
    const wp = (u && o) ? Math.round(simWp(effR(u), effR(o)) * 100) : null;
    const wpc = wp == null ? '' : wp >= 55 ? 'cl-w' : wp <= 45 ? 'cl-l' : 'cl-t';
    const up = i > 0 ? `<button class="cl-mv" data-i="${i}" data-d="up">▲</button>` : '';
    const dn = i < Math.min(3, opp.length - 1) ? `<button class="cl-mv" data-i="${i}" data-d="dn">▼</button>` : '';
    rows += `<tr><td class="cl-g">hra ${games[i]}<br><span class="cl-pp">${usSide}${posOrder[i]}·${oppSide}${posOrder[i]}</span></td>
      <td class="cl-us">${u ? escH(simShort(u.j)) + ` <span class="cl-r">${effR(u)}</span>` : '–'}</td>
      <td class="cl-vs ${wpc}">${wp != null ? wp + '%' : ''}</td>
      <td class="cl-opp">${o ? escH(simShort(o.j)) + ` <span class="cl-r">${effR(o)}</span>` : '–'} <span class="cl-mvs">${up}${dn}</span></td></tr>`;
  }
  const subs = us.slice(4).filter(Boolean);
  const worst = [];
  for (let i = 0; i < 4; i++) { const u = us[i], o = opp[i]; if (u && o) worst.push({ g: [18, 17, 16, 15][i], p: Math.round(simWp(effR(u), effR(o)) * 100) }); }
  const wg = worst.filter(x => x.p < 45).sort((a, b) => a.p - b.p)[0];
  const subNote = `<div class="sub-note">💡 <b>Legální trik „silní na konec" (pravidla I.19-21):</b> odhalení sestav je simultánní (nereaguješ předem), ale během zápasu smíš hráče <b>vystřídat</b> dovnitř na pozdější singly jeho pozice — až uvidíš jejich sestavu na kříži. Cíl: dostat našeho silného proti jejich slabšímu v rozhodující hře. Vystřídaný se vrací jen na svou pozici.${wg ? ` <b>Dnes:</b> hra ${wg.g} je nevýhodná (${wg.p} %) — tam zvaž střídání, až uvidíš, koho postaví.` : ''}${subs.length ? ` Náhradníci: ${subs.map(s => simShort(s.j)).join(', ')}.` : ''}</div>`;
  box.innerHTML = `<div class="sim-eyebrow" style="margin-top:14px">🔑 Rozhodující souboje (pozdní hry 15-18)</div>
    <p class="hint" style="margin:2px 0 6px">Naše pozice vs jejich pozice v rozhodujících hrách (% = šance našeho). Soupeře řadím dle síly na jejich rozhodující pozice; <b>▲▼ u soupeře</b> přehodíš, když znáš/odhadneš jejich sestavu.</p>
    <table class="cl-tbl"><thead><tr><th>Hra</th><th>My</th><th>%</th><th>Soupeř</th></tr></thead><tbody>${rows}</tbody></table>
    ${subNote}`;
  box.querySelectorAll('.cl-mv').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, j = b.dataset.d === 'up' ? i - 1 : i + 1;
    const arr = opp.map(h => h.j);[arr[i], arr[j]] = [arr[j], arr[i]];
    simOppOrder = arr; renderSim();
  });
}
function renderSim() {
  if (!SIM) return;
  renderSimChips(); renderSimLineups(); renderSimOppProfile(); renderSimOppLineup(); renderSimRec(); renderSimClutch(); renderSimGrid(); renderSimPred(); renderSimDoubles();
}

// ===== ARCHIV SESTAV (ulozeni F3 sestavy + vysledek zapasu, localStorage) =====
const ARCHIV_KEY = '7rota-archiv';
function loadArchiv() { try { return JSON.parse(localStorage.getItem(ARCHIV_KEY) || '[]'); } catch { return []; } }
function saveArchiv(a) { try { localStorage.setItem(ARCHIV_KEY, JSON.stringify(a)); } catch { } }
function saveLineup() {
  if (!SIM) return;
  const m = SIM.rozpis[simMatch];
  const avail = simRated(simUsTeam()).filter(h => simSel.us.has(h.j));
  const auto = avail.slice().sort((a, b) => tacScore(b) - tacScore(a));
  const order = simOrder ? simOrder.map(j => avail.find(h => h.j === j)).filter(Boolean).concat(auto.filter(h => !simOrder.includes(h.j))) : auto;
  const away = !m.doma, side = away ? 'H' : 'D', posOrder = [4, 3, 2, 1];
  const lineup = order.map((h, i) => { const core = i < 4; return { pos: side + (core ? posOrder[i] : i + 1), jmeno: h.j, rating: effR(h), core }; });
  const arr = loadArchiv();
  arr.unshift({ id: Date.now(), date: m.datum || m.dt, souper: m.souper || m.s, doma: m.doma, tactic: simTactic, lineup, saved_at: new Date().toISOString(), result: null });
  saveArchiv(arr);
  const btn = $('simSaveBtn'); if (btn) { btn.textContent = '✓ Uloženo do archivu'; btn.disabled = true; setTimeout(renderSimRec, 1600); }
}
// ── Sdileni sestavy (A) + export/import archivu (D) ──────────────────────────
const DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
function denZData(d) {                       // "20.9.2026" -> "Ne"
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(('' + d).trim());
  if (!m) return '';
  const dt = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(dt) ? '' : DNY[dt.getDay()];
}

// Rozhodujici hra pozice = posledni z jejiho rozpisu (vzdy 15-18, viz PRAVIDLA_LIGA.md)
function hraProPozici(pos) {
  const m = /^([DH])(\d)$/.exec(pos || '');
  if (!m) return null;
  const tab = m[1] === 'D' ? POS_GAMES_D : POS_GAMES_H;
  const g = tab[+m[2]];
  return g ? g[g.length - 1] : null;
}

function lineupText(a) {
  const den = denZData(a.date);
  const L = [`Sedmá rota — ${den ? den + ' ' : ''}${a.date} ${a.doma ? 'DOMA' : 'VENKU'} vs ${a.souper}`];
  L.push(`Taktika: ${(TACTICS[a.tactic] || {}).nm || a.tactic}`, '');
  const zaklad = a.lineup.filter(p => p.core), nahr = a.lineup.filter(p => !p.core);
  const w = Math.max(...a.lineup.map(p => p.jmeno.length));
  zaklad.forEach(p => {
    const h = hraProPozici(p.pos);
    L.push(`${p.pos}  ${p.jmeno.padEnd(w)}${h ? '  → hra ' + h : ''}`);
  });
  if (nahr.length) {
    L.push('── náhradníci ──');
    nahr.forEach(p => L.push(`${p.pos}  ${p.jmeno}`));
  }
  if (a.result && a.result.vysledek) {
    const v = { V: 'Výhra', P: 'Prohra', R: 'Remíza' }[a.result.vysledek] || a.result.vysledek;
    L.push('', `Výsledek: ${v}${a.result.skore ? ' ' + a.result.skore : ''}${a.result.poznamka ? ' · ' + a.result.poznamka : ''}`);
  }
  return L.join('\n');
}

async function shareLineup(a, btn) {
  const text = lineupText(a);
  const title = `Sestava vs ${a.souper} (${a.date})`;
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {                                       // fallback: schranka (desktop, starsi prohlizece)
    await navigator.clipboard.writeText(text);
    if (btn) { const o = btn.textContent; btn.textContent = '✓ zkopírováno'; setTimeout(() => btn.textContent = o, 1600); }
  } catch { alert(text); }                    // posledni zachrana: aspon to ukaz
}

const ARCHIV_FILE = () => `7rota-archiv-${new Date().toISOString().slice(0, 10)}.json`;

async function exportArchiv() {
  const arr = loadArchiv();
  if (!arr.length) { alert('Archiv je prázdný — není co zálohovat.'); return; }
  const blob = new Blob([JSON.stringify({ app: '7rota', exported: new Date().toISOString(), archiv: arr }, null, 1)],
    { type: 'application/json' });
  const file = new File([blob], ARCHIV_FILE(), { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ title: 'Záloha archivu sestav', files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');       // fallback: stazeni
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Slucuje podle id — opakovany import stejne zalohy nic nezduplikuje.
function importArchiv(file) {
  const rd = new FileReader();
  rd.onload = () => {
    let vni;
    try { vni = JSON.parse(rd.result); } catch { alert('Soubor nejde přečíst — není to JSON záloha.'); return; }
    const nove = Array.isArray(vni) ? vni : (vni && vni.archiv);
    if (!Array.isArray(nove)) { alert('V souboru není archiv sestav.'); return; }
    const stare = loadArchiv(), znam = new Set(stare.map(x => String(x.id)));
    const pridat = nove.filter(x => x && x.id && x.lineup && !znam.has(String(x.id)));
    if (!pridat.length) { alert(`Nic nového — všechny záznamy (${nove.length}) už v archivu jsou.`); return; }
    const spoj = stare.concat(pridat).sort((x, y) => (y.id || 0) - (x.id || 0));
    saveArchiv(spoj);
    alert(`Načteno ${pridat.length} z ${nove.length} záznamů (zbytek už tu byl).`);
    renderArchiv();
  };
  rd.readAsText(file);
}

function renderArchiv() {
  const box = $('archivList'); if (!box) return;
  const exp = $('archExport'), imp = $('archImport'), impF = $('archImportFile');
  if (exp) exp.onclick = exportArchiv;
  if (imp && impF) { imp.onclick = () => impF.click(); impF.onchange = () => { if (impF.files[0]) importArchiv(impF.files[0]); impF.value = ''; }; }
  const arr = loadArchiv();
  if (!arr.length) { box.innerHTML = '<p class="hint">Zatím nic uloženého. V Simulátoru → Doporučená sestava dej „💾 Uložit sestavu", a po zápase sem zadáš výsledek.</p>'; return; }
  const stat = {};
  arr.forEach(a => { if (a.result && a.result.vysledek) { const t = a.tactic; (stat[t] = stat[t] || { V: 0, P: 0, R: 0 })[a.result.vysledek]++; } });
  let statHtml = Object.entries(stat).map(([t, s]) => {
    const n = s.V + s.P + s.R; return `<span class="arch-stat">${(TACTICS[t] || {}).nm || t}: ${s.V}–${s.P}${s.R ? '–' + s.R : ''} <b>${Math.round(s.V / n * 100)}%</b></span>`;
  }).join('');
  const short = (n) => ('' + n).split(' ')[0];
  const rows = arr.map(a => {
    const r = a.result;
    const lu = a.lineup.map(p => `<span class="${p.core ? 'arch-core' : 'arch-sub'}">${p.pos} ${escH(short(p.jmeno))}</span>`).join(' ');
    const res = r ? `<div class="arch-res ${r.vysledek === 'V' ? 'w' : r.vysledek === 'P' ? 'l' : 't'}"><b>${r.vysledek === 'V' ? '✅ Výhra' : r.vysledek === 'P' ? '❌ Prohra' : '➖ Remíza'}</b>${r.skore ? ' ' + escH(r.skore) : ''}${r.poznamka ? ' · ' + escH(r.poznamka) : ''} <button class="arch-clr" data-id="${a.id}">upravit</button></div>`
      : `<div class="arch-entry">Výsledek: <button class="arch-rbtn" data-id="${a.id}" data-r="V">✅ Výhra</button><button class="arch-rbtn" data-id="${a.id}" data-r="P">❌ Prohra</button><button class="arch-rbtn" data-id="${a.id}" data-r="R">➖ Remíza</button></div>`;
    return `<div class="arch-item"><div class="arch-head"><b>${escH(a.souper)}</b> <span class="hint2">${a.date} · ${a.doma ? 'doma' : 'venku'} · ${(TACTICS[a.tactic] || {}).nm || a.tactic}</span><button class="arch-share" data-id="${a.id}">📤 Sdílet</button><button class="arch-del" data-id="${a.id}">✕</button></div>
      <div class="arch-lu">${lu}</div>${res}</div>`;
  }).join('');
  box.innerHTML = (statHtml ? `<div class="arch-stats"><span class="hint2">Úspěšnost taktik:</span> ${statHtml}</div>` : '') + rows;
  box.querySelectorAll('.arch-rbtn').forEach(b => b.onclick = () => {
    const skore = prompt('Skóre (např. 10:8) — nepovinné:') || '';
    const poznamka = prompt('Poznámka (nepovinné):') || '';
    const a = loadArchiv(), it = a.find(x => x.id == b.dataset.id);
    if (it) { it.result = { vysledek: b.dataset.r, skore: skore.trim(), poznamka: poznamka.trim() }; saveArchiv(a); renderArchiv(); }
  });
  box.querySelectorAll('.arch-clr').forEach(b => b.onclick = () => {
    const a = loadArchiv(), it = a.find(x => x.id == b.dataset.id);
    if (it) { it.result = null; saveArchiv(a); renderArchiv(); }
  });
  box.querySelectorAll('.arch-share').forEach(b => b.onclick = () => {
    const a = loadArchiv().find(x => x.id == b.dataset.id);
    if (a) shareLineup(a, b);
  });
  box.querySelectorAll('.arch-del').forEach(b => b.onclick = () => {
    if (!confirm('Smazat tento záznam z archivu?')) return;
    saveArchiv(loadArchiv().filter(x => x.id != b.dataset.id)); renderArchiv();
  });
}

async function init() {
  DATA = await (await fetch('players.json', { cache: 'no-store' })).json();
  LIGA_INDEX = await fetch('liga_index.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  TEAM_HISTORY = await fetch('team_history.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  SCOUT = await fetch('scout.json').then(r => r.ok ? r.json() : null).catch(() => null);
  SIM = await fetch('sim_data.json').then(r => r.ok ? r.json() : null).catch(() => null);
  OPP_POS = await fetch('opp_positioning.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  if (SIM && SIM.wT_default != null) simWT = SIM.wT_default;
  params = loadParams(); overrides = loadOverrides();
  $('meta').textContent = `${DATA.players.length} hráčů · A-tým ${DATA.a_team_size}`;
  syncControls(); bind(); bindSearch(); render(); renderCandidates();
  if (SIM) { simInitSel(); renderSim(); }
  // deep-link: ?p=<jmeno> otevre profil (pro sdilene odkazy)
  const pq = new URLSearchParams(location.search).get('p');
  if (pq && LAST[pq]) openDetail(pq);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; location.reload(); }   // nový SW převzal -> načti nejnovější
    });
  }
}
init();
