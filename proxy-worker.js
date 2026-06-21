// Cloudflare Worker — bezpečný proxy USO pro 7rota appku.
// Obchází CORS (statická PWA nesmí volat USO napřímo). ZAMČENO:
//  - proxuje JEN domény USO (turnaje.org / sipky.org), nic jiného,
//  - CORS povolen JEN pro naši appku (GitHub Pages origin).
// Tím nejde zneužít jako otevřený proxy. Žádné tokeny/hesla (USO je veřejné).
//
// Nasazení (mobil): cloudflare.com → Workers & Pages → Create Worker →
// vlož tento kód → Deploy. URL workeru pak pošli Claudovi.
// Použití z appky: https://<worker>.workers.dev/?url=<encoded USO url>

const ALLOWED_HOSTS = ['turnaje.org', 'www.sipky.org', 'sipky.org'];
const ALLOWED_ORIGIN = 'https://petr-trader.github.io';

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing url', { status: 400, headers: cors });

    let t;
    try { t = new URL(target); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (!ALLOWED_HOSTS.includes(t.hostname))
      return new Response('host not allowed', { status: 403, headers: cors });

    const resp = await fetch(t.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: { ...cors, 'Content-Type': resp.headers.get('Content-Type') || 'text/plain' },
    });
  },
};
