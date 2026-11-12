'use strict';
/* ===== Oráculo: consenso, juez de turno, firma, grafo de origen y transparencia =====
   Modo local (localStorage). El esquema equivalente para Supabase (RLS, Realtime) está en supabase/schema.sql. */
const JURIS = ['CABA · Civil y Comercial Federal', 'Provincia de Buenos Aires', 'Córdoba', 'Santa Fe', 'Mendoza'];
const MATCH_MIN = 110;
const H = 3600e3;

function ensureDB() {
  DB.judges = DB.judges || []; DB.turnos = DB.turnos || []; DB.orders = DB.orders || []; DB.claims = DB.claims || []; DB.annexes = DB.annexes || [];
  DB.settings = DB.settings || { webhook: '', actingJudge: null };
  DB.flags = DB.flags || {};
  if (!DB.flags.judgesSeeded) {
    const now = Date.now(), iso = (t) => new Date(t).toISOString();
    const a = { id: 'j-' + uid(), name: 'Dra. Laura Méndez (ejemplo)', juzgado: 'Juzgado Civil y Comercial Federal N.º 3 (ejemplo)', contacto: '', ejemplo: true };
    const b = { id: 'j-' + uid(), name: 'Dr. Martín Ferreyra (ejemplo)', juzgado: 'Juzgado Civil y Comercial Federal N.º 7 (ejemplo)', contacto: '', ejemplo: true };
    const c = { id: 'j-' + uid(), name: 'Dra. Sofía Ibarra (ejemplo)', juzgado: 'Juzgado Civil y Comercial N.º 12 de La Plata (ejemplo)', contacto: '', ejemplo: true };
    DB.judges.push(a, b, c);
    DB.turnos.push({ id: uid(), juez_id: a.id, jurisdiccion: JURIS[0], desde: iso(now - 4 * H), hasta: iso(now + 8 * H) },
      { id: uid(), juez_id: b.id, jurisdiccion: JURIS[0], desde: iso(now + 8 * H), hasta: iso(now + 20 * H) },
      { id: uid(), juez_id: c.id, jurisdiccion: JURIS[1], desde: iso(now - 4 * H), hasta: iso(now + 20 * H) });
    DB.settings.actingJudge = a.id; DB.flags.judgesSeeded = true; save();
  }
}
const judgeById = (id) => DB.judges.find(j => j.id === id);
function activeTurnos(judgeId, t = Date.now()) { return DB.turnos.filter(x => x.juez_id === judgeId && new Date(x.desde) <= t && t <= new Date(x.hasta)); }
function juezCompetente(jur, t = Date.now()) { const x = DB.turnos.find(x => x.jurisdiccion === jur && new Date(x.desde) <= t && t <= new Date(x.hasta)); return x ? judgeById(x.juez_id) : null; }
const caseJur = (c) => c.jurisdiccion || JURIS[0];
function minutesLeft(m) { return Math.round((new Date(m.kickoff).getTime() + MATCH_MIN * 60e3 - Date.now()) / 60e3); }
function isLive(m) { const ko = new Date(m.kickoff).getTime(), n = Date.now(); return n >= ko - 15 * 60e3 && n <= ko + (MATCH_MIN + 15) * 60e3; }
function liveLabel(m) { const l = minutesLeft(m); if (!isLive(m)) return new Date(m.kickoff) > Date.now() ? 'por empezar' : 'terminado'; return l > 0 ? `${l} min restantes` : 'tiempo cumplido'; }

async function checkHandover() {
  DB.flags.turnoActual = DB.flags.turnoActual || {};
  for (const jur of JURIS) {
    const cur = juezCompetente(jur); const id = cur ? cur.id : null;
    if (!(jur in DB.flags.turnoActual)) { DB.flags.turnoActual[jur] = id; save(); continue; }
    const prev = DB.flags.turnoActual[jur];
    if (prev !== id) {
      DB.flags.turnoActual[jur] = id; save();
      const pend = DB.cases.filter(c => c.estado === 'en_cola_juez' && caseJur(c) === jur).length;
      await audit('traspaso_turno', null, `${jur}: ${(judgeById(prev) || {}).name || 'sin juez'} → ${(cur || {}).name || 'sin juez'} · ${pend} pendiente(s) pasan al entrante`);
    }
  }
}

/* --- Filtro de consenso --- */
const deliveryOf = (c) => c.analysis && c.analysis.hosts.find(h => h.host === c.analysis.deliveryHost);
function licensedHit(c) {
  const hosts = [hostOf(c.target), c.analysis && c.analysis.deliveryHost].filter(Boolean);
  for (const h of hosts) for (const l of DB.licensees) for (const d of l.domains) if (h === d || h.endsWith('.' + d)) return { host: h, lic: l };
  return null;
}
function consensus(c) {
  const wm = c.watermark, dh = deliveryOf(c), lic = licensedHit(c), p = c.probe;
  const checks = [
    { k: 'marca', ok: !!(wm && wm.verdict === 'ok' && isLive(c.match)), t: !wm ? 'Falta verificar la marca de agua.' : wm.verdict !== 'ok' ? 'La marca de agua no valida contra el partido o el licenciatario.' : isLive(c.match) ? `La marca coincide con ${matchName(c.match)}, en curso (${liveLabel(c.match)}).` : `La marca coincide con ${matchName(c.match)}, pero el partido no está en curso (${liveLabel(c.match)}).` },
    { k: 'licencia', ok: !lic && !!hostOf(c.target), t: lic ? `${lic.host} es dominio de ${lic.lic.name}: distribución autorizada.` : 'Ningún dominio del caso figura en la lista de licenciatarios.' },
    { k: 'puntos', ok: !!(p && p.distinct >= 2), t: !p ? 'Falta reproducir desde puntos independientes.' : p.error ? `Verificación multipunto falló: ${p.error}` : `Reproducido desde ${p.distinct} punto(s) distintos (${p.points.filter(x => x.ok).map(x => x.country).join(', ') || 'ninguno'}).` },
    { k: 'colateral', ok: !!(dh && dh.collateral && dh.collateral.recommendation), t: dh && dh.collateral ? `Riesgo colateral ${dh.collateral.level}; bloqueo recomendado: ${dh.collateral.recommendation === 'bloquear_dominio' ? 'por dominio' : 'por IP y dominio'}.` : 'Falta identificar el servidor de video y su riesgo colateral.' },
  ];
  return { at: new Date().toISOString(), checks, ok: checks.every(x => x.ok) };
}

/* --- Grafo de origen --- */
function graphOf(c) {
  const a = c.analysis; if (!a) return null;
  const col = { pagina: [], embed: [], video: [], ip: [], asn: [] }, edges = [];
  const add = (k, id, label, extra) => { if (!col[k].some(n => n.id === id)) col[k].push({ id, label, ...extra }); };
  const page = a.hosts.filter(h => h.roles.includes('pagina')), emb = a.hosts.filter(h => h.roles.includes('embed') && !h.roles.includes('pagina')), vid = a.hosts.filter(h => h.roles.some(r => r === 'manifiesto' || r === 'segmentos'));
  page.forEach(h => add('pagina', h.host, h.host)); emb.forEach(h => add('embed', h.host, h.host)); vid.forEach(h => add('video', h.host, h.host, { main: h.host === a.deliveryHost }));
  page.forEach(p => (emb.length ? emb : vid).forEach(e => edges.push([p.host, e.host])));
  emb.forEach(e => vid.forEach(v => edges.push([e.host, v.host])));
  [...page, ...emb, ...vid].forEach(h => h.ips.slice(0, 2).forEach(i => { add('ip', i.ip, i.ip); edges.push([h.host, i.ip]); if (i.asn) { add('asn', 'AS' + i.asn, `AS${i.asn} ${(i.kindLabel || i.holder || '').slice(0, 14)}`, { kind: i.kind }); edges.push([i.ip, 'AS' + i.asn]); } }));
  return { col, edges };
}
function graphSvg(g) {
  const cols = ['pagina', 'embed', 'video', 'ip', 'asn'], names = ['PÁGINA', 'REPRODUCTOR', 'HOST DE VIDEO', 'IP', 'ASN'];
  const W = 170, NH = 34, GAP = 14, top = 30, pos = {};
  const rows = Math.max(1, ...cols.map(k => g.col[k].length));
  const height = top + rows * (NH + GAP) + 10;
  let s = `<svg class="graph" viewBox="0 0 ${cols.length * W} ${height}" width="${cols.length * W}" height="${height}" role="img" aria-label="Grafo de origen">`;
  cols.forEach((k, ci) => { s += `<text x="${ci * W + 8}" y="16" class="gh">${names[ci]}</text>`; g.col[k].forEach((n, ri) => { pos[n.id] = [ci * W + 8, top + ri * (NH + GAP)]; }); });
  for (const [f, t] of g.edges) if (pos[f] && pos[t]) { const [x1, y1] = pos[f], [x2, y2] = pos[t]; s += `<path d="M${x1 + 150} ${y1 + NH / 2} C${x1 + 160} ${y1 + NH / 2},${x2 - 10} ${y2 + NH / 2},${x2} ${y2 + NH / 2}" class="ge"/>`; }
  cols.forEach(k => g.col[k].forEach(n => { const [x, y] = pos[n.id]; const cls = n.main ? 'gn main' : n.kind === 'cdn' ? 'gn cdn' : 'gn'; const lab = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label; s += `<g class="${cls}"><rect x="${x}" y="${y}" width="150" height="${NH}"/><text x="${x + 8}" y="${y + 21}">${esc(lab)}</text><title>${esc(n.label)}</title></g>`; }));
  return s + '</svg>';
}
function traceDomains(c) {
  const a = c.analysis; const s = new Set([regDomain(hostOf(c.target))]);
  if (a) a.hosts.forEach(h => s.add(regDomain(h.host)));
  return [...s].filter(Boolean).slice(0, 5);
}
function demoTrace(c) {
  return { tracedAt: new Date().toISOString(), demo: true, domains: traceDomains(c).map((d, i) => ({ domain: d, ageDays: i === 0 ? 6 : 210, newDomain: i === 0, rdap: { registrar: 'Registrador Demo', created: new Date(Date.now() - (i === 0 ? 6 : 210) * 864e5).toISOString() }, nameservers: ['ns1.dns-demo.example', 'ns2.dns-demo.example'], ct: { ok: true, source: 'demo', certs: 3, siblings: i === 0 ? [{ domain: 'futbol-libre-demo.example' }, { domain: 'tv-gratis-demo.example' }] : [] } })) };
}
function demoProbe(url) {
  const pts = [['de', 'Germany', 'Frankfurt', 'AS212000'], ['br', 'Brazil', 'São Paulo', 'AS264409'], ['us', 'USA', 'New York', 'AS213535']].map(([cc, co, ci, asn]) => ({ node: cc + '.demo', countryCode: cc, country: co, city: ci, nodeAsn: asn, ok: true, status: 200, message: 'OK', resolvedIp: '203.0.113.77' }));
  return { url, checkedAt: new Date().toISOString(), service: 'demo', points: pts, okPoints: 3, distinct: 3 };
}

/* --- Anexo dinámico --- */
function findParent(c) {
  const dh = c.analysis && c.analysis.deliveryHost;
  const sess = c.watermark && c.watermark.verdict === 'ok' ? c.watermark.payload.split('-').slice(2, 4).join('-') : null;
  for (const p of DB.cases) {
    if (p.id === c.id || !p.signature) continue;
    if (dh && p.analysis && p.analysis.deliveryHost === dh) return { parent: p, reason: `mismo host de video (${dh})` };
    if (sess && p.watermark && p.watermark.payload.split('-').slice(2, 4).join('-') === sess) return { parent: p, reason: `misma sesión de marca de agua (${sess})` };
  }
  return null;
}
const ordNum = () => { DB.flags.ordSeq = (DB.flags.ordSeq || 0) + 1; return `ORD-${new Date().getFullYear()}-${String(DB.flags.ordSeq).padStart(4, '0')}`; };
const objetivo = (t) => { const m = t.match(/IP de entrega ([0-9a-f.:, ]+)/i); if (m) return 'IP ' + m[1].trim(); const d = t.match(/\(([^)]+)\)/); return d ? d[1] : t; };
async function annex(c, hit) {
  const p = hit.parent;
  DB.annexes.push({ id: uid(), parentId: p.id, childId: c.id, target: hostOf(c.target), reason: hit.reason, at: new Date().toISOString() });
  c.estado = 'anexado'; c.annexOf = p.id;
  const base = DB.orders.find(o => o.caseId === p.id && o.estado !== 'levantada');
  const host = hostOf(c.target);
  if (base && !DB.orders.some(o => o.caseId === p.id && o.objetivo === host)) DB.orders.push({ ...base, id: uid(), num: ordNum(), objetivo: host, tipo: 'DNS + SNI', origen: `anexo de ${c.num} (${hit.reason})`, firmadaAt: new Date().toISOString() });
  save(); await audit('anexo_dinamico', p.id, `${c.num} ${host} anexado a ${p.num}: ${hit.reason}`);
}

/* --- Avisos --- */
async function notifyJudge(c) {
  const j = juezCompetente(caseJur(c));
  const payload = { evento: 'expediente_en_cola', expediente: c.num, partido: matchName(c.match), minutos_restantes: minutesLeft(c.match), jurisdiccion: caseJur(c), juez: j ? j.name : null, contacto: j ? j.contacto : null, objetivo: hostOf(c.target), link: `${location.origin}/#/juez?exp=${c.id}` };
  if (!DB.settings.webhook) { await audit('aviso_juez', c.id, `sin webhook configurado · ${payload.juez || 'sin juez de turno'}`); return; }
  try { const r = await fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook: DB.settings.webhook, payload }) }); const j2 = await r.json(); await audit('aviso_juez', c.id, `webhook ${j2.ok ? 'OK' : 'falló'} (${j2.status || j2.error}) → ${payload.juez || 'sin juez'}`); }
  catch { await audit('aviso_juez', c.id, 'webhook sin conexión'); }
}

/* --- Ejecutar el oráculo --- */
window.runOracle = async (id) => {
  const c = getCase(id); if (!c) return;
  if (c.seal) return toast('Expediente sellado: abrí una nueva versión');
  if (!c.analysis) return toast('Primero corré el análisis técnico');
  const st = $('#orStatus'); const say = (t) => { if (st) st.innerHTML = `<p><span class="spin"></span> ${esc(t)}</p>`; };
  c.jurisdiccion = caseJur(c);
  try {
    say('Rastreando dominios: RDAP, nameservers y Certificate Transparency…');
    if (c.demo) c.trace = demoTrace(c);
    else { const r = await fetch('/api/trace?domains=' + encodeURIComponent(traceDomains(c).join(','))); c.trace = await r.json(); }
    save(); await audit('rastreo_origen', c.id, `${(c.trace.domains || []).length} dominios · sha256=${c.trace.sha256 || 'demo'}`);
    const url = (c.analysis.video[0] && c.analysis.video[0].url) || c.videoUrl || c.target;
    say('Reproduciendo desde varios países (check-host.net)…');
    if (c.demo) c.probe = demoProbe(url);
    else { const r = await fetch('/api/probe?url=' + encodeURIComponent(url)); const j = await r.json(); c.probe = r.ok ? j : { error: j.error || 'error', points: [], distinct: 0 }; }
    save(); await audit('reproduccion_multipunto', c.id, `${c.probe.distinct || 0} puntos distintos · ${url}`);
    const hit = findParent(c);
    if (hit) { await annex(c, hit); toast('Anexado al expediente firmado ' + hit.parent.num); return route(); }
    if (!c.expiry) c.expiry = proposeExpiry(c);
    c.consensus = consensus(c);
    if (c.consensus.ok) {
      say('Consenso alcanzado: congelando el expediente…');
      const hash = await sha256Hex(stable(sealPayload(c)));
      c.seal = { sha256: hash, sealedAt: new Date().toISOString(), tsa: await stamp(hash) };
      c.estado = 'en_cola_juez'; save();
      await audit('expediente_sellado', c.id, `v${c.version} sha256=${hash}`);
      await audit('consenso_ok', c.id, `en cola del juez de turno · ${c.jurisdiccion}`);
      await notifyJudge(c); toast('En cola del juez de turno');
    } else {
      c.estado = 'revision_humana'; save();
      await audit('consenso_fallido', c.id, c.consensus.checks.filter(x => !x.ok).map(x => x.k).join(', '));
      toast('No hay consenso: pasa a revisión humana');
    }
  } catch (e) { toast('Falló el oráculo: ' + e.message); }
  route();
};
window.setJur = async (id, v) => { const c = getCase(id); c.jurisdiccion = v; save(); await audit('jurisdiccion', id, v); route(); };

/* --- Firma --- */
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
async function ensureKeys(j) {
  if (j.keys) return j.keys;
  let alg = 'Ed25519', kp;
  try { kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); }
  catch { alg = 'ECDSA-P256'; kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); }
  j.keys = { alg, pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  save(); await audit('clave_juez_generada', null, `${j.name} · ${alg}`);
  return j.keys;
}
const algParams = (alg) => alg === 'Ed25519' ? [{ name: 'Ed25519' }, { name: 'Ed25519' }] : [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }];
const sigMessage = (s) => enc.encode(stable({ sha256: s.sha256, juez_id: s.juez_id, ts: s.ts }));
async function verifySignature(c) {
  const s = c.signature; if (!s) return null;
  const now = await sha256Hex(stable(sealPayload(c)));
  if (!c.seal || now !== s.sha256 || c.seal.sha256 !== s.sha256) return { ok: false, t: 'El expediente cambió después de la firma: la firma ya no verifica.' };
  try {
    const [imp, sp] = algParams(s.alg);
    const key = await crypto.subtle.importKey('jwk', s.pub, imp, false, ['verify']);
    const ok = await crypto.subtle.verify(sp, key, unb64(s.sig), sigMessage(s));
    return ok ? { ok: true, t: `Firma ${s.alg} válida sobre sha256 ${s.sha256.slice(0, 16)}…` } : { ok: false, t: 'Firma inválida.' };
  } catch { return { ok: false, t: `Este navegador no puede verificar ${s.alg}.` }; }
}
window.signCase = async (id) => {
  const c = getCase(id), j = judgeById(DB.settings.actingJudge);
  if (!j) return toast('Elegí el juez');
  if (!activeTurnos(j.id).some(t => t.jurisdiccion === caseJur(c))) return toast('Sin turno activo en esa jurisdicción: no podés firmar');
  if (!c.seal) return toast('El expediente no está congelado');
  if (await sha256Hex(stable(sealPayload(c))) !== c.seal.sha256) return toast('El expediente cambió después de sellarse');
  const k = await ensureKeys(j); const [imp, sp] = algParams(k.alg);
  const priv = await crypto.subtle.importKey('jwk', k.priv, imp, false, ['sign']);
  const s = { alg: k.alg, sha256: c.seal.sha256, juez_id: j.id, juez: j.name, juzgado: j.juzgado, ts: new Date().toISOString(), pub: k.pub };
  s.sig = b64(await crypto.subtle.sign(sp, priv, sigMessage(s)));
  c.signature = s; c.estado = 'firmado';
  for (const it of (c.expiry && c.expiry.items) || []) if (it.until || it.method !== 'NO bloquear por IP') {
    if (it.method === 'NO bloquear por IP') continue;
    DB.orders.push({ id: uid(), num: ordNum(), caseId: c.id, caseNum: c.num, objetivo: objetivo(it.target), tipo: it.method, juzgado: j.juzgado, juez: j.name, jurisdiccion: caseJur(c), firmadaAt: s.ts, hasta: it.until, estado: 'vigente', origen: 'firma' });
  }
  save(); await audit('expediente_firmado', c.id, `${j.name} · ${s.alg} · sha256=${s.sha256}`); toast('Firmado: órdenes publicadas'); route();
};
window.rejectCase = async (id) => {
  const c = getCase(id), j = judgeById(DB.settings.actingJudge); const why = prompt('Motivo del rechazo'); if (why == null) return;
  if (!j || !activeTurnos(j.id).some(t => t.jurisdiccion === caseJur(c))) return toast('Sin turno activo');
  c.estado = 'rechazado'; c.rejection = { juez_id: j.id, juez: j.name, ts: new Date().toISOString(), why }; save();
  await audit('expediente_rechazado', id, `${j.name}: ${why}`); route();
};

/* --- Tarjetas en el expediente --- */
const ESTADOS = { revision_humana: ['warn', 'Revisión humana'], en_cola_juez: ['info', 'En cola del juez'], firmado: ['ok', 'Firmado'], rechazado: ['bad', 'Rechazado'], anexado: ['ok', 'Anexado'] };
const estadoPill = (c) => c.estado && ESTADOS[c.estado] ? `<span class="pill ${ESTADOS[c.estado][0]}">${ESTADOS[c.estado][1]}</span>` : '';
const checksHtml = (cs) => `<ul class="check">${cs.checks.map(x => `<li><i class="ck ${x.ok ? 'y' : 'n'}"></i> ${esc(x.t)}</li>`).join('')}</ul>`;
async function oracleCards(c) {
  const g = graphOf(c), tr = c.trace, cs = c.consensus || (c.analysis ? consensus(c) : null), par = c.annexOf && getCase(c.annexOf);
  const kids = DB.annexes.filter(x => x.parentId === c.id);
  const vs = await verifySignature(c);
  const j = juezCompetente(caseJur(c));
  return `<div class="card step ${tr ? 'done' : ''}"><div class="fig">PASO 8.0</div><h2>Grafo de origen</h2>
  <p class="small mut">Página → reproductor → host de video → IP → ASN. Si muchas páginas tiran del mismo host de video, es un solo origen.</p>
  ${g ? `<div class="gwrap">${graphSvg(g)}</div>` : '<p class="small mut">Requiere el análisis técnico.</p>'}
  ${tr && tr.domains ? `<div class="tbl"><table><tr><th>Dominio</th><th>Alta</th><th>Registrador</th><th>Nameservers</th><th>Hermanos (CT)</th></tr>${tr.domains.map(d => `<tr><td class="mono">${esc(d.domain)} ${d.newDomain ? '<span class="pill bad">nuevo</span>' : ''}</td><td>${d.rdap && d.rdap.created ? `${fmtD(d.rdap.created)}<div class="small mut">${d.ageDays} días</div>` : '—'}</td><td>${esc((d.rdap && d.rdap.registrar) || '—')}</td><td class="mono small">${esc((d.nameservers || []).join(', ') || '—')}</td><td class="mono small">${d.ct && d.ct.ok ? (d.ct.siblings.length ? d.ct.siblings.map(s => esc(s.domain)).join('<br>') : 'ninguno') : 'sin datos'}</td></tr>`).join('')}</table></div>` : ''}
  ${kids.length ? `<h3>Dominios anexados dinámicamente</h3>${kids.map(k => `<div class="small"><a href="#/exp/${k.childId}">${esc(k.target)}</a> · ${esc(k.reason)} · ${fmt(k.at)}</div>`).join('')}` : ''}
  ${c.demo && c.signature ? `<div class="row noprint" style="margin-top:10px"><button class="ghost" onclick="demoAnnex('${c.id}')">Simular dominio nuevo con el mismo host de video</button></div>` : ''}</div>

  <div class="card step ${c.estado === 'en_cola_juez' || c.estado === 'firmado' ? 'done' : c.estado === 'revision_humana' ? 'warn' : c.estado === 'rechazado' ? 'bad' : ''}"><div class="fig">PASO 9.0</div><h2>Oráculo: filtro de consenso ${estadoPill(c)}</h2>
  <p class="small mut">Las cuatro señales tienen que coincidir para molestar al juez. Si falla alguna, pasa a revisión humana y no entra a la cola.</p>
  ${par ? `<div class="verdict ok">Anexado a <a href="#/exp/${par.id}">${esc(par.num)}</a> (ya firmado): no se abre un expediente nuevo.</div>` : ''}
  <label>Jurisdicción</label>${c.seal ? `<div>${esc(caseJur(c))}</div>` : `<select onchange="setJur('${c.id}',this.value)">${JURIS.map(x => `<option ${x === caseJur(c) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`}
  <div class="small mut" style="margin-top:6px">Juez competente ahora (calculado por turno): <b style="color:#fff">${j ? esc(j.name) : 'ninguno'}</b></div>
  ${cs ? checksHtml(cs) + (c.consensus ? `<div class="small mut">Evaluado ${fmt(c.consensus.at)}</div>` : '<div class="small mut">Vista previa: el oráculo todavía no corrió.</div>') : ''}
  ${c.probe && c.probe.points ? `<details><summary>Reproducción multipunto (${esc(c.probe.service || '')})</summary><div class="tbl"><table><tr><th>Punto</th><th>ASN</th><th>Resultado</th><th>IP vista</th></tr>${c.probe.points.map(p => `<tr><td>${esc(p.country)} · ${esc(p.city || '')}</td><td>${esc(p.nodeAsn || '')}</td><td>${p.ok ? '<span class="pill ok">' + esc(p.status) + '</span>' : '<span class="pill bad">' + esc(p.status || p.message) + '</span>'}</td><td class="mono">${esc(p.resolvedIp || '—')}</td></tr>`).join('')}</table></div>${c.probe.permalink ? `<a href="${esc(c.probe.permalink)}" target="_blank" rel="noopener">Informe público de check-host</a>` : ''}</details>` : ''}
  <div id="orStatus"></div>
  ${!c.seal && !par ? `<div class="row noprint" style="margin-top:10px"><button onclick="runOracle('${c.id}')" ${c.analysis ? '' : 'disabled'}>Correr el oráculo</button></div>` : ''}</div>

  <div class="card step ${c.signature ? (vs && vs.ok ? 'done' : 'bad') : ''}"><div class="fig">PASO 10.0</div><h2>Firma del juez de turno</h2>
  ${c.signature ? `<div class="verdict ${vs.ok ? 'ok' : 'bad'}">${vs.ok ? '✔' : '✖'} ${esc(vs.t)}</div><table><tr><th>Juez</th><td>${esc(c.signature.juez)}<div class="small mut">${esc(c.signature.juzgado)}</div></td></tr><tr><th>Fecha</th><td>${fmt(c.signature.ts)}</td></tr><tr><th>Algoritmo</th><td>${esc(c.signature.alg)}</td></tr><tr><th>Firma</th><td class="mono small">${esc(c.signature.sig)}</td></tr></table>`
    : c.rejection ? `<div class="verdict bad">Rechazado por ${esc(c.rejection.juez)} · ${fmt(c.rejection.ts)}: ${esc(c.rejection.why)}</div>`
    : c.estado === 'en_cola_juez' ? `<p>En la cola de <b>${j ? esc(j.name) : 'ningún juez (sin turno activo)'}</b>. <a href="#/juez">Abrir cola</a></p>` : '<p class="small mut">Se firma el sha256 del expediente congelado junto con el juez y la hora. Si el expediente cambia después, la firma deja de verificar.</p>'}</div>`;
}

window.demoAnnex = async (pid) => {
  const p = getCase(pid); DB.seq++;
  const c = JSON.parse(JSON.stringify(p));
  Object.assign(c, { id: uid(), num: `EXP-${new Date().getFullYear()}-${String(DB.seq).padStart(4, '0')}`, createdAt: new Date().toISOString(), version: 1, target: 'https://futbol-libre-demo.example/vivo', seal: null, signature: null, estado: null, consensus: null, trace: null, probe: null, history: [], captures: [], notes: 'Dominio nuevo de demostración: mismo host de video que ' + p.num });
  c.analysis.target = c.target; c.analysis.hosts = c.analysis.hosts.map(h => h.roles.includes('pagina') ? { ...h, host: 'futbol-libre-demo.example', a: ['192.0.2.44'], ips: [{ ...h.ips[0], ip: '192.0.2.44' }] } : h);
  DB.cases.push(c); save(); await audit('expediente_creado', c.id, `${c.num} ${c.target} (demo)`);
  location.hash = '#/exp/' + c.id; setTimeout(() => runOracle(c.id), 300);
};

/* --- Vista: juez de turno --- */
async function vJuez(_, qs) {
  ensureDB(); await checkHandover();
  const j = judgeById(DB.settings.actingJudge), turns = j ? activeTurnos(j.id) : [], jurs = turns.map(t => t.jurisdiccion);
  const queue = DB.cases.filter(c => c.estado === 'en_cola_juez' && jurs.includes(caseJur(c))).sort((a, b) => minutesLeft(a.match) - minutesLeft(b.match));
  const hl = qs.get('exp');
  const card = (c) => { const dh = deliveryOf(c); return `<div class="card qcard ${c.id === hl ? 'hl' : ''}"><div class="row sp"><b>${esc(c.num)}</b><span class="pill ${isLive(c.match) ? 'bad' : ''}">${esc(liveLabel(c.match))}</span></div>
    <div class="qmatch">${crest(c.match.home)}${crest(c.match.away)}<div><b>${esc(matchName(c.match))}</b><div class="small mut">${esc(caseJur(c))}</div></div></div>
    <table><tr><th>Sitio</th><td class="mono">${esc(hostOf(c.target))}</td></tr><tr><th>Video</th><td class="mono">${esc(dh ? dh.host + ' · ' + dh.a.join(', ') : '—')}</td></tr><tr><th>Medida</th><td>${(c.expiry ? c.expiry.items : []).map(it => `${esc(it.method)} → ${esc(objetivo(it.target))}${it.until ? ' hasta ' + fmtD(it.until) : ''}`).join('<br>')}</td></tr><tr><th>sha256</th><td class="mono small">${esc(c.seal.sha256)}</td></tr></table>
    <h3>Por qué llegó</h3>${checksHtml(c.consensus)}
    <div class="row"><button onclick="signCase('${c.id}')">Firmar</button><button class="ghost" onclick="rejectCase('${c.id}')">Rechazar</button><a href="#/exp/${c.id}">Ver expediente</a></div></div>`; };
  const claims = DB.claims.filter(x => x.estado === 'pendiente');
  return `${hero('Juez de turno', 've solo lo que corresponde a su jurisdicción mientras dura su turno. La cola se ordena por los minutos que le quedan al partido.')}
  <div class="card"><label>Actuás como (modo local, sin login)</label><select onchange="setActing(this.value)">${DB.judges.map(x => `<option value="${x.id}" ${x.id === DB.settings.actingJudge ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
  <p class="small">${turns.length ? `Turno activo: ${turns.map(t => `<b>${esc(t.jurisdiccion)}</b> hasta ${fmt(t.hasta)}`).join(' · ')}` : '<span class="pill bad">Sin turno activo</span> No podés leer ni firmar expedientes.'}</p></div>
  ${sec(`Cola en vivo (${queue.length})`, queue.length ? queue.map(card).join('') : '<p>No hay expedientes esperando firma en tu jurisdicción.</p>')}
  ${claims.length && turns.length ? sec('Reclamos pendientes', claims.map(x => { const o = DB.orders.find(o => o.id === x.orderId); return `<div class="card"><b>${esc(x.dominio)}</b> · ${fmt(x.at)}<div class="small">${esc(x.motivo)}</div><div class="small mut">Orden: ${o ? esc(o.num + ' · ' + o.objetivo) : 'no identificada'}</div><div class="row" style="margin-top:8px">${o ? `<button onclick="resolveClaim('${x.id}',true)">Levantar bloqueo</button>` : ''}<button class="ghost" onclick="resolveClaim('${x.id}',false)">Rechazar reclamo</button></div></div>`; }).join('')) : ''}
  ${sec('Turnos', `<div class="card"><div class="tbl"><table><tr><th>Jurisdicción</th><th>Juez competente ahora</th></tr>${JURIS.map(x => `<tr><td>${esc(x)}</td><td>${esc((juezCompetente(x) || {}).name || '—')}</td></tr>`).join('')}</table></div>
   <h3>Turnos cargados</h3><div class="tbl"><table><tr><th>Juez</th><th>Jurisdicción</th><th>Desde</th><th>Hasta</th><th></th></tr>${DB.turnos.slice().sort((a, b) => a.desde.localeCompare(b.desde)).map(t => `<tr><td>${esc((judgeById(t.juez_id) || {}).name || '?')}</td><td>${esc(t.jurisdiccion)}</td><td>${fmt(t.desde)}</td><td>${fmt(t.hasta)}</td><td><button class="ghost" onclick="delTurno('${t.id}')">×</button></td></tr>`).join('')}</table></div>
   <div class="grid"><div><label>Juez</label><select id="tJ">${DB.judges.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div><div><label>Jurisdicción</label><select id="tR">${JURIS.map(x => `<option>${esc(x)}</option>`).join('')}</select></div><div><label>Desde</label><input id="tD" type="datetime-local"></div><div><label>Hasta</label><input id="tH" type="datetime-local"></div></div>
   <div class="row" style="margin-top:10px"><button onclick="addTurno()">Agregar turno</button></div>
   <h3>Jueces</h3>${DB.judges.map(x => `<div class="small">${esc(x.name)} · ${esc(x.juzgado)}${x.keys ? ` · clave ${esc(x.keys.alg)}` : ''}${x.contacto ? ' · ' + esc(x.contacto) : ''}</div>`).join('')}
   <div class="grid"><div><label>Nombre</label><input id="jN"></div><div><label>Juzgado</label><input id="jZ"></div><div><label>WhatsApp o mail</label><input id="jC"></div></div>
   <div class="row" style="margin-top:10px"><button class="ghost" onclick="addJudge()">Agregar juez</button></div>
   <h3>Aviso (n8n)</h3><label>URL del webhook de n8n</label><input id="wh" value="${esc(DB.settings.webhook || '')}" placeholder="https://tu-n8n/webhook/expedientes" onchange="setWebhook(this.value)"><p class="small mut">Cuando un expediente entra a la cola se manda un POST con el número, el juez de turno, su contacto y el link directo a la tarjeta.</p></div>`)}`;
}
vJuez.after = () => {};
window.setActing = (v) => { DB.settings.actingJudge = v; save(); route(); };
window.setWebhook = async (v) => { DB.settings.webhook = v.trim(); save(); await audit('webhook_configurado', null, v ? 'configurado' : 'borrado'); toast('Guardado'); };
window.addJudge = async () => { const n = $('#jN').value.trim(); if (!n) return toast('Poné el nombre'); DB.judges.push({ id: 'j-' + uid(), name: n, juzgado: $('#jZ').value.trim(), contacto: $('#jC').value.trim() }); save(); await audit('juez_agregado', null, n); route(); };
window.addTurno = async () => {
  const d = $('#tD').value, h = $('#tH').value; if (!d || !h) return toast('Completá desde y hasta');
  const t = { id: uid(), juez_id: $('#tJ').value, jurisdiccion: $('#tR').value, desde: new Date(d + ':00-03:00').toISOString(), hasta: new Date(h + ':00-03:00').toISOString() };
  if (t.hasta <= t.desde) return toast('Hasta debe ser posterior');
  DB.turnos.push(t); save(); await audit('turno_agregado', null, `${judgeById(t.juez_id).name} · ${t.jurisdiccion} · ${t.desde} → ${t.hasta}`); route();
};
window.delTurno = async (id) => { const t = DB.turnos.find(x => x.id === id); DB.turnos = DB.turnos.filter(x => x.id !== id); save(); await audit('turno_borrado', null, `${(judgeById(t.juez_id) || {}).name} · ${t.jurisdiccion}`); route(); };
window.resolveClaim = async (id, accept) => {
  const x = DB.claims.find(c => c.id === id), j = judgeById(DB.settings.actingJudge);
  x.estado = accept ? 'aceptado' : 'rechazado'; x.resueltoAt = new Date().toISOString(); x.juez = j && j.name;
  if (accept) { const o = DB.orders.find(o => o.id === x.orderId); if (o) { o.estado = 'levantada'; o.levantadaAt = x.resueltoAt; } }
  save(); await audit('reclamo_' + x.estado, null, `${x.dominio} · ${j ? j.name : ''}`); route();
};

/* --- Vista: orígenes --- */
async function vOrigenes() {
  const groups = (keyFn) => { const m = new Map(); for (const c of DB.cases) for (const k of keyFn(c)) { if (!k) continue; const e = m.get(k) || new Set(); e.add(c); m.set(k, e); } return [...m.entries()].map(([k, s]) => [k, [...s]]).sort((a, b) => b[1].length - a[1].length); };
  const byVideo = groups(c => [c.analysis && c.analysis.deliveryHost]);
  const bySess = groups(c => [c.watermark && c.watermark.verdict === 'ok' ? `${c.watermark.licensee ? c.watermark.licensee.name : c.watermark.payload.split('-')[2]} · sesión ${c.watermark.payload.split('-')[3]}` : null]);
  const byNs = groups(c => ((c.trace && c.trace.domains) || []).map(d => (d.nameservers || []).slice().sort().join(' + ')));
  const byAsn = groups(c => ((c.analysis && c.analysis.hosts) || []).flatMap(h => h.ips.filter(i => i.kind !== 'cdn' && i.kind !== 'cloud' && i.asn).map(i => `AS${i.asn} ${i.holder || ''}`)));
  const fresh = DB.cases.flatMap(c => ((c.trace && c.trace.domains) || []).filter(d => d.newDomain).map(d => [d, c]));
  const sibs = DB.cases.flatMap(c => ((c.trace && c.trace.domains) || []).flatMap(d => ((d.ct && d.ct.siblings) || []).map(s => [s.domain, d.domain, c])));
  const tbl = (rows, head, fn) => rows.length ? `<div class="card"><div class="tbl"><table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map(fn).join('')}</table></div></div>` : '<p>Sin datos todavía.</p>';
  const pages = (cs) => cs.map(c => `<a href="#/exp/${c.id}">${esc(hostOf(c.target))}</a>`).join('<br>');
  return `${hero('Orígenes', 'agrupa las páginas por la infraestructura que comparten. Si veinte páginas tiran del mismo video, bloqueás un host y caen las veinte.')}
  ${sec('Host de video', tbl(byVideo, ['Host', 'Páginas', 'Impacto'], ([k, cs]) => `<tr><td class="mono">${esc(k)}</td><td>${pages(cs)}</td><td><span class="pill ${cs.length > 1 ? 'bad' : ''}">${cs.length} página(s)</span></td></tr>`))}
  ${sec('Fuga (marca de agua)', tbl(bySess, ['Licenciatario y sesión', 'Páginas'], ([k, cs]) => `<tr><td>${esc(k)}</td><td>${pages(cs)}</td></tr>`))}
  ${sec('Nameservers', tbl(byNs, ['Nameservers', 'Páginas'], ([k, cs]) => `<tr><td class="mono small">${esc(k)}</td><td>${pages(cs)}</td></tr>`))}
  ${sec('Operador (ASN, sin CDN)', tbl(byAsn, ['ASN', 'Páginas'], ([k, cs]) => `<tr><td>${esc(k)}</td><td>${pages(cs)}</td></tr>`))}
  ${sec('Dominios nuevos', tbl(fresh, ['Dominio', 'Alta', 'Expediente'], ([d, c]) => `<tr><td class="mono">${esc(d.domain)}</td><td>${d.ageDays} días</td><td><a href="#/exp/${c.id}">${esc(c.num)}</a></td></tr>`))}
  ${sec('Hermanos por certificado', tbl(sibs, ['Dominio hermano', 'Visto junto a', 'Expediente'], ([s, d, c]) => `<tr><td class="mono">${esc(s)}</td><td class="mono">${esc(d)}</td><td><a href="#/exp/${c.id}">${esc(c.num)}</a></td></tr>`))}`;
}

/* --- Vista pública: transparencia --- */
const orderStatus = (o) => o.estado === 'levantada' ? ['bad', 'Levantada por reclamo'] : o.hasta && new Date(o.hasta) < Date.now() ? ['', 'Vencida'] : ['ok', 'Vigente'];
function publicRegistry() {
  const head = DB.audit.length ? DB.audit[DB.audit.length - 1] : null;
  return { generadoAt: new Date().toISOString(), cabeceraAuditoria: head ? { evento: head.i, hash: head.hash } : null,
    ordenes: DB.orders.map(o => ({ orden: o.num, objetivo: o.objetivo, tipo: o.tipo, desde: o.firmadaAt, hasta: o.hasta, juzgado: o.juzgado, estado: orderStatus(o)[1], origen: o.origen })) };
}
async function vTransparencia(_, qs) {
  const reg = publicRegistry(), q = (qs.get('q') || '').toLowerCase();
  const os = DB.orders.filter(o => !q || o.objetivo.toLowerCase().includes(q)).slice().reverse();
  return `${hero('Registro público', 'de cada bloqueo ordenado: qué, cuándo, por qué juzgado y hasta cuándo. Sin evidencia ni datos de quien reportó.')}
  <div class="card"><div class="fig">Cabecera de la cadena de auditoría</div><div class="mono">${reg.cabeceraAuditoria ? `#${reg.cabeceraAuditoria.evento} · ${esc(reg.cabeceraAuditoria.hash)}` : '—'}</div><p class="small mut">Si alguien reescribe el historial, este hash cambia. Compará con el publicado anteriormente.</p>
  <div class="row"><input id="tq" placeholder="Buscar dominio o IP" value="${esc(q)}" style="flex:1"><button onclick="go('#/transparencia?q='+encodeURIComponent($('#tq').value))">Buscar</button><button class="ghost" onclick="download('registro-publico.json', JSON.stringify(publicRegistry(),null,1))">Descargar JSON</button></div></div>
  <div class="card"><div class="tbl"><table><tr><th>Orden</th><th>Qué se bloqueó</th><th>Tipo</th><th>Juzgado</th><th>Desde</th><th>Hasta</th><th>Estado</th></tr>${os.map(o => { const [cl, t] = orderStatus(o); return `<tr><td>${esc(o.num)}</td><td class="mono">${esc(o.objetivo)}${o.origen && o.origen !== 'firma' ? `<div class="small mut">${esc(o.origen)}</div>` : ''}</td><td>${esc(o.tipo)}</td><td>${esc(o.juzgado)}</td><td>${fmt(o.firmadaAt)}</td><td>${o.hasta ? fmtD(o.hasta) : '—'}</td><td><span class="pill ${cl}">${t}</span></td></tr>`; }).join('') || '<tr><td colspan="7" class="mut">Sin órdenes.</td></tr>'}</table></div></div>
  ${sec('¿Te bloquearon por error?', `<div class="card"><p class="small">Si tu sitio fue bloqueado por error, dejá el reclamo. Lo revisa el juez de turno de esa jurisdicción.</p><label>Tu dominio</label><input id="rD" placeholder="misitio.com.ar"><label>Contacto (no se publica)</label><input id="rC" placeholder="mail o teléfono"><label>Motivo</label><textarea id="rM"></textarea><div class="row" style="margin-top:10px"><button onclick="submitClaim()">Mi sitio fue bloqueado por error</button></div></div>`)}`;
}
window.submitClaim = async () => {
  const d = hostOf($('#rD').value.trim()); if (!d) return toast('Poné tu dominio');
  const o = DB.orders.find(o => o.estado !== 'levantada' && (o.objetivo === d || o.objetivo.endsWith('.' + d) || d.endsWith('.' + o.objetivo)));
  DB.claims.push({ id: uid(), dominio: d, contacto: $('#rC').value.trim(), motivo: $('#rM').value.trim(), at: new Date().toISOString(), estado: 'pendiente', orderId: o ? o.id : null });
  save(); await audit('reclamo_recibido', o ? o.caseId : null, `${d}${o ? ' · ' + o.num : ' · sin orden asociada'}`); toast('Reclamo enviado'); route();
};

/* --- Registro --- */
ensureDB();
Object.assign(routes, { juez: vJuez, origenes: vOrigenes, transparencia: vTransparencia });
window.addEventListener('storage', (e) => { if (e.key === DB_KEY) { DB = load(); ensureDB(); route(); } });
setInterval(() => { checkHandover(); if (/^#\/juez/.test(location.hash) && !document.activeElement.matches('input,select,textarea')) route(); }, 30000);
