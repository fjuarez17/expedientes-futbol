const L = require('./_lib');

function absUrl(u, base) { try { return new URL(u, base).href; } catch { return null; } }

function attrs(line) {
  const o = {}; const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g; let m;
  while ((m = re.exec(line))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

// Lista maestra: devuelve variantes ordenadas por ancho de banda.
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const a = attrs(lines[i].slice(18));
    let j = i + 1; while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    const url = lines[j] && absUrl(lines[j], base);
    if (url) out.push({ url, bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || null, codecs: a.CODECS || null });
  }
  return out.sort((x, y) => x.bandwidth - y.bandwidth);
}

// Variante más liviana que tenga video (para bajar pocos MB y poder sacar un fotograma).
function pickVariant(vs) {
  return vs.find(v => v.resolution || /avc|hvc|hev/i.test(v.codecs || '')) || vs[0] || null;
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const r = { targetDuration: null, mediaSequence: 0, endList: false, playlistType: null, key: null, map: null, programDateTime: null, segments: [] };
  let dur = null, pdt = null, seq = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) r.targetDuration = Number(l.split(':')[1]);
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { r.mediaSequence = Number(l.split(':')[1]) || 0; seq = r.mediaSequence; }
    else if (l.startsWith('#EXT-X-ENDLIST')) r.endList = true;
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) r.playlistType = l.split(':')[1];
    else if (l.startsWith('#EXT-X-KEY:')) { const a = attrs(l.slice(11)); if (a.METHOD && a.METHOD !== 'NONE') r.key = a.METHOD; }
    else if (l.startsWith('#EXT-X-MAP:')) r.map = absUrl(attrs(l.slice(11)).URI || '', base);
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pdt = l.slice(25); if (!r.programDateTime) r.programDateTime = pdt; }
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) {
      const url = absUrl(l, base);
      if (url) r.segments.push({ url, seq, duration: dur, programDateTime: pdt });
      seq++; dur = null; pdt = null;
    }
  }
  return r;
}

async function publicHost(host) {
  const r = await L.resolve(host);
  const ips = [...r.a, ...r.aaaa];
  return ips.length > 0 && !ips.some(L.isPrivateIP);
}

// fetch que valida cada salto de redirección contra IPs privadas.
async function fetchSafe(url, referer, ms = 8000) {
  for (let i = 0; i < 5; i++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Solo http/https'), { code: 400 });
    if (!(await publicHost(u.hostname))) throw Object.assign(new Error('Host privado o sin DNS: ' + u.hostname), { code: 422 });
    const r = await L.fetchT(url, { redirect: 'manual', headers: { 'User-Agent': L.UA, Accept: '*/*', ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}) } }, ms);
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) return { res: r, finalUrl: url };
    url = new URL(loc, url).href;
  }
  throw Object.assign(new Error('Demasiadas redirecciones'), { code: 422 });
}

async function readCapped(res, max) {
  const chunks = []; let n = 0;
  for await (const ch of res.body) { chunks.push(ch); n += ch.length; if (n > max) return { buf: Buffer.concat(chunks).subarray(0, max), truncated: true }; }
  return { buf: Buffer.concat(chunks), truncated: false };
}

module.exports = { parseMaster, pickVariant, parseMedia, publicHost, fetchSafe, readCapped, absUrl };
