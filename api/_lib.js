const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

async function fetchT(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

async function getJSON(url, ms = 7000) {
  try {
    const r = await fetchT(url, { headers: { 'User-Agent': 'expedientes-futbol/1.0' } }, ms);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l === '::';
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}

async function resolve(host) {
  const out = { host, a: [], aaaa: [], cname: [] };
  const [a, aaaa] = await Promise.all([
    getJSON(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`),
    getJSON(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=AAAA`),
  ]);
  for (const ans of (a && a.Answer) || []) {
    if (ans.type === 1) out.a.push(ans.data);
    if (ans.type === 5) out.cname.push(ans.data.replace(/\.$/, ''));
  }
  for (const ans of (aaaa && aaaa.Answer) || []) if (ans.type === 28) out.aaaa.push(ans.data);
  out.a = [...new Set(out.a)]; out.cname = [...new Set(out.cname)];
  return out;
}

// ASN → tipo de infraestructura
const ASN_KIND = {
  13335: ['cdn', 'Cloudflare'], 209242: ['cdn', 'Cloudflare'], 20940: ['cdn', 'Akamai'], 16625: ['cdn', 'Akamai'],
  54113: ['cdn', 'Fastly'], 22822: ['cdn', 'Edgio/Limelight'], 15133: ['cdn', 'Edgecast'], 60068: ['cdn', 'CDN77/DataCamp'],
  199524: ['cdn', 'G-Core Labs'], 202053: ['cdn', 'G-Core Labs'], 30081: ['cdn', 'CacheNetworks'], 12989: ['cdn', 'StackPath/Highwinds'],
  33438: ['cdn', 'StackPath'], 47583: ['hosting', 'Hostinger'], 21859: ['cdn', 'Zenlayer'], 136165: ['cdn', 'BunnyCDN'], 200325: ['cdn', 'BunnyCDN'],
  16509: ['cloud', 'Amazon AWS/CloudFront'], 14618: ['cloud', 'Amazon AWS'], 15169: ['cloud', 'Google'], 396982: ['cloud', 'Google Cloud'],
  8075: ['cloud', 'Microsoft Azure'], 31898: ['cloud', 'Oracle Cloud'], 45102: ['cloud', 'Alibaba Cloud'],
  16276: ['hosting', 'OVHcloud'], 24940: ['hosting', 'Hetzner'], 14061: ['hosting', 'DigitalOcean'], 63949: ['hosting', 'Akamai/Linode'],
  20473: ['hosting', 'Vultr/Choopa'], 51167: ['hosting', 'Contabo'], 9009: ['hosting', 'M247'], 49981: ['hosting', 'WorldStream'],
  202425: ['hosting', 'IP Volume'], 212238: ['hosting', 'Datacamp'], 35916: ['hosting', 'MULTACOM'], 40021: ['hosting', 'Contabo US'],
  62904: ['hosting', 'Eonix'], 36352: ['hosting', 'ColoCrossing'], 46606: ['hosting', 'Unified Layer/Bluehost'], 26496: ['hosting', 'GoDaddy'],
  398101: ['hosting', 'GoDaddy'], 197540: ['hosting', 'netcup'], 8560: ['hosting', 'IONOS'], 43350: ['hosting', 'NForce'], 57043: ['hosting', 'HOSTKEY'],
};
const CDN_CNAME = [
  [/cloudfront\.net$/, 'Amazon CloudFront'], [/akamai(edge|technologies)?\.net$|edgekey\.net$|edgesuite\.net$/, 'Akamai'],
  [/fastly\.net$/, 'Fastly'], [/cdn\.cloudflare\.net$/, 'Cloudflare'], [/b-cdn\.net$/, 'BunnyCDN'], [/cdn77\.org$/, 'CDN77'],
  [/azureedge\.net$/, 'Azure CDN'], [/googleusercontent\.com$|googlevideo\.com$/, 'Google'], [/gcdn\.co$/, 'G-Core'],
];

async function ipIntel(ip) {
  const [ni, geo] = await Promise.all([
    getJSON(`https://stat.ripe.net/data/network-info/data.json?resource=${ip}`),
    getJSON(`https://stat.ripe.net/data/maxmind-geo-lite/data.json?resource=${ip}`),
  ]);
  const asn = ni && ni.data && ni.data.asns && ni.data.asns[0];
  const prefix = ni && ni.data && ni.data.prefix;
  let holder = null;
  if (asn) {
    const ov = await getJSON(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`);
    holder = ov && ov.data && ov.data.holder;
  }
  let country = null, city = null;
  try {
    const loc = geo.data.located_resources[0].locations[0];
    country = loc.country; city = loc.city || null;
  } catch {}
  const kind = asn && ASN_KIND[asn] ? ASN_KIND[asn][0] : 'desconocido';
  return { ip, asn: asn ? Number(asn) : null, holder, prefix, country, city, kind, kindLabel: asn && ASN_KIND[asn] ? ASN_KIND[asn][1] : null };
}

async function reverseIP(ip) {
  try {
    const r = await fetchT(`https://api.hackertarget.com/reverseiplookup/?q=${ip}`, {}, 7000);
    const t = (await r.text()).trim();
    if (!r.ok || /error|API count|no records|invalid/i.test(t)) return { ok: false, note: t.slice(0, 120) || 'sin datos', domains: [], count: null };
    const domains = t.split('\n').map(s => s.trim()).filter(Boolean);
    return { ok: true, count: domains.length, domains: domains.slice(0, 40) };
  } catch (e) { return { ok: false, note: 'consulta no disponible', domains: [], count: null }; }
}

async function rdapDomain(domain) {
  const parts = domain.split('.');
  const reg = parts.slice(-2).join('.');
  const j = await getJSON(`https://rdap.org/domain/${reg}`, 7000);
  if (!j) return { domain: reg, ok: false };
  const ev = Object.fromEntries((j.events || []).map(e => [e.eventAction, e.eventDate]));
  let registrar = null, abuse = null;
  for (const ent of j.entities || []) {
    if ((ent.roles || []).includes('registrar')) {
      try { registrar = ent.vcardArray[1].find(v => v[0] === 'fn')[3]; } catch {}
      for (const sub of ent.entities || []) {
        if ((sub.roles || []).includes('abuse')) {
          try { abuse = sub.vcardArray[1].find(v => v[0] === 'email')[3]; } catch {}
        }
      }
    }
  }
  return { domain: reg, ok: true, registrar, abuse, created: ev.registration || null, expires: ev.expiration || null, nameservers: (j.nameservers || []).map(n => (n.ldhName || '').toLowerCase()) };
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

module.exports = { UA, fetchT, getJSON, sha256, isPrivateIP, resolve, ipIntel, reverseIP, rdapDomain, CDN_CNAME, send, readBody };
