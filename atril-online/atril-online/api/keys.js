// Atril · guarda, cambia o quita las llaves de IA de cada persona en su cuenta (cifradas).
import { accountsOn, authenticate, fail, AI_PROVIDERS, getStoredKeys, saveStoredKeys, publicKeys, sealKey, maskKey } from './_lib.js';

const FORMAT = {
  claude: [/^sk-ant-[\w-]{20,300}$/, 'Tu llave de Claude debe empezar con sk-ant-.'],
  openai: [/^sk-[\w-]{20,400}$/, 'Tu llave de ChatGPT debe empezar con sk-.'],
  gemini: [/^[\w-]{30,200}$/, 'Tu llave de Gemini no tiene el formato correcto (normalmente empieza con AIza).'],
};
const NAME = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' };

/** Prueba la llave sin gastar: pide la lista de modelos. Devuelve '' si sirve o el mensaje de error. */
async function check(p, key) {
  const req = p === 'claude' ? ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }]
    : p === 'openai' ? ['https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }]
    : ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }];
  const r = await fetch(req[0], { headers: req[1] }).catch(() => null);
  if (!r) return `No se pudo conectar con ${NAME[p]}.`;
  if (r.ok) return '';
  let msg = ''; try { msg = (await r.json()).error.message || ''; } catch {}
  if (r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(msg))) return `Tu llave de ${NAME[p]} no es válida.`;
  return msg || `${NAME[p]} respondió con un error al probar la llave.`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!accountsOn()) return fail(res, 400, 'no_accounts', 'Las llaves en la cuenta requieren el modo con cuentas.');
  const user = await authenticate(req, res);
  if (!user) return;
  const keys = await getStoredKeys(user.id);

  if (req.method === 'GET') return res.status(200).json(publicKeys(keys));

  if (req.method === 'POST') {
    const { provider, key, pref } = req.body || {};
    if (pref !== undefined) {
      if (pref !== null && !AI_PROVIDERS.includes(pref)) return fail(res, 400, 'bad_provider', 'Proveedor desconocido.');
      keys.pref = pref;
    } else {
      if (!AI_PROVIDERS.includes(provider)) return fail(res, 400, 'bad_provider', 'Proveedor desconocido.');
      const v = String(key || '').trim().replace(/\s+/g, '');
      if (!FORMAT[provider][0].test(v)) return fail(res, 400, 'provider_auth', FORMAT[provider][1]);
      const err = await check(provider, v);
      if (err) return fail(res, 400, 'provider_auth', err);
      keys[provider] = { enc: sealKey(v), mask: maskKey(v), at: new Date().toISOString() };
      keys.pref = provider;
    }
    try { await saveStoredKeys(user.id, keys); } catch (e) { return fail(res, 502, 'save_failed', e.message); }
    return res.status(200).json(publicKeys(keys));
  }

  if (req.method === 'DELETE') {
    const provider = (req.query && req.query.provider) || (req.body && req.body.provider);
    if (!AI_PROVIDERS.includes(provider)) return fail(res, 400, 'bad_provider', 'Proveedor desconocido.');
    delete keys[provider];
    if (keys.pref === provider) keys.pref = null;
    try { await saveStoredKeys(user.id, keys); } catch (e) { return fail(res, 502, 'save_failed', e.message); }
    return res.status(200).json(publicKeys(keys));
  }
  return fail(res, 405, 'method', 'Método no permitido.');
}
