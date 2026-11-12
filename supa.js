'use strict';
/* ===== Conexión a Supabase: login, publicación a la cola, cola Realtime, firma remota y registro público ===== */
const SUPA_URL = 'https://susewsmgbmkkfppncmlz.supabase.co';
const SUPA_KEY = 'sb_publishable_d_5FKenY7diHXbza2M_v1g_0hG_AWVY';
const sb = window.supabase ? window.supabase.createClient(SUPA_URL, SUPA_KEY) : null;
let SESSION = null, ME_JUEZ = null, RT = null;

async function refreshSession() {
  if (!sb) return;
  SESSION = (await sb.auth.getSession()).data.session;
  ME_JUEZ = null;
  if (SESSION) { const { data } = await sb.from('jueces').select('*').eq('id', SESSION.user.id).maybeSingle(); ME_JUEZ = data || null; }
  if (RT) { sb.removeChannel(RT); RT = null; }
  if (ME_JUEZ) RT = sb.channel('cola').on('postgres_changes', { event: '*', schema: 'public', table: 'expedientes' }, () => { if (/^#\/juez/.test(location.hash)) route(); }).subscribe();
}
async function remoteAudit(accion, expediente_id, detalle) { if (sb && SESSION) await sb.from('auditoria').insert({ accion, expediente_id: expediente_id || null, detalle: detalle || '' }); }

/* Publicar a la cola compartida cuando el oráculo da consenso */
async function publishRemote(c) {
  if (!sb || !SESSION || c.remoteId || c.estado !== 'en_cola_juez') return;
  const dh = c.analysis && c.analysis.deliveryHost;
  const { data, error } = await sb.from('expedientes').insert({ numero: c.num + '-' + c.id.slice(0, 4), partido: c.match, kickoff: c.match.kickoff, jurisdiccion: caseJur(c), objetivo: hostOf(c.target), host_video: dh || null, estado: 'en_cola_juez', consenso: c.consensus, contenido: sealPayload(c), sha256: c.seal.sha256, tsa: c.seal.tsa || null, reportado_por: SESSION.user.id }).select('id').single();
  if (error) return toast('No se pudo publicar: ' + error.message);
  c.remoteId = data.id; save();
  await remoteAudit('expediente_en_cola', data.id, `${c.num} · ${caseJur(c)} · sha256=${c.seal.sha256}`);
  await audit('publicado_supabase', c.id, data.id); toast('Publicado en la cola compartida');
}
const _runOracle = window.runOracle;
window.runOracle = async (id) => { await _runOracle(id); const c = getCase(id); if (c) await publishRemote(c); };
window.publishCase = async (id) => { await publishRemote(getCase(id)); route(); };

/* Firma remota */
async function myKeys() {
  const k = 'xf_key_' + SESSION.user.id; let keys = JSON.parse(localStorage.getItem(k) || 'null');
  if (!keys) { const tmp = { name: ME_JUEZ.nombre }; keys = await ensureKeys(tmp); localStorage.setItem(k, JSON.stringify(keys)); }
  return keys;
}
window.signRemote = async (id) => {
  const { data: e, error } = await sb.from('expedientes').select('*').eq('id', id).single();
  if (error) return toast(error.message);
  if (await sha256Hex(stable(e.contenido)) !== e.sha256) return toast('El contenido no coincide con el hash congelado');
  const k = await myKeys(); const [imp, sp] = algParams(k.alg);
  const priv = await crypto.subtle.importKey('jwk', k.priv, imp, false, ['sign']);
  const s = { sha256: e.sha256, juez_id: ME_JUEZ.id, ts: new Date().toISOString() };
  const sig = b64(await crypto.subtle.sign(sp, priv, sigMessage(s)));
  const f = await sb.from('firmas').insert({ expediente_id: id, juez_id: ME_JUEZ.id, sha256: e.sha256, ts: s.ts, alg: k.alg, firma: JSON.stringify({ sig, pub: k.pub }) });
  if (f.error) return toast('Firma rechazada: ' + f.error.message);
  const items = ((e.contenido.expiry && e.contenido.expiry.items) || []).filter(it => it.method !== 'NO bloquear por IP');
  let n = 0;
  for (const it of items) { const r = await sb.from('ordenes').insert({ numero: 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + (++n), expediente_id: id, objetivo: objetivo(it.target), tipo: it.method, juzgado: ME_JUEZ.juzgado, firmada_at: s.ts, hasta: it.until || null }); if (r.error) toast(r.error.message); }
  await sb.from('expedientes').update({ estado: 'firmado' }).eq('id', id);
  await remoteAudit('expediente_firmado', id, `${ME_JUEZ.nombre} · ${k.alg} · sha256=${e.sha256}`);
  toast('Firmado: ' + n + ' orden(es) publicadas'); route();
};
window.rejectRemote = async (id) => {
  const why = prompt('Motivo del rechazo'); if (why == null) return;
  const r = await sb.from('expedientes').update({ estado: 'rechazado' }).eq('id', id); if (r.error) return toast(r.error.message);
  await remoteAudit('expediente_rechazado', id, `${ME_JUEZ.nombre}: ${why}`); route();
};

async function remoteJudge() {
  if (!sb) return '';
  if (!SESSION) return `<div class="card"><div class="fig">Modo compartido (Supabase)</div><p>Para ver la cola compartida entre jueces, <a href="#/acceso">iniciá sesión</a>. Abajo sigue el modo local.</p></div>`;
  if (!ME_JUEZ) return `<div class="card"><div class="fig">Modo compartido (Supabase)</div><p>${esc(SESSION.user.email)} no es juez: no ve la cola.</p></div>`;
  const now = new Date().toISOString();
  const { data: turnos } = await sb.from('turnos').select('*').lte('desde', now).gte('hasta', now);
  const { data: cola, error } = await sb.from('expedientes').select('id,numero,partido,kickoff,jurisdiccion,objetivo,host_video,consenso,sha256,contenido').eq('estado', 'en_cola_juez');
  const rows = (cola || []).sort((a, b) => minutesLeft(a.partido) - minutesLeft(b.partido));
  const card = (e) => `<div class="card qcard"><div class="row sp"><b>${esc(e.numero)}</b><span class="pill ${isLive(e.partido) ? 'bad' : ''}">${esc(liveLabel(e.partido))}</span></div>
    <div class="qmatch">${crest(e.partido.home)}${crest(e.partido.away)}<div><b>${esc(matchName(e.partido))}</b><div class="small mut">${esc(e.jurisdiccion)}</div></div></div>
    <table><tr><th>Sitio</th><td class="mono">${esc(e.objetivo)}</td></tr><tr><th>Video</th><td class="mono">${esc(e.host_video || '—')}</td></tr><tr><th>Medida</th><td>${((e.contenido.expiry && e.contenido.expiry.items) || []).map(it => `${esc(it.method)} → ${esc(objetivo(it.target))}`).join('<br>')}</td></tr><tr><th>sha256</th><td class="mono small">${esc(e.sha256)}</td></tr></table>
    <h3>Por qué llegó</h3>${e.consenso ? checksHtml(e.consenso) : ''}
    <div class="row"><button onclick="signRemote('${e.id}')">Firmar</button><button class="ghost" onclick="rejectRemote('${e.id}')">Rechazar</button></div></div>`;
  return `<div class="card"><div class="fig">Modo compartido (Supabase) · en vivo</div><p><b>${esc(ME_JUEZ.nombre)}</b> · ${esc(ME_JUEZ.juzgado)}</p>
    <p class="small">${(turnos || []).length ? 'Turno activo: ' + turnos.map(t => `<b>${esc(t.jurisdiccion)}</b> hasta ${fmt(t.hasta)}`).join(' · ') : '<span class="pill bad">Sin turno activo</span> La base no te deja leer ni firmar.'}</p></div>
    ${sec(`Cola compartida (${rows.length})`, error ? `<p>${esc(error.message)}</p>` : rows.length ? rows.map(card).join('') : '<p>No hay expedientes esperando firma en tu jurisdicción.</p>')}`;
}
async function remoteRegistry() {
  if (!sb) return '';
  const [{ data: os, error }, { data: head }] = await Promise.all([sb.from('registro_publico').select('*').order('desde', { ascending: false }).limit(200), sb.from('cabecera_auditoria').select('*')]);
  if (error) return '';
  const h = head && head[0];
  return `<div class="card"><div class="fig">Registro compartido (Supabase)</div><div class="mono small">Cabecera de auditoría: ${h ? `#${h.evento} · ${esc(h.hash)}` : '—'}</div>
  <div class="tbl"><table><tr><th>Orden</th><th>Qué se bloqueó</th><th>Tipo</th><th>Juzgado</th><th>Desde</th><th>Hasta</th><th>Estado</th></tr>${(os || []).map(o => `<tr><td>${esc(o.orden)}</td><td class="mono">${esc(o.objetivo)}</td><td>${esc(o.tipo)}</td><td>${esc(o.juzgado)}</td><td>${fmt(o.desde)}</td><td>${o.hasta ? fmtD(o.hasta) : '—'}</td><td><span class="pill ${o.estado === 'vigente' ? 'ok' : o.estado === 'vencida' ? '' : 'bad'}">${esc(o.estado)}</span></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Sin órdenes.</td></tr>'}</table></div></div>`;
}
const _submitClaim = window.submitClaim;
window.submitClaim = async () => {
  if (sb) { const d = hostOf($('#rD').value.trim()); if (d) { const r = await sb.from('reclamos').insert({ dominio: d, contacto: $('#rC').value.trim(), motivo: $('#rM').value.trim() }); if (r.error) toast('Reclamo remoto: ' + r.error.message); } }
  await _submitClaim();
};

async function vAcceso() {
  if (SESSION) return `${hero('Acceso', 'con tu cuenta. Los permisos los decide la base: un juez solo ve su jurisdicción mientras dura su turno.')}<div class="card"><p>Sesión iniciada como <b>${esc(SESSION.user.email)}</b>${ME_JUEZ ? ' · juez' : ' · reportante'}</p><div class="row"><button class="ghost" onclick="logout()">Cerrar sesión</button>${ME_JUEZ ? '<a href="#/juez">Ir a la cola</a>' : ''}</div></div>`;
  return `${hero('Acceso', 'para jueces y reportantes. Sin sesión la plataforma funciona en modo local, solo en este teléfono.')}<div class="card"><label>Mail</label><input id="lE" type="email" autocomplete="username"><label>Contraseña</label><input id="lP" type="password" autocomplete="current-password"><div class="row" style="margin-top:10px"><button onclick="login()">Entrar</button></div></div>`;
}
window.login = async () => { const { error } = await sb.auth.signInWithPassword({ email: $('#lE').value.trim(), password: $('#lP').value }); if (error) return toast(error.message); await refreshSession(); await audit('login', null, SESSION.user.email); go(ME_JUEZ ? '#/juez' : '#/panel'); };
window.logout = async () => { await sb.auth.signOut(); await refreshSession(); route(); };

const wrap = (name, pre, after) => { const f = routes[name]; const g = async (...a) => (await pre(...a)) + (await f(...a)); g.after = f.after; routes[name] = g; };
wrap('juez', remoteJudge); wrap('transparencia', remoteRegistry);
routes.acceso = vAcceso;
if (sb) { sb.auth.onAuthStateChange(() => {}); refreshSession().then(() => { if (/^#\/(juez|acceso)/.test(location.hash)) route(); }); }
