const L = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'POST' });
  let body; try { body = await L.readBody(req); } catch { return L.send(res, 400, { error: 'JSON inválido' }); }
  let u; try { u = new URL(body.webhook); } catch { return L.send(res, 400, { error: 'webhook inválido' }); }
  if (u.protocol !== 'https:') return L.send(res, 400, { error: 'El webhook debe ser https' });
  const r = await L.resolve(u.hostname);
  const ips = [...r.a, ...r.aaaa];
  if (!ips.length || ips.some(L.isPrivateIP)) return L.send(res, 400, { error: 'Host del webhook no permitido' });
  try {
    const out = await L.fetchT(u.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.payload || {}) }, 8000);
    return L.send(res, 200, { ok: out.ok, status: out.status, sentAt: new Date().toISOString() });
  } catch (e) {
    return L.send(res, 502, { error: 'El webhook no respondió' });
  }
};
