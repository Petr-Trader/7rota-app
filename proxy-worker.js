// Cloudflare Worker — bezpečný proxy USO pro 7rota appku + záloha archivu sestav.
// Obchází CORS (statická PWA nesmí volat USO napřímo). ZAMČENO:
//  - proxuje JEN domény USO (turnaje.org / sipky.org), nic jiného,
//  - CORS povolen JEN pro naši appku (GitHub Pages origin).
// Tím nejde zneužít jako otevřený proxy. USO je veřejné, tokeny na proxy netřeba.
//
// NOVÉ (2026-09-20): POST /archiv-backup uloží archiv sestav do PRIVÁTNÍHO repa
// Petr-Trader/7-rota (soubor input/historie/archiv_sestav_latest.json).
//  - vyžaduje hlavičku X-Backup-Key = secret BACKUP_KEY (klíč zadáš jednou v appce,
//    NENÍ ve veřejném kódu appky),
//  - zapisuje jen do JEDNOHO souboru v jednom repu (i při úniku klíče nejde o víc),
//  - limit 256 kB, tělo musí být záloha z appky ({"app":"7rota","archiv":[…]}).
//
// Nasazení (mobil): cloudflare.com → Workers & Pages → tento worker → Edit code →
// vlož tento kód → Deploy. Pak Settings → Variables and Secrets → přidat SECRETy:
//   GH_TOKEN   = GitHub fine-grained token (repo Petr-Trader/7-rota, Contents: Read and write)
//   BACKUP_KEY = libovolné heslo (stejné zadáš v appce: Archiv sestav → ☁️ Záloha do cloudu)
// Postup krok za krokem: 7rota/docs/RUNBOOK_ZALOHA_ARCHIVU.md
// Použití z appky: https://<worker>.workers.dev/?url=<encoded USO url>

const ALLOWED_HOSTS = ['turnaje.org', 'www.sipky.org', 'sipky.org'];
const ALLOWED_ORIGIN = 'https://petr-trader.github.io';
const BACKUP_REPO = 'Petr-Trader/7-rota';
const BACKUP_PATH = 'input/historie/archiv_sestav_latest.json';
const BACKUP_MAX_BYTES = 256 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Backup-Key',
};

// base64 z UTF-8 textu (btoa umi jen byty)
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function zalohaArchivu(request, env) {
  if (!env.GH_TOKEN || !env.BACKUP_KEY)
    return new Response('backup neni nastaven (chybi GH_TOKEN / BACKUP_KEY)', { status: 503, headers: CORS });
  if (request.headers.get('X-Backup-Key') !== env.BACKUP_KEY)
    return new Response('spatny klic', { status: 401, headers: CORS });

  const body = await request.text();
  if (body.length > BACKUP_MAX_BYTES)
    return new Response('prilis velke', { status: 413, headers: CORS });
  let data;
  try { data = JSON.parse(body); } catch { return new Response('neni JSON', { status: 400, headers: CORS }); }
  if (!data || data.app !== '7rota' || !Array.isArray(data.archiv))
    return new Response('neni zaloha archivu', { status: 400, headers: CORS });

  const api = `https://api.github.com/repos/${BACKUP_REPO}/contents/${BACKUP_PATH}`;
  const gh = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': '7rota-backup-worker',
  };
  // sha stavajiciho souboru (kdyz uz existuje) — GitHub ho vyzaduje pri prepisu
  let sha;
  const cur = await fetch(api, { headers: gh });
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status !== 404) return new Response(`github ${cur.status}`, { status: 502, headers: CORS });

  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...gh, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `data(archiv): zaloha z appky (${data.archiv.length} sestav)`,
      content: b64(body),
      sha,
    }),
  });
  if (!put.ok) return new Response(`github zapis ${put.status}`, { status: 502, headers: CORS });
  return new Response(JSON.stringify({ ok: true, sestav: data.archiv.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/archiv-backup') {
      if (request.method !== 'POST') return new Response('jen POST', { status: 405, headers: CORS });
      return zalohaArchivu(request, env);
    }

    const target = url.searchParams.get('url');
    if (!target) return new Response('missing url', { status: 400, headers: CORS });

    let t;
    try { t = new URL(target); } catch { return new Response('bad url', { status: 400, headers: CORS }); }
    if (!ALLOWED_HOSTS.includes(t.hostname))
      return new Response('host not allowed', { status: 403, headers: CORS });

    const resp = await fetch(t.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'text/plain' },
    });
  },
};
