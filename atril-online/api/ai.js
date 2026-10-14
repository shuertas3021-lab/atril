import { authenticate, bumpUsage, limits, fail } from './_lib.js';
import { handleOpenAI } from './_openai.js';

const MODELS = {
  quick: () => process.env.AI_MODEL_QUICK || 'claude-haiku-5-5',
  default: () => process.env.AI_MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: () => process.env.AI_MODEL_COMPLEX || 'claude-opus-5-5',
};
const MAX_INPUT = 300_000;

export default async function handler(req, res) {
  const user = await authenticate(req, res);
  if (!user) return;
  if (req.method !== 'POST') return fail(res, 405, 'method', 'Usa POST.');

  // ChatGPT (OpenAI) con la llave de la persona.
  if (req.body && req.body.provider === 'openai') {
    const { input } = req.body;
    if (!req.body.test) {
      if (typeof input !== 'string' || !input.trim()) return fail(res, 400, 'empty', 'No hay nada que enviar a ChatGPT.');
      if (input.length > MAX_INPUT) return fail(res, 413, 'prompt_too_large', 'El material es demasiado largo. Elige menos capítulos o documentos.');
    }
    return handleOpenAI(req, res, user);
  }

  // Llave propia de la persona (la guarda en su navegador y viaja en este encabezado; aquí no se guarda).
  const ownRaw = String(req.headers['x-atril-ai-key'] || '').trim();
  const own = /^sk-ant-[\w-]{20,300}$/.test(ownRaw) ? ownRaw : '';
  if (ownRaw && !own) return fail(res, 400, 'provider_auth', 'Tu llave de Claude no tiene el formato correcto (empieza con sk-ant-).');
  const apiKey = own || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(res, 503, 'not_configured', 'Agrega tu llave de Claude en «Mi cuenta → Llave de Claude».');
  const who = own ? 'Tu llave de Claude' : 'La llave de Anthropic del servidor';

  // Probar la llave sin gastar: lista los modelos.
  if (req.body && req.body.test) {
    const t = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }).catch(() => null);
    if (!t) return fail(res, 502, 'network', 'No se pudo conectar con Claude.');
    if (t.status === 401 || t.status === 403) return fail(res, 400, 'provider_auth', `${who} no es válida.`);
    if (!t.ok) return fail(res, 502, 'provider_error', 'Claude respondió con un error al probar la llave.');
    return res.status(200).json({ ok: true, own: !!own });
  }

  const { input, tier: rawTier, effort } = req.body || {};
  const tier = MODELS[rawTier] ? rawTier : 'default';
  if (typeof input !== 'string' || !input.trim()) return fail(res, 400, 'empty', 'No hay nada que enviar a Claude.');
  if (input.length > MAX_INPUT) return fail(res, 413, 'prompt_too_large', 'El material es demasiado largo. Elige menos capítulos o documentos.');

  // Con llave propia la persona paga lo suyo: se cuenta para estadística, pero sin límite.
  const usage = await bumpUsage(user, { calls: 1 });
  if (!own && usage && !user.isOwner && usage.ai_calls > limits().aiCalls)
    return fail(res, 429, 'quota_user', `Llegaste a tu límite de ${limits().aiCalls} consultas a Claude este mes. Pide al dueño de Atril que lo amplíe.`);

  const model = MODELS[tier]();
  const body = {
    model,
    max_tokens: tier === 'complex' ? 16000 : 8000,
    stream: true,
    messages: [{ role: 'user', content: input }],
  };
  if (tier === 'quick') body.thinking = { type: 'disabled' }; // Rápida: responde sin pensar primero
  else if (['low', 'medium', 'high'].includes(effort)) body.output_config = { effort };

  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  let up;
  try {
    up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    return fail(res, 502, 'network', 'No se pudo conectar con Claude.');
  }
  if (!up.ok) {
    const detail = await up.text();
    console.error(`[ai] ${up.status}: ${detail.slice(0, 800)}`);
    let msg = '';
    try { msg = JSON.parse(detail).error.message; } catch {}
    if (up.status === 401 || up.status === 403) return fail(res, 502, 'provider_auth', `${who} no es válida.`);
    if (up.status === 429) return fail(res, 429, 'rate_limited', 'Se alcanzó el límite de uso de Claude por ahora.');
    if (up.status === 529) return fail(res, 503, 'overloaded', 'Claude está saturado en este momento. Intenta de nuevo en un minuto.');
    if (up.status === 400 && /credit/i.test(msg)) return fail(res, 402, 'quota', own ? 'Tu cuenta de Anthropic no tiene saldo. Recárgala en console.anthropic.com → Billing.' : 'La cuenta de Anthropic de Atril no tiene crédito.');
    return fail(res, 502, 'provider_error', msg || 'Claude respondió con un error.');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Atril-Tier', tier);
  res.setHeader('X-Atril-Model', model);
  res.status(200);

  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let j;
        try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') res.write(j.delta.text);
        else if (j.type === 'error') res.write('\u0000ERR:' + ((j.error && j.error.message) || 'Error de Claude'));
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) res.write('\u0000ERR:Se cortó la conexión con Claude.');
  }
  res.end();
}
