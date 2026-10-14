// Atril · Google Gemini con la llave de API de cada persona (aistudio.google.com).
// La llave viaja en el encabezado x-atril-gm-key; aquí no se guarda.
import { bumpUsage, fail } from './_lib.js';

const list = (env, def) => (process.env[env] ? process.env[env].split(',').map((s) => s.trim()).filter(Boolean) : def);
// Si un modelo no existe (o no está en el plan gratuito) se prueba el siguiente.
const MODELS = {
  quick: () => list('GEMINI_MODELS_QUICK', ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash']),
  default: () => list('GEMINI_MODELS_DEFAULT', ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']),
  complex: () => list('GEMINI_MODELS_COMPLEX', ['gemini-pro-latest', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-2.5-flash']),
};
const API = 'https://generativelanguage.googleapis.com/v1beta';
const badKey = (status, msg) => status === 401 || status === 403 || (status === 400 && /api key|API_KEY/i.test(msg));
const skipModel = (status, msg) =>
  status === 404 || /not found|is not supported|not available/i.test(msg) ||
  (status === 429 && /free_tier|limit: 0|limit:0/i.test(msg)); // modelo de pago con llave gratuita

export async function handleGemini(req, res, user) {
  const raw = String(req.headers['x-atril-gm-key'] || '').trim();
  const key = /^[\w-]{30,200}$/.test(raw) ? raw : '';
  if (raw && !key) return fail(res, 400, 'provider_auth', 'Tu llave de Gemini no tiene el formato correcto (normalmente empieza con AIza).');
  const apiKey = key || process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 503, 'not_configured', 'Agrega tu llave de Gemini en «Mi cuenta → Gemini».');
  const headers = { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };

  if (req.body && req.body.test) {
    const t = await fetch(`${API}/models?pageSize=1`, { headers }).catch(() => null);
    if (!t) return fail(res, 502, 'network', 'No se pudo conectar con Gemini.');
    if (!t.ok) {
      let msg = ''; try { msg = (await t.json()).error.message || ''; } catch {}
      if (badKey(t.status, msg)) return fail(res, 400, 'provider_auth', 'Tu llave de Gemini no es válida.');
      return fail(res, 502, 'provider_error', msg || 'Gemini respondió con un error al probar la llave.');
    }
    return res.status(200).json({ ok: true, own: true });
  }

  const { input, tier: rawTier } = req.body || {};
  const tier = MODELS[rawTier] ? rawTier : 'default';
  await bumpUsage(user, { calls: 1 }); // solo estadística: paga (o usa gratis) la cuenta de la persona

  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  let up = null, model = '', lastMsg = '', lastStatus = 0;
  outer: for (const m of MODELS[tier]()) {
    for (const noThink of tier === 'quick' ? [true, false] : [false]) {
      const body = {
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: { maxOutputTokens: tier === 'complex' ? 16000 : 8000 },
      };
      if (noThink) body.generationConfig.thinkingConfig = { thinkingBudget: 0 }; // Rápida: sin pensar antes
      let r;
      try { r = await fetch(`${API}/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal }); }
      catch (e) { return fail(res, 502, 'network', 'No se pudo conectar con Gemini.'); }
      if (r.ok) { up = r; model = m; break outer; }
      const detail = await r.text();
      lastStatus = r.status;
      try { lastMsg = JSON.parse(detail).error.message || ''; } catch { lastMsg = detail.slice(0, 300); }
      if (r.status === 400 && noThink && /thinking/i.test(lastMsg)) continue; // ese modelo siempre piensa
      if (skipModel(r.status, lastMsg)) continue outer;
      console.error(`[ai/gemini] ${r.status}: ${lastMsg}`);
      if (badKey(r.status, lastMsg)) return fail(res, 502, 'provider_auth', 'Tu llave de Gemini no es válida.');
      if (r.status === 429) return fail(res, 429, 'rate_limited', 'Llegaste al límite gratuito de Gemini por ahora. Espera un minuto (o hasta mañana si es el límite diario) o usa la potencia Rápida.');
      return fail(res, 502, 'provider_error', lastMsg || 'Gemini respondió con un error.');
    }
  }
  if (!up) {
    console.error(`[ai/gemini] sin modelo disponible: ${lastStatus} ${lastMsg}`);
    if (lastStatus === 429) return fail(res, 429, 'rate_limited', 'Llegaste al límite gratuito de Gemini por ahora. Intenta más tarde.');
    return fail(res, 502, 'provider_error', 'Tu cuenta de Gemini no tiene acceso a los modelos de Atril.');
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
        let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.error) { res.write('\u0000ERR:' + (j.error.message || 'Error de Gemini')); continue; }
        const c = j.candidates && j.candidates[0];
        for (const p of (c && c.content && c.content.parts) || []) if (p.text && !p.thought) res.write(p.text);
        if (c && c.finishReason === 'SAFETY') res.write('\u0000ERR:Gemini detuvo la respuesta por sus filtros de seguridad.');
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) res.write('\u0000ERR:Se cortó la conexión con Gemini.');
  }
  res.end();
}
