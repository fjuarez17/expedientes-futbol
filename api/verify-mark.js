const L = require('./_lib');
const W = require('./_wm');

// Servidor de pruebas de marcas: evalúa el payload contra la base de prueba y responde con el código HTTP.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'POST' });
  let body; try { body = await L.readBody(req); } catch { return L.send(res, 400, { error: 'JSON inválido' }); }
  const r = W.verifyPayload(body && body.payload, { matchId: body && body.matchId });
  return L.send(res, r.status, { ...r, base: 'prueba', checkedAt: new Date().toISOString() });
};
