const L = require('./_lib');

const reg = (h) => (h || '').toLowerCase().split('.').slice(-2).join('.');

async function nameservers(domain) {
  const j = await L.getJSON(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=NS`);
  return [...new Set(((j && j.Answer) || []).filter(a => a.type === 2).map(a => a.data.replace(/\.$/, '').toLowerCase()))];
}

async function certSiblings(domain) {
  const j = await L.getJSON(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`, 9000);
  if (!Array.isArray(j)) return { ok: false, source: 'certspotter', siblings: [], certs: 0 };
  const sib = new Map();
  for (const c of j) for (const n of c.dns_names || []) {
    const r = reg(n.replace(/^\*\./, ''));
    if (!r || r === domain) continue;
    const e = sib.get(r) || { domain: r, certs: new Set(), first: c.not_before };
    e.certs.add(c.cert_sha256.slice(0, 16)); if (c.not_before < e.first) e.first = c.not_before;
    sib.set(r, e);
  }
  return { ok: true, source: 'certspotter (Certificate Transparency)', certs: j.length, siblings: [...sib.values()].slice(0, 40).map(e => ({ domain: e.domain, certs: [...e.certs], first: e.first })) };
}

module.exports = async (req, res) => {
  const list = String((req.query && req.query.domains) || '').split(',').map(reg).filter(d => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  const domains = [...new Set(list)].slice(0, 5);
  if (!domains.length) return L.send(res, 400, { error: 'Parámetro domains requerido' });
  try {
    const out = await Promise.all(domains.map(async (d) => {
      const [rdap, ns, ct] = await Promise.all([L.rdapDomain(d), nameservers(d), certSiblings(d)]);
      const ageDays = rdap.created ? Math.floor((Date.now() - new Date(rdap.created)) / 864e5) : null;
      return { domain: d, rdap, ageDays, newDomain: ageDays != null && ageDays <= 30, nameservers: ns.length ? ns : (rdap.nameservers || []), ct };
    }));
    const report = { tracedAt: new Date().toISOString(), domains: out };
    report.sha256 = L.sha256(JSON.stringify(report));
    return L.send(res, 200, report);
  } catch (e) {
    return L.send(res, 500, { error: 'Falló el rastreo', detail: String(e && e.message || e).slice(0, 200) });
  }
};
