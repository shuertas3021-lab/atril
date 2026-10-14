// Atril · ChatGPT (OpenAI) con la llave de API de cada persona.
// La llave viaja en el encabezado x-atril-oa-key; aquí no se guarda.
import { bumpUsage, fail } from './_lib.js';

const list = (env, def) => (process.env[env] ? process.env[env].split(',').map((s) => s.trim()).filter(Boolean) : def);
// Si un modelo no existe para esa cuenta se prueba el siguiente de la lista.
const MODELS = {
  quick: () => list('OPENAI_MODELS_QUICK', ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini']),
  default: () => list('OPENAI_MODELS_DEFAULT', ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-4.1', 'gpt-4o']),
  complex: () => list('OPENAI_MODELS_COMPLEX', ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-4.1', 'gpt-4o']),
};
const API = 'https://api.openai.com/v1';
const isModelMissing = (status, msg) => status === 404 || /model[^.]*(does not exist|not found|do not have access)/i.test(msg);
const noReasoning = (msg) => /reasoning_effort|reasoning\.effort|unsupported parameter/i.test(msg);

export function openaiKey(req) {
  const raw = String(req.headers['x-atril-oa-key'] || '').trim();
  return { raw, key: /^sk-[\w-]{20,400}$/.test(raw) ? raw : '' };
}

export async function handleOpenAI(req, res, user) {
  const { raw, key } = openaiKey(req);
  if (raw && !key) return fail(res, 400, 'provider_auth', 'Tu llave de ChatGPT no tiene el formato correcto (empieza con sk-).');
  const apiKey = key || process.env.OPENAI_API_KEY;
  if (!apiKey) return fail(res, 503, 'not_configured', 'Agrega tu llave de ChatGPT en «Mi cuenta → Llave de ChatGPT».');
  const headers = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

  if (req.body && req.body.test) {
    const t = await fetch(`${API}/models`, { headers }).catch(() => null);
    if (!t) return fail(res, 502, 'network', 'No se pudo conectar con OpenAI.');
    if (t.status === 401 || t.status === 403) return fail(res, 400, 'provider_auth', 'Tu llave de ChatGPT no es válida.');
    if (!t.ok) return fail(res, 502, 'provider_error', 'OpenAI respondió con un error al probar la llave.');
    return res.status(200).json({ ok: true, own: true });
  }

  const { input, tier: rawTier, effort } = req.body || {};
  const tier = MODELS[rawTier] ? rawTier : 'default';
  await bumpUsage(user, { calls: 1 }); // solo estadística: paga la cuenta de la persona

  const ctl = new AbortController();
  req.on('close', () => ctl.abort());
  const eff = tier === 'quick' ? 'low' : ['low', 'medium', 'high'].includes(effort) ? effort : tier === 'complex' ? 'high' : null;

  let up = null, model = '', lastMsg = '', lastStatus = 0;
  for (const m of MODELS[tier]()) {
    for (const withEffort of eff ? [true, false] : [false]) {
      const body = { model: m, stream: true, messages: [{ role: 'user', content: input }], max_completion_tokens: tier === 'complex' ? 16000 : 8000 };
      if (withEffort) body.reasoning_effort = eff;
      let r;
      try { r = await fetch(`${API}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal }); }
      catch (e) { return fail(res, 502, 'network', 'No se pudo conectar con OpenAI.'); }
      if (r.ok) { up = r; model = m; break; }
      const detail = await r.text();
      lastStatus = r.status;
      try { lastMsg = JSON.parse(detail).error.message || ''; } catch { lastMsg = detail.slice(0, 300); }
      if (r.status === 400 && withEffort && noReasoning(lastMsg)) continue; // ese modelo no admite «pensamiento»
      if (isModelMissing(r.status, lastMsg)) break; // probar el siguiente modelo
      console.error(`[ai/openai] ${r.status}: ${lastMsg}`);
      if (r.status === 401 || r.status === 403) return fail(res, 502, 'provider_auth', 'Tu llave de ChatGPT no es válida o le faltan permisos.');
      if (r.status === 429 && /quota|billing|credit/i.test(lastMsg)) return fail(res, 402, 'quota', 'Tu cuenta de OpenAI no tiene saldo. Recárgala en platform.openai.com → Billing.');
      if (r.status === 429) return fail(res, 429, 'rate_limited', 'OpenAI alcanzó su límite por ahora. Intenta en un minuto.');
      return fail(res, 502, 'provider_error', lastMsg || 'OpenAI respondió con un error.');
    }
    if (up) break;
  }
  if (!up) {
    console.error(`[ai/openai] sin modelo disponible: ${lastStatus} ${lastMsg}`);
    return fail(res, 502, 'provider_error', 'Tu cuenta de OpenAI no tiene acceso a ninguno de los modelos de Atril.');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Atril-Tier', tier);
  res.setHeader('X-Atril-Model', model);
  res.status(200);
  const reader = up.body.getReader(), dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) { res.write('\u0000ERR:' + (j.error.message || 'Error de OpenAI')); continue; }
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) res.write(t);
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) res.write('\u0000ERR:Se cortó la conexión con OpenAI.');
  }
  res.end();
}
