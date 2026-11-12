const L = require('./_lib');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CH = 'https://check-host.net';

module.exports = async (req, res) => {
  const url = String((req.query && req.query.url) || '');
  let u; try { u = new URL(url); } catch { return L.send(res, 400, { error: 'URL inválida' }); }
  if (!/^https?:$/.test(u.protocol)) return L.send(res, 400, { error: 'Solo http/https' });
  const nodes = Math.min(6, Math.max(2, Number(req.query.nodes) || 4));
  try {
    const start = await L.fetchT(`${CH}/check-http?host=${encodeURIComponent(u.href)}&max_nodes=${nodes}`, { headers: { Accept: 'application/json' } }, 9000).then(r => r.json());
    if (!start || !start.request_id) return L.send(res, 502, { error: 'check-host no respondió' });
    const meta = start.nodes || {};
    let result = {};
    for (let i = 0; i < 8; i++) {
      await sleep(2500);
      result = await L.fetchT(`${CH}/check-result/${start.request_id}`, { headers: { Accept: 'application/json' } }, 6000).then(r => r.json()).catch(() => ({}));
      if (Object.keys(meta).every(k => result[k] != null)) break;
    }
    const points = Object.entries(meta).map(([node, m]) => {
      const r = result[node] && result[node][0];
      const status = r && r[3] ? Number(r[3]) : null;
      return { node, country: m[1], countryCode: m[0], city: m[2], nodeIp: m[3], nodeAsn: m[4], ok: !!(r && r[0] === 1 && status && status < 400), status, message: r ? r[2] : 'sin respuesta', seconds: r ? r[1] : null, resolvedIp: r ? r[4] || null : null };
    });
    const report = { url: u.href, checkedAt: new Date().toISOString(), service: 'check-host.net', permalink: start.permanent_link || null, points };
    report.okPoints = points.filter(p => p.ok).length;
    report.distinct = new Set(points.filter(p => p.ok).map(p => p.countryCode + '|' + p.nodeAsn)).size;
    report.sha256 = L.sha256(JSON.stringify(report));
    return L.send(res, 200, report);
  } catch (e) {
    return L.send(res, 500, { error: 'Falló la verificación multipunto', detail: String(e && e.message || e).slice(0, 200) });
  }
};
