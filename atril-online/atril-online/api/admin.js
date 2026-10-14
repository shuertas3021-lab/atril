import { randomBytes } from 'node:crypto';
import { accountsOn, getUser, sb, fail, month, limits } from './_lib.js';

export default async function handler(req, res) {
  if (!accountsOn()) return fail(res, 503, 'not_configured', 'Las cuentas no están configuradas.');
  const me = await getUser(req);
  if (!me) return fail(res, 401, 'unauthorized', 'Inicia sesión para continuar.');
  if (!me.isOwner) return fail(res, 403, 'forbidden', 'Solo el dueño de Atril puede ver este panel.');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const [ur, ar] = await Promise.all([
      sb('/auth/v1/admin/users?page=1&per_page=1000'),
      sb(`/rest/v1/usage?month=eq.${month()}&select=user_id,tts_chars,ai_calls`),
    ]);
    if (!ur.ok) return fail(res, 502, 'provider_error', 'No se pudo leer la lista de usuarios.');
    const { users = [] } = await ur.json();
    const usage = ar.ok ? await ar.json() : [];
    const byId = Object.fromEntries(usage.map((u) => [u.user_id, u]));
    return res.status(200).json({
      month: month(),
      limits: limits(),
      users: users
        .map((u) => ({
          id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.name) || '',
          createdAt: u.created_at, lastSignIn: u.last_sign_in_at,
          ttsChars: (byId[u.id] && byId[u.id].tts_chars) || 0, aiCalls: (byId[u.id] && byId[u.id].ai_calls) || 0,
        }))
        .sort((a, b) => (b.lastSignIn || '').localeCompare(a.lastSignIn || '')),
    });
  }

  if (req.method === 'POST') {
    const { action, userId } = req.body || {};
    if (action !== 'reset' || !/^[0-9a-f-]{36}$/i.test(String(userId))) return fail(res, 400, 'bad_request', 'Acción no válida.');
    const temp = randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10);
    const r = await sb(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password: temp }) });
    if (!r.ok) return fail(res, 502, 'provider_error', 'No se pudo cambiar la contraseña.');
    return res.status(200).json({ ok: true, tempPassword: temp });
  }
  return fail(res, 405, 'method', 'Método no permitido.');
}
