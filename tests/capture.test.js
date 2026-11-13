const test = require('node:test');
const assert = require('node:assert');
const capture = require('../api/capture');

function call(query) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    capture({ method: 'GET', query }, res);
  });
}

test('captura: rechaza hosts privados o locales', async () => {
  for (const url of ['http://127.0.0.1', 'http://localhost:3000', 'http://10.0.0.1/x', 'http://[::1]/']) {
    const r = await call({ url });
    assert.strictEqual(r.status, 422, url);
  }
});

test('captura: rechaza URL inválida', async () => {
  const r = await call({ url: 'http://exa mple.com' });
  assert.strictEqual(r.status, 400);
});
