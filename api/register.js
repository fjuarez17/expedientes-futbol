// POST /api/register {email, password, nombre, juzgado, jurisdiccion}
// Crea la cuenta (Supabase Auth) y la ficha en `jueces` con la service key, que nunca sale del servidor.
// El juez queda registrado pero SIN turno: hasta que un administrador le asigne uno en la tabla `turnos`,
// la base no le deja leer ni firmar expedientes (RLS).
const URL = process.env.SUPABASE_URL || 'https://susewsmgbmkkfppncmlz.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!KEY) return res.status(500).json({ error: 'SUPABASE_SECRET_KEY no configurada' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const nombre = String(b.nombre || '').trim();
  const juzgado = String(b.juzgado || '').trim();
  const contacto = String(b.contacto || '').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Mail inválido' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres' });
  if (!nombre || !juzgado) return res.status(400).json({ error: 'Faltan nombre y juzgado' });
  const h = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  try {
    const r1 = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: h, body: JSON.stringify({ email, password, email_confirm: true }) });
    const u = await r1.json();
    if (!r1.ok) return res.status(400).json({ error: u.msg || u.message || 'No se pudo crear la cuenta' });
    const r2 = await fetch(`${URL}/rest/v1/jueces`, { method: 'POST', headers: h, body: JSON.stringify({ id: u.id, nombre, juzgado, contacto }) });
    if (!r2.ok) {
      const e = await r2.json();
      await fetch(`${URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: h }); // no dejar cuenta sin ficha
      return res.status(400).json({ error: e.message || 'No se pudo crear la ficha de juez' });
    }
    return res.status(200).json({ ok: true, email, nombre });
  } catch (e) { return res.status(502).json({ error: 'Supabase no respondió: ' + e.message }); }
};
