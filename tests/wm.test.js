// Pruebas unitarias de la marca de agua y del servidor de pruebas: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const W = require('../api/_wm');
const verifyMark = require('../api/verify-mark');
const mockPayloads = require('../api/mock-payloads');

const VALID = W.TEST_DB.marks[0].payload;

test('el regex acepta el formato exacto y normaliza mayúsculas y espacios', () => {
  assert.match(VALID, W.RE);
  assert.ok(W.parsePayload(`  ${VALID.toLowerCase()} \n`).ok);
});

test('el regex rechaza variantes de formato', () => {
  const bad = [
    '', null, 42, VALID + '0', VALID.slice(1), 'XX' + VALID.slice(2), VALID.replace(/-/g, ''), VALID.replace(/-/g, '_'),
    'AR-1A2B3G-ESP-0F3E9A11-7C2D', 'AR-1A2B3C-ES1-0F3E9A11-7C2D', 'AR-1A2B3C-ESP-0F3E9A1-7C2D', 'AR-1A2B3C-ESP-0F3E9A11-7C2', `${VALID}\nAR-000000-ESP-00000000-0000`,
  ];
  for (const p of bad) assert.strictEqual(W.parsePayload(p).ok, false, String(p));
});

test('el dígito de control es el SHA-256 del resto, igual que en app.js', () => {
  const body = 'AR-' + crypto.createHash('sha256').update('match:test-boca-river').digest('hex').slice(0, 6).toUpperCase() + '-ESP-4F1C09A2';
  assert.strictEqual(W.makePayload('test-boca-river', 'ESP', '4f1c09a2'), body + '-' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 4).toUpperCase());
});

test('cambiar cualquier carácter hex del payload rompe el control (422)', () => {
  for (let i = 0; i < VALID.length; i++) {
    if (i < 3 || (i >= 10 && i <= 12) || !/[0-9A-F]/.test(VALID[i])) continue;
    const ch = VALID[i] === 'F' ? '0' : (parseInt(VALID[i], 16) + 1).toString(16).toUpperCase();
    const p = VALID.slice(0, i) + ch + VALID.slice(i + 1);
    assert.strictEqual(W.verifyPayload(p).status, 422, `posición ${i}: ${p}`);
  }
});

test('verifyPayload: 200 emitido, 403 no autorizado, 422 control, 400 formato', () => {
  assert.strictEqual(W.verifyPayload(VALID).status, 200);
  assert.strictEqual(W.verifyPayload(VALID, { matchId: W.TEST_DB.marks[0].matchId }).status, 200);
  assert.strictEqual(W.verifyPayload(VALID, { matchId: 'test-racing-independiente' }).status, 403);
  assert.strictEqual(W.verifyPayload(W.makePayload('test-boca-river', 'ESP', 'DEADBEEF')).status, 403);
  assert.strictEqual(W.verifyPayload(W.makePayload('test-boca-river', 'ZZZ', '4F1C09A2')).status, 403);
  assert.strictEqual(W.verifyPayload(W.makePayload('partido-inexistente', 'ESP', '4F1C09A2')).status, 403);
  assert.strictEqual(W.verifyPayload(VALID.slice(0, -1) + (VALID.endsWith('0') ? '1' : '0')).status, 422);
  assert.strictEqual(W.verifyPayload('AR-NO-VALE').status, 400);
});

test('cada tipo de payload simulado obtiene el código esperado', () => {
  for (let i = 0; i < 20; i++) for (const k of W.KINDS) {
    const m = W.mockPayload(k);
    assert.strictEqual(W.verifyPayload(m.payload, { matchId: m.matchId }).status, m.expected, `${k}: ${m.payload}`);
    assert.ok(m.detector.confidence >= 0.9 && m.detector.confidence <= 1);
  }
});

function call(handler, { method = 'POST', body, query } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, query, headers: { 'content-type': 'application/json' } });
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, json: JSON.parse(s) }); } };
    handler(req, res);
  });
}

test('POST /api/verify-mark responde con el código HTTP de cada caso', async () => {
  assert.strictEqual((await call(verifyMark, { body: { payload: VALID } })).status, 200);
  assert.strictEqual((await call(verifyMark, { body: { payload: W.makePayload('test-boca-river', 'ESP', '00000000') } })).status, 403);
  const r422 = await call(verifyMark, { body: { payload: W.mockPayload('adulterado').payload } });
  assert.strictEqual(r422.status, 422); assert.strictEqual(r422.json.code, 'control_invalido');
  assert.strictEqual((await call(verifyMark, { body: { payload: 'basura' } })).status, 400);
  assert.strictEqual((await call(verifyMark, { body: '{no json' })).status, 400);
  assert.strictEqual((await call(verifyMark, { method: 'GET' })).status, 405);
});

test('GET /api/mock-payloads emite payloads con la estructura del detector', async () => {
  const r = await call(mockPayloads, { method: 'GET', query: { n: '14' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.payloads.length, 14);
  for (const p of r.json.payloads) for (const k of ['kind', 'expected', 'matchId', 'payload', 'detector']) assert.ok(k in p, k);
  assert.strictEqual((await call(mockPayloads, { method: 'GET', query: { kind: 'nada' } })).status, 400);
});
