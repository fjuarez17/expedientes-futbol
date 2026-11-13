const L = require('./_lib');

// Captura automática: descarga la página tal como la entrega el servidor y devuelve los bytes con su SHA-256.
const MAX = 2000000;
const KEEP = ['server', 'via', 'x-cache', 'cf-ray', 'content-type', 'content-length', 'last-modified', 'date', 'x-powered-by', 'location'];

async function publicHost(host) {
  const r = await L.resolve(host);
  const ips = [...r.a, ...r.aaaa];
  return ips.length > 0 && !ips.some(L.isPrivateIP);
}

module.exports = async (req, res) => {
  const q = req.query || {};
  let url = String(q.url || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { url = new URL(url).href; } catch { return L.send(res, 400, { error: 'URL inválida' }); }
  const fetchedAt = new Date().toISOString();
  const hops = [];
  try {
    let r;
    for (let i = 0; i < 6; i++) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return L.send(res, 400, { error: 'Solo http/https', hops });
      if (!(await publicHost(u.hostname))) return L.send(res, 422, { error: 'El host no resuelve o es privado', hops });
      r = await L.fetchT(url, { redirect: 'manual', headers: { 'User-Agent': L.UA, Accept: 'text/html,*/*', 'Accept-Language': 'es-AR,es;q=0.9' } }, 10000);
      const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (!loc) break;
      hops.push({ url, status: r.status });
      url = new URL(loc, url).href;
      if (i === 5) return L.send(res, 422, { error: 'Demasiadas redirecciones', hops });
    }
    const chunks = []; let n = 0, truncated = false;
    for await (const ch of r.body) { chunks.push(ch); n += ch.length; if (n >= MAX) { truncated = true; break; } }
    const buf = Buffer.concat(chunks).subarray(0, MAX);
    const headers = {}; for (const k of KEEP) { const v = r.headers.get(k); if (v) headers[k] = v.slice(0, 200); }
    const title = (buf.toString('utf8').match(/<title[^>]*>([^<]{0,160})/i) || [])[1] || null;
    return L.send(res, 200, {
      url: q.url, finalUrl: url, status: r.status, fetchedAt, receivedAt: new Date().toISOString(), hops, headers,
      contentType: headers['content-type'] || null, title: title && title.trim(), bytes: buf.length, truncated,
      sha256: L.sha256(buf), b64: buf.toString('base64'), capturer: 'expedientes-futbol/captura (Vercel)',
    });
  } catch (e) {
    return L.send(res, 502, { error: e.name === 'AbortError' ? 'La página no respondió a tiempo' : 'La página no responde', hops });
  }
};
