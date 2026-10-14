import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();
export const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

/* ---------- Configuración ---------- */
// Acepta la URL aunque la peguen con /rest/v1 o una barra al final: solo se usa el dominio.
const SB_URL = () => { const u = (process.env.SUPABASE_URL || '').trim(); try { return u ? new URL(u).origin : ''; } catch { return u.replace(/\/+$/, ''); } };
export const pubKey = () => process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const secretKey = () => process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
/** Modo cuentas: cada persona se registra con su correo (requiere Supabase). */
export const accountsOn = () => !!(SB_URL() && pubKey() && secretKey());
export const supabasePublic = () => ({ url: SB_URL(), key: pubKey() });

export const providers = () => ({
  google: !!process.env.GOOGLE_TTS_API_KEY,
  azure: !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
  elevenlabs: !!process.env.ELEVENLABS_API_KEY,
});
export const limits = () => ({
  ttsChars: Number(process.env.LIMIT_TTS_CHARS) || 200000,
  aiCalls: Number(process.env.LIMIT_AI_CALLS) || 60,
});
export const month = () => new Date().toISOString().slice(0, 7);

export function fail(res, status, code, error) {
  res.status(status).json({ code, error });
}

/* ---------- Supabase (lado servidor) ---------- */
export function adminHeaders() {
  const k = secretKey();
  const h = { apikey: k, 'content-type': 'application/json' };
  if (k.startsWith('eyJ')) h.Authorization = `Bearer ${k}`; // llaves antiguas (service_role)
  return h;
}
export const sb = (path, opts = {}) =>
  fetch(`${SB_URL()}${path}`, { ...opts, headers: { ...adminHeaders(), ...(opts.headers || {}) } });

const userCache = new Map();
/** Devuelve el usuario de la sesión (o null). La sesión viaja en el encabezado x-atril-token. */
export async function getUser(req) {
  const token = req.headers['x-atril-token'];
  if (!token || !accountsOn()) return null;
  const key = digest(token).toString('hex');
  const hit = userCache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;
  const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: pubKey(), Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  const user = {
    id: u.id,
    email: u.email,
    name: (u.user_metadata && u.user_metadata.name) || '',
    isOwner: isOwnerEmail(u.email),
  };
  userCache.set(key, { user, until: Date.now() + 5 * 60 * 1000 });
  if (userCache.size > 500) userCache.delete(userCache.keys().next().value);
  return user;
}
export const isOwnerEmail = (email) =>
  !!process.env.OWNER_EMAIL && !!email && email.trim().toLowerCase() === process.env.OWNER_EMAIL.trim().toLowerCase();

/** Código de acceso compartido (modo sin cuentas). */
export function passwordOk(req) {
  const need = process.env.APP_PASSWORD;
  if (!need) return true;
  return safeEqual(need, req.headers['x-atril-key'] || '');
}

/**
 * Identifica a quien llama. Con cuentas: exige sesión. Sin cuentas: exige el código de acceso.
 * Responde 401 y devuelve null si no está autorizado.
 */
export async function authenticate(req, res) {
  if (accountsOn()) {
    const user = await getUser(req);
    if (user) return user;
    fail(res, 401, 'unauthorized', 'Inicia sesión para continuar.');
    return null;
  }
  if (passwordOk(req)) return { id: null, isOwner: true };
  fail(res, 401, 'unauthorized', 'Código de acceso incorrecto.');
  return null;
}

/** Suma uso del mes y devuelve el total (o null si no aplica). */
export async function bumpUsage(user, { chars = 0, calls = 0 }) {
  if (!accountsOn() || !user || !user.id) return null;
  try {
    const r = await sb('/rest/v1/rpc/bump_usage', {
      method: 'POST',
      body: JSON.stringify({ p_user: user.id, p_month: month(), p_chars: chars, p_calls: calls }),
    });
    if (!r.ok) { console.error('[usage]', r.status, await r.text()); return null; }
    const j = await r.json();
    return Array.isArray(j) ? j[0] : j;
  } catch (e) { console.error('[usage]', e); return null; }
}
