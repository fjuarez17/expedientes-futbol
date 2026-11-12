const crypto = require('crypto');
const L = require('./_lib');

function len(n) {
  if (n < 128) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...p) => tlv(0x30, Buffer.concat(p));

function buildReq(hashHex) {
  const oidSha256 = Buffer.from('0609608648016503040201', 'hex');
  const algo = seq(oidSha256, Buffer.from([0x05, 0x00]));
  const imprint = seq(algo, tlv(0x04, Buffer.from(hashHex, 'hex')));
  const nonce = crypto.randomBytes(8); nonce[0] &= 0x7f;
  return { der: seq(tlv(0x02, Buffer.from([1])), imprint, tlv(0x02, nonce), Buffer.from([0x01, 0x01, 0xff])), nonce: nonce.toString('hex') };
}

function genTime(buf) {
  for (let i = 0; i < buf.length - 16; i++) {
    if (buf[i] === 0x18 && buf[i + 1] >= 15 && buf[i + 1] <= 23) {
      const s = buf.subarray(i + 2, i + 2 + buf[i + 1]).toString('latin1');
      const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ''}Z`;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return L.send(res, 204, {});
  try {
    const body = await L.readBody(req);
    const hash = String(body.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return L.send(res, 400, { error: 'sha256 inválido' });
    const { der, nonce } = buildReq(hash);
    const r = await L.fetchT('https://freetsa.org/tsr', { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: der }, 12000);
    const tsr = Buffer.from(await r.arrayBuffer());
    if (!r.ok || tsr.length < 100) return L.send(res, 502, { error: 'La TSA no respondió', status: r.status });
    const status = tsr[0] === 0x30 ? tsr.indexOf(Buffer.from([0x02, 0x01, 0x00])) >= 0 && tsr.indexOf(Buffer.from([0x02, 0x01, 0x00])) < 12 ? 'granted' : 'revisar' : 'error';
    return L.send(res, 200, {
      tsa: 'FreeTSA (freetsa.org) — RFC 3161', sha256: hash, nonce, status,
      genTime: genTime(tsr), imprintPresent: tsr.indexOf(Buffer.from(hash, 'hex')) >= 0,
      tsr: tsr.toString('base64'), tsq: der.toString('base64'), serverTime: new Date().toISOString(),
    });
  } catch (e) {
    return L.send(res, 500, { error: 'Fallo el sellado', detail: String(e && e.message || e).slice(0, 200) });
  }
};
