const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../api/_hls');
const F = require('../api/_futbol');
const capture = require('../api/stream-capture');

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"
audio.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
hd/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42001e,mp4a.40.2"
https://cdn.example/sd/index.m3u8`;

test('hls: variantes ordenadas y se elige la más liviana con video', () => {
  const vs = H.parseMaster(MASTER, 'https://pirata.example/live/master.m3u8');
  assert.deepStrictEqual(vs.map(v => v.bandwidth), [128000, 800000, 2000000]);
  assert.strictEqual(vs[2].url, 'https://pirata.example/live/hd/index.m3u8');
  assert.strictEqual(H.pickVariant(vs).url, 'https://cdn.example/sd/index.m3u8');
});

test('hls: lista en vivo, cerrada, cifrada y fMP4', () => {
  const live = H.parseMedia('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-PROGRAM-DATE-TIME:2026-11-12T22:00:00Z\n#EXTINF:2.0,\nseg100.ts\n#EXTINF:2.0,\nseg101.ts\n', 'https://e.example/a/live.m3u8');
  assert.strictEqual(live.endList, false); assert.strictEqual(live.targetDuration, 2);
  assert.deepStrictEqual(live.segments.map(s => [s.seq, s.url]), [[100, 'https://e.example/a/seg100.ts'], [101, 'https://e.example/a/seg101.ts']]);
  assert.strictEqual(live.segments[0].programDateTime, '2026-11-12T22:00:00Z');
  const vod = H.parseMedia('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\na.m4s\n#EXT-X-ENDLIST', 'https://e.example/v/x.m3u8');
  assert.strictEqual(vod.endList, true); assert.strictEqual(vod.key, 'AES-128'); assert.strictEqual(vod.map, 'https://e.example/v/init.mp4');
});

test('fútbol: la página de prueba da señales de streaming de fútbol', () => {
  const page = F.footballSignals(fs.readFileSync(path.join(__dirname, '../prueba/en-vivo.html'), 'utf8'));
  const player = F.footballSignals(fs.readFileSync(path.join(__dirname, '../prueba/reproductor.html'), 'utf8'));
  const s = F.mergeSignals([page, player]);
  assert.match(s.title, /Boca Juniors vs River Plate/);
  for (const k of ['fútbol', 'en vivo', 'Liga Profesional', 'superclásico', 'fútbol libre / pirata']) assert.ok(s.keywords.includes(k), k);
  assert.ok(s.channels.some(c => c.name === 'ESPN Premium' && c.lic === 'ESP'));
  assert.ok(s.players.includes('hls.js'));
  assert.ok(!/<script|hls\.min/.test(s.text));
});

test('fútbol: una página cualquiera no da señales', () => {
  const s = F.footballSignals('<html><title>Recetas de cocina</title><body><p>Tortilla de papas</p></body></html>');
  assert.deepStrictEqual([s.keywords, s.channels, s.players], [[], [], []]);
});

function call(query) {
  return new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
    capture({ method: 'GET', query }, res);
  });
}
test('captura de stream: rechaza hosts privados y URL inválida', async () => {
  assert.strictEqual((await call({ url: 'http://127.0.0.1/live.m3u8' })).status, 422);
  assert.strictEqual((await call({ url: 'http://10.1.2.3/live.m3u8' })).status, 422);
  assert.strictEqual((await call({ url: 'no es url' })).status, 400);
});
