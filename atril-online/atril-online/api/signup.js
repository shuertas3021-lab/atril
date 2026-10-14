import { accountsOn, safeEqual, sb, fail } from './_lib.js';

const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 10 * 60 * 1000);
  t.push(now); tries.set(ip, t);
  return t.length > 10;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Usa POST.');
  if (!accountsOn()) return fail(res, 503, 'not_configured', 'Las cuentas todavía no están configuradas en el servidor.');
  if (!process.env.INVITE_CODE) return fail(res, 503, 'not_configured', 'Falta el código de invitación en el servidor (INVITE_CODE).');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'x';
  if (tooMany(ip)) return fail(res, 429, 'rate_limited', 'Demasiados intentos. Espera unos minutos.');

  const { email = '', password = '', name = '', invite = '' } = req.body || {};
  const mail = String(email).trim().toLowerCase();
  if (!safeEqual(String(invite).trim(), process.env.INVITE_CODE.trim())) return fail(res, 403, 'bad_invite', 'El código de invitación no es correcto.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) return fail(res, 400, 'bad_email', 'Revisa tu correo: parece incompleto.');
  if (String(password).length < 8) return fail(res, 400, 'weak_password', 'La contraseña debe tener al menos 8 caracteres.');

  const r = await sb('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: mail, password: String(password), email_confirm: true, user_metadata: { name: String(name).trim().slice(0, 80) } }),
  });
  if (r.ok) return res.status(200).json({ ok: true });
  const detail = await r.text();
  if (/already|exists|registered/i.test(detail)) return fail(res, 409, 'email_exists', 'Ya existe una cuenta con ese correo. Entra con tu contraseña.');
  if (/password/i.test(detail)) return fail(res, 400, 'weak_password', 'Esa contraseña es demasiado débil. Usa una más larga.');
  console.error('[signup]', r.status, detail.slice(0, 500));
  return fail(res, 502, 'provider_error', 'No se pudo crear la cuenta. Intenta de nuevo.');
}
