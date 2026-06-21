'use strict';
// Sedmá rota — interaktivní žebříček (logika 1:1 s Master.xlsx).
// z-skóre = (val - průměr) / výběrová směrodatná odchylka (STDEV, n-1).
// vážené skóre = Σ(váha·z přítomných metrik) / Σ(vah přítomných metrik).
// V hře = má skóre a není vyřazen. Návrh A = pořadí ≤ velikost A-týmu (zámek přebíjí).

const METRICS = ['lkh', 'bt', 'turnaje'];
const LS_PARAMS = '7rota_params';
const LS_OVR = '7rota_overrides';

let DATA = null;
let params = null;             // {wLkh,wBt,wTurn,aSize}
let overrides = {};            // jmeno -> {lock:'A'|'B'|null, excluded:bool}

const $ = (id) => document.getElementById(id);

function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function stdev(a){ // výběrová (n-1), jako Excel STDEV
  if(a.length<2) return 0;
  const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
}

function loadParams(){
  const def = {wLkh:DATA.weights_default.lkh, wBt:DATA.weights_default.bt,
               wTurn:DATA.weights_default.turnaje, aSize:DATA.a_team_size};
  try{ const s=JSON.parse(localStorage.getItem(LS_PARAMS)); return s? {...def,...s}:def; }
  catch{ return def; }
}
function saveParams(){ localStorage.setItem(LS_PARAMS, JSON.stringify(params)); }
function loadOverrides(){ try{ return JSON.parse(localStorage.getItem(LS_OVR))||{}; }catch{ return {}; } }
function saveOverrides(){ localStorage.setItem(LS_OVR, JSON.stringify(overrides)); }
function ovr(name){ return overrides[name] || (overrides[name]={lock:null,excluded:false}); }

function compute(){
  const ps = DATA.players;
  // z-skóre baseline = všichni hráči s danou metrikou (jako pevný rozsah v Excelu)
  const z = {};
  for(const m of METRICS){
    const vals = ps.filter(p=>p[m]!=null).map(p=>p[m]);
    const mu=vals.length?mean(vals):0, sd=stdev(vals);
    z[m] = {};
    for(const p of ps) z[m][p.jmeno] = (p[m]!=null && sd>0) ? (p[m]-mu)/sd : null;
  }
  const W = {lkh:params.wLkh, bt:params.wBt, turnaje:params.wTurn};
  const out = ps.map(p=>{
    let num=0, den=0;
    for(const m of METRICS){
      const zz=z[m][p.jmeno];
      if(zz!=null){ num+=W[m]*zz; den+=W[m]; }
    }
    const score = den>0 ? num/den : null;
    const o = ovr(p.jmeno);
    const inPlay = score!=null && !o.excluded;
    return {...p, score, inPlay, lock:o.lock, excluded:o.excluded,
            zlkh:z.lkh[p.jmeno], zbt:z.bt[p.jmeno], zturn:z.turnaje[p.jmeno]};
  });
  // pořadí mezi hráči v hře
  const ranked = out.filter(p=>p.inPlay).sort((a,b)=>b.score-a.score);
  ranked.forEach((p,i)=>{ p.rank=i+1; });
  // návrh týmu: zámek přebíjí, jinak pořadí ≤ velikost A-týmu
  for(const p of out){
    if(p.excluded){ p.team=null; continue; }
    if(p.lock){ p.team=p.lock; continue; }
    p.team = (p.rank && p.rank<=params.aSize) ? 'A' : 'B';
  }
  // řazení pro zobrazení: v hře dle skóre, vyřazení dolů
  out.sort((a,b)=>{
    if(a.inPlay!==b.inPlay) return a.inPlay?-1:1;
    if(a.score==null) return 1; if(b.score==null) return -1;
    return b.score-a.score;
  });
  return out;
}

function fmt(v,d=1){ return v==null?'<span class="na">—</span>':(+v).toFixed(d); }

function render(){
  const rows = compute();
  const tb = $('rows'); tb.innerHTML='';
  for(const p of rows){
    const tr=document.createElement('tr');
    if(p.excluded) tr.className='dim';
    if(p.lock) tr.classList.add('locked');
    const badge = p.team ? `<span class="badge ${p.team.toLowerCase()}">${p.team}</span>` : '—';
    tr.innerHTML = `
      <td>${p.rank||''}</td>
      <td class="l name">${p.jmeno}</td>
      <td>${badge}</td>
      <td class="score">${p.score==null?'—':p.score.toFixed(2)}</td>
      <td>${fmt(p.lkh,1)}</td>
      <td>${p.turnaje==null?'<span class="na">—</span>':p.turnaje}</td>
      <td>${fmt(p.bt,2)}</td>
      <td><select class="lock" data-n="${p.jmeno}">
        <option value=""${!p.lock?' selected':''}>—</option>
        <option value="A"${p.lock==='A'?' selected':''}>A</option>
        <option value="B"${p.lock==='B'?' selected':''}>B</option>
      </select></td>
      <td><span class="xbtn${p.excluded?' on':''}" data-n="${p.jmeno}">✕</span></td>`;
    tb.appendChild(tr);
  }
  // ovladace zamku
  tb.querySelectorAll('select.lock').forEach(s=>s.onchange=e=>{
    ovr(e.target.dataset.n).lock = e.target.value||null; saveOverrides(); render();
  });
  tb.querySelectorAll('.xbtn').forEach(x=>x.onclick=e=>{
    const o=ovr(e.target.dataset.n); o.excluded=!o.excluded; saveOverrides(); render();
  });
}

function syncControls(){
  $('wLkh').value=params.wLkh; $('wBt').value=params.wBt; $('wTurn').value=params.wTurn;
  $('wLkhOut').textContent=(+params.wLkh).toFixed(2);
  $('wBtOut').textContent=(+params.wBt).toFixed(2);
  $('wTurnOut').textContent=(+params.wTurn).toFixed(2);
  $('aSize').value=params.aSize;
}

function bind(){
  const upd=(k,el,out)=>{ params[k]=+el.value; if(out) $(out).textContent=(+el.value).toFixed(2);
    saveParams(); render(); };
  $('wLkh').oninput=e=>upd('wLkh',e.target,'wLkhOut');
  $('wBt').oninput=e=>upd('wBt',e.target,'wBtOut');
  $('wTurn').oninput=e=>upd('wTurn',e.target,'wTurnOut');
  $('aSize').onchange=e=>{ params.aSize=Math.max(1,+e.target.value||1); saveParams(); syncControls(); render(); };
  $('reset').onclick=()=>{ params={wLkh:DATA.weights_default.lkh,wBt:DATA.weights_default.bt,
    wTurn:DATA.weights_default.turnaje,aSize:DATA.a_team_size}; saveParams(); syncControls(); render(); };
  $('toggleCtl').onclick=()=>{ const b=$('ctlBody'); const h=b.style.display==='none';
    b.style.display=h?'':'none'; $('toggleCtl').textContent=h?'skrýt':'zobrazit'; };
}

async function init(){
  DATA = await (await fetch('players.json',{cache:'no-store'})).json();
  params = loadParams();
  overrides = loadOverrides();
  $('meta').textContent = `${DATA.players.length} hráčů · A-tým ${DATA.a_team_size} · živý přepočet`;
  syncControls(); bind(); render();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}
init();
