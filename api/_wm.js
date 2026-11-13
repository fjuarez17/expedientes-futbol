// Marca de agua forense: formato, dígito de control, base de prueba y emisor de payloads simulados.
// Formato: AR-<PARTIDO 6 hex>-<LIC 3 letras>-<SESION 8 hex>-<CTRL 4 hex>; CTRL = primeros 4 hex de SHA-256 del resto.
const crypto = require('crypto');

const RE = /^AR-([0-9A-F]{6})-([A-Z]{3})-([0-9A-F]{8})-([0-9A-F]{4})$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const matchCode = (id) => sha('match:' + id).slice(0, 6).toUpperCase();
const ctrlOf = (body) => sha(body).slice(0, 4).toUpperCase();
const makePayload = (matchId, lic, session) => { const body = `AR-${matchCode(matchId)}-${lic}-${session.toUpperCase()}`; return `${body}-${ctrlOf(body)}`; };

function parsePayload(raw) {
  const p = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  const m = p.match(RE);
  if (!m) return { ok: false, payload: p };
  return { ok: true, payload: p, match: m[1], lic: m[2], session: m[3], ctrl: m[4], ctrlOk: ctrlOf(p.slice(0, -5)) === m[4] };
}

// Base de prueba: partidos, licenciatarios y marcas emitidas ficticias.
const TEST_DB = (() => {
  const matches = [
    { id: 'test-boca-river', name: 'Boca Juniors vs River Plate' },
    { id: 'test-racing-independiente', name: 'Racing Club vs Independiente' },
  ];
  const licensees = [{ code: 'ESP', name: 'ESPN Premium (Disney)' }, { code: 'TNT', name: 'TNT Sports' }, { code: 'DTV', name: 'DIRECTV / DGO' }, { code: 'FLW', name: 'Flow (Telecom)' }];
  const issued = [
    ['test-boca-river', 'ESP', '4F1C09A2', 'decodificador #4471'], ['test-boca-river', 'TNT', '0B7E55D1', 'app móvil · cuenta 88213'],
    ['test-racing-independiente', 'DTV', 'A19C33F0', 'set-top box #1029'], ['test-racing-independiente', 'FLW', '7D2E0C4B', 'Flow web · sesión 5521'],
  ];
  const marks = issued.map(([matchId, lic, session, note]) => ({ payload: makePayload(matchId, lic, session), matchId, lic, session, note }));
  return { matches, licensees, marks };
})();

// 400 formato inválido · 422 dígito de control que no coincide · 403 señal no autorizada en la base de prueba · 200 válido.
function verifyPayload(raw, opts = {}, db = TEST_DB) {
  const p = parsePayload(raw);
  const checks = [];
  if (!p.ok) return { status: 400, code: 'formato_invalido', payload: p.payload, checks: [{ ok: false, t: 'Formato inválido (esperado AR-XXXXXX-LIC-XXXXXXXX-XXXX).' }] };
  checks.push({ ok: p.ctrlOk, t: p.ctrlOk ? 'Dígito de control válido.' : 'Dígito de control inválido: lectura errónea o payload adulterado.' });
  if (!p.ctrlOk) return { status: 422, code: 'control_invalido', payload: p.payload, checks };
  const lic = db.licensees.find((l) => l.code === p.lic);
  checks.push({ ok: !!lic, t: lic ? `Licenciatario ${lic.name}.` : `Licenciatario ${p.lic} desconocido.` });
  const match = db.matches.find((m) => matchCode(m.id) === p.match);
  checks.push({ ok: !!match, t: match ? `Partido ${match.name}.` : `Código de partido ${p.match} desconocido.` });
  if (opts.matchId) { const same = matchCode(opts.matchId) === p.match; checks.push({ ok: same, t: same ? 'Corresponde al partido consultado.' : 'No corresponde al partido consultado.' }); }
  const mark = db.marks.find((k) => k.payload === p.payload);
  checks.push({ ok: !!mark, t: mark ? `Emitida en la sesión ${mark.session} · ${mark.note}.` : 'No figura en el registro de emisión de prueba.' });
  const ok = checks.every((c) => c.ok);
  return { status: ok ? 200 : 403, code: ok ? 'senal_oficial' : 'senal_no_autorizada', payload: p.payload, licensee: lic || null, match: match || null, mark: mark || null, checks };
}

// Emisor mock: payloads con la misma estructura que devuelve el detector forense, y el código HTTP esperado.
const KINDS = ['valido', 'adulterado', 'control_alterado', 'no_emitido', 'lic_desconocido', 'otro_partido', 'malformado'];
function mockPayload(kind, rnd = crypto.randomBytes) {
  const mark = TEST_DB.marks[rnd(1)[0] % TEST_DB.marks.length];
  const session = rnd(4).toString('hex').toUpperCase();
  const flip = (ch) => (ch === 'F' ? '0' : (parseInt(ch, 16) + 1).toString(16).toUpperCase());
  let payload, matchId = mark.matchId, expected;
  switch (kind) {
    case 'valido': payload = mark.payload; expected = 200; break;
    case 'adulterado': payload = mark.payload.slice(0, 15) + flip(mark.payload[15]) + mark.payload.slice(16); expected = 422; break;
    case 'control_alterado': payload = mark.payload.slice(0, -1) + flip(mark.payload.slice(-1)); expected = 422; break;
    case 'no_emitido': payload = makePayload(mark.matchId, mark.lic, session); expected = 403; break;
    case 'lic_desconocido': payload = makePayload(mark.matchId, 'ZZZ', session); expected = 403; break;
    case 'otro_partido': payload = mark.payload; matchId = TEST_DB.matches.find((m) => m.id !== mark.matchId).id; expected = 403; break;
    case 'malformado': payload = mark.payload.replace(/-/g, '').slice(0, 20); expected = 400; break;
    default: throw new Error('tipo desconocido: ' + kind);
  }
  return {
    kind, expected, matchId, payload,
    detector: { name: 'mock-forense', version: '1.0', confidence: +(0.9 + (rnd(1)[0] % 10) / 100).toFixed(2), frame: rnd(2).readUInt16BE(0), extractedAt: new Date().toISOString() },
  };
}
const mockBatch = (n = KINDS.length) => Array.from({ length: n }, (_, i) => mockPayload(KINDS[i % KINDS.length]));

module.exports = { RE, matchCode, ctrlOf, makePayload, parsePayload, verifyPayload, TEST_DB, KINDS, mockPayload, mockBatch };

if (require.main === module) for (const x of mockBatch(+process.argv[2] || KINDS.length)) console.log(JSON.stringify(x));
