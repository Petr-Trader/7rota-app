'use strict';
// Sedmá rota — interaktivní žebříček.
// z-skóre = (hodnota − průměr) / výběrová směrodatná odchylka (STDEV, n-1),
//   na LKH se počítá z hodnoty PO ligové korekci.
// spolehlivost LKH = √(min(legy/Lref, 1)) — sráží LKH málo prokázaných hráčů.
// vážené skóre = Σ(váha·z[·spolehlivost u LKH]) / Σ(vah přítomných metrik).
// návrh A = pořadí ≤ velikost A-týmu; ruční zámek přebíjí; vyřazený mimo.

const METRICS = ['lkh', 'bt', 'turnaje'];
const LS_PARAMS = '7rota_params';
const LS_OVR = '7rota_overrides';

let DATA = null, params = null, overrides = {};
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
  const ps = DATA.players;
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
    const badge = p.team ? `<span class="badge ${p.team.toLowerCase()}">${p.team}</span>` : '—';
    const jl = p.jenLiga ? ' <span class="tag jl">jen liga</span>' : '';
    const total = (DATA.liga_zapasu && DATA.liga_zapasu[p.tym]) || 24;
    const doch = p.utkani != null
      ? ` <span class="tag doch" title="na soupisce ${p.utkani}/${total}, reálně hrál ${p.hral}×">📋 ${p.utkani}/${total}</span>` : '';
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
}

function renderLigaInputs() {
  const box = $('ligaBox'); box.style.display = params.ligaOn ? '' : 'none';
  const popis = DATA.liga_popis || {}; box.innerHTML = '';
  for (const k of Object.keys(params.ligaKor || {})) {
    const w = document.createElement('label'); w.className = 'liga-item';
    w.innerHTML = `<span>${popis[k] || k}</span><input type="number" step="0.01" min="0" data-k="${k}" value="${params.ligaKor[k]}">`;
    box.appendChild(w);
  }
  box.querySelectorAll('input').forEach(inp => inp.onchange = e => {
    params.ligaKor[e.target.dataset.k] = +e.target.value || 0; saveParams(); render(); });
}

function syncControls() {
  $('wLkh').value = params.wLkh; $('wBt').value = params.wBt; $('wTurn').value = params.wTurn;
  $('wLkhOut').textContent = (+params.wLkh).toFixed(2);
  $('wBtOut').textContent = (+params.wBt).toFixed(2);
  $('wTurnOut').textContent = (+params.wTurn).toFixed(2);
  $('aSize').value = params.aSize;
  $('ligaOn').checked = params.ligaOn;
  $('relOn').checked = params.relOn; $('lref').value = params.lref;
  renderLigaInputs();
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
  });
}

async function init() {
  DATA = await (await fetch('players.json', { cache: 'no-store' })).json();
  params = loadParams(); overrides = loadOverrides();
  $('meta').textContent = `${DATA.players.length} hráčů · A-tým ${DATA.a_team_size}`;
  syncControls(); bind(); render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
