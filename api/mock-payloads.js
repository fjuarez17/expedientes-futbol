const L = require('./_lib');
const W = require('./_wm');

// Emisor mock: payloads simulados del detector forense, con el código HTTP que debería devolver /api/verify-mark.
module.exports = async (req, res) => {
  const q = req.query || {};
  const kinds = q.kind ? String(q.kind).split(',').filter((k) => W.KINDS.includes(k)) : W.KINDS;
  if (!kinds.length) return L.send(res, 400, { error: 'kind debe ser uno de: ' + W.KINDS.join(', ') });
  const n = Math.min(50, Math.max(1, +q.n || kinds.length));
  const payloads = Array.from({ length: n }, (_, i) => W.mockPayload(kinds[i % kinds.length]));
  return L.send(res, 200, { base: { matches: W.TEST_DB.matches, licensees: W.TEST_DB.licensees, marks: W.TEST_DB.marks }, payloads });
};
