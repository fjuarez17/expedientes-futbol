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

const TSAS = [
  { id: 'freetsa', name: 'FreeTSA (freetsa.org)', url: 'https://freetsa.org/tsr', ms: 8000 },
  { id: 'sectigo', name: 'Sectigo', url: 'https://timestamp.sectigo.com', ms: 10000 },
];

function derAt(buf, i) {
  let n = buf[i + 1], off = i + 2;
  if (n & 0x80) { const k = n & 0x7f; n = 0; for (let j = 0; j < k; j++) n = n * 256 + buf[off + j]; off += k; }
  return { tag: buf[i], start: off, end: off + n };
}

// TimeStampResp ::= SEQUENCE { status PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }, timeStampToken OPTIONAL }
function pkiStatus(buf) {
  try {
    const resp = derAt(buf, 0); if (resp.tag !== 0x30) return null;
    const info = derAt(buf, resp.start); if (info.tag !== 0x30) return null;
    const st = derAt(buf, info.start); if (st.tag !== 0x02) return null;
    return buf[st.end - 1];
  } catch { return null; }
}

async function ask(tsa, der) {
  const r = await L.fetchT(tsa.url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: der }, tsa.ms);
  const tsr = Buffer.from(await r.arrayBuffer());
  if (!r.ok || tsr.length < 100) throw new Error(`HTTP ${r.status}`);
  const code = pkiStatus(tsr);
  if (code !== 0 && code !== 1) throw new Error(`PKIStatus ${code}`);
  return tsr;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return L.send(res, 204, {});
  try {
    const body = await L.readBody(req);
    const hash = String(body.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return L.send(res, 400, { error: 'sha256 inválido' });
    const tried = [];
    for (const tsa of TSAS) {
      const { der, nonce } = buildReq(hash);
      try {
        const tsr = await ask(tsa, der);
        const g = genTime(tsr), imprintPresent = tsr.indexOf(Buffer.from(hash, 'hex')) >= 0;
        if (!g || !imprintPresent) throw new Error('sello sin hora o sin el hash');
        return L.send(res, 200, {
          tsa: `${tsa.name} — RFC 3161`, tsaId: tsa.id, tsaUrl: tsa.url, sha256: hash, nonce, status: 'granted',
          genTime: g, imprintPresent, nonceOk: tsr.indexOf(Buffer.from(nonce, 'hex')) >= 0, tried,
          tsr: tsr.toString('base64'), tsq: der.toString('base64'), serverTime: new Date().toISOString(),
        });
      } catch (e) {
        tried.push(`${tsa.id}: ${String(e && e.name === 'AbortError' ? 'sin respuesta' : e && e.message || e).slice(0, 80)}`);
      }
    }
    return L.send(res, 502, { error: 'Ninguna TSA respondió', tried });
  } catch (e) {
    return L.send(res, 500, { error: 'Fallo el sellado', detail: String(e && e.message || e).slice(0, 200) });
  }
};
