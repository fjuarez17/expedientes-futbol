// Señales de que una página es un streaming de fútbol (reglas, no IA).
const KEYWORDS = [['fútbol', /f[uú]tbol/i], ['en vivo', /en vivo|live/i], ['partido', /partido/i], ['ver online', /ver (?:online|gratis)|online gratis/i], ['Liga Profesional', /liga profesional|\bLPF\b|torneo apertura|torneo clausura|copa de la liga/i], ['Copa Argentina', /copa argentina/i], ['Libertadores/Sudamericana', /libertadores|sudamericana/i], ['superclásico', /supercl[aá]sico/i], ['fútbol libre / pirata', /f[uú]tbol ?libre|rojadirecta|pirlo|tarjeta ?roja|futbolparatodos|libre ?futbol/i]];
const CHANNELS = [['ESPN Premium', /espn ?premium/i, 'ESP'], ['ESPN', /\bespn\b/i, 'ESP'], ['Disney+ / Star+', /disney\s?\+|star\s?\+|starplus/i, 'ESP'], ['TNT Sports', /tnt ?sports/i, 'TNT'], ['Max', /\bhbo ?max\b/i, 'TNT'], ['DSports / DIRECTV', /d ?sports|directv|dgo\b/i, 'DTV'], ['Flow', /\bflow\b/i, 'FLW'], ['Telecentro', /telecentro/i, 'TLC'], ['Movistar', /movistar/i, 'MOV'], ['TyC Sports', /tyc ?sports/i, null], ['Fox Sports', /fox ?sports/i, null], ['TV Pública', /tv p[uú]blica/i, null], ['Telefe', /telefe/i, null]];
const PLAYERS = [['Clappr', /clappr/i], ['JW Player', /jwplayer|jwplatform/i], ['hls.js', /hls(?:\.min)?\.js|new Hls\(|Hls\.isSupported/], ['Video.js', /video(?:\.min)?\.js|videojs\(/i], ['Plyr', /plyr/i], ['Flowplayer', /flowplayer/i], ['Shaka Player', /shaka-player|shaka\.Player/i], ['DPlayer', /dplayer/i], ['MediaElement', /mediaelement/i], ['Bitmovin', /bitmovin/i], ['P2P (p2p-media-loader / Peer5 / Streamroot)', /p2p-media-loader|peer5|streamroot|p2pengine/i], ['<video>', /<video[\s>]/i]];

function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function footballSignals(html) {
  const title = ((html.match(/<title[^>]*>([^<]{0,200})/i) || [])[1] || '').trim();
  const desc = ((html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']{0,300})/i) || [])[1] || '').trim();
  const text = (title + ' · ' + desc + ' · ' + visibleText(html)).slice(0, 4000);
  const hit = (list, src) => list.filter(([, re]) => re.test(src)).map(x => x[0]);
  const channels = CHANNELS.filter(([, re]) => re.test(text)).map(([name, , lic]) => ({ name, lic }));
  return { title, description: desc, keywords: hit(KEYWORDS, text), channels, players: hit(PLAYERS, html), text: text.slice(0, 1500) };
}

function mergeSignals(list) {
  const out = { title: null, keywords: [], channels: [], players: [], text: '' };
  for (const s of list.filter(Boolean)) {
    out.title = out.title || s.title || null;
    for (const k of s.keywords) if (!out.keywords.includes(k)) out.keywords.push(k);
    for (const c of s.channels) if (!out.channels.some(x => x.name === c.name)) out.channels.push(c);
    for (const p of s.players) if (!out.players.includes(p)) out.players.push(p);
    if (out.text.length < 3000) out.text += (out.text ? ' · ' : '') + s.text;
  }
  out.text = out.text.slice(0, 3000);
  return out;
}

module.exports = { footballSignals, mergeSignals, visibleText };
