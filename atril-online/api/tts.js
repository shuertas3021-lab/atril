import { authenticate, bumpUsage, limits, fail } from './_lib.js';

const MAX_CHARS = 2500;
const xml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function google(voice, text) {
  const languageCode = voice.split('-').slice(0, 2).join('-');
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode, name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
  });
  if (!r.ok) return { status: r.status, detail: await r.text() };
  const { audioContent } = await r.json();
  return { audio: Buffer.from(audioContent, 'base64') };
}

async function azure(voice, text) {
  const region = process.env.AZURE_SPEECH_REGION;
  const lang = voice.split('-').slice(0, 2).join('-');
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xml(voice)}">${xml(text)}</voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'atril',
    },
    body: ssml,
  });
  if (!r.ok) return { status: r.status, detail: await r.text() };
  return { audio: Buffer.from(await r.arrayBuffer()) };
}

async function elevenlabs(voice, text) {
  const model = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!r.ok) return { status: r.status, detail: await r.text() };
  return { audio: Buffer.from(await r.arrayBuffer()) };
}

const ENGINES = {
  google: [() => !!process.env.GOOGLE_TTS_API_KEY, google],
  azure: [() => !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION), azure],
  elevenlabs: [() => !!process.env.ELEVENLABS_API_KEY, elevenlabs],
};

export default async function handler(req, res) {
  const user = await authenticate(req, res);
  if (!user) return;
  const src = req.method === 'POST' ? req.body || {} : req.query || {};
  const p = String(src.p || ''), v = String(src.v || ''), t = String(src.t || '').trim();
  const engine = ENGINES[p];
  if (!engine) return fail(res, 400, 'bad_provider', 'Proveedor de voz desconocido.');
  if (!engine[0]()) return fail(res, 400, 'not_configured', 'Esta voz no está configurada en el servidor.');
  if (!/^[\w.-]{1,100}$/.test(v)) return fail(res, 400, 'bad_voice', 'Voz no válida.');
  if (!t) return fail(res, 400, 'empty', 'No hay texto para leer.');
  if (t.length > MAX_CHARS) return fail(res, 413, 'too_long', 'El texto es demasiado largo para una sola petición.');

  const usage = await bumpUsage(user, { chars: t.length });
  if (usage && !user.isOwner && usage.tts_chars - t.length >= limits().ttsChars)
    return fail(res, 429, 'quota_user', 'Llegaste a tu límite de voz en la nube de este mes. Usa una voz del dispositivo o pide al dueño de Atril que lo amplíe.');

  try {
    const out = await engine[1](v, t);
    if (out.audio) {
      res.setHeader('Content-Type', 'audio/mpeg');
      // El mismo texto con la misma voz siempre suena igual: se puede guardar en caché para siempre.
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
      return res.status(200).send(out.audio);
    }
    console.error(`[tts] ${p} ${out.status}: ${String(out.detail).slice(0, 500)}`);
    if (out.status === 429) return fail(res, 429, 'rate_limited', 'Se alcanzó el límite de la voz por ahora. Espera unos segundos.');
    if (out.status === 401 || out.status === 403) return fail(res, 502, 'provider_auth', `La llave de ${p} no es válida o no tiene permiso.`);
    if (out.status === 402) return fail(res, 402, 'quota', `Se acabaron los créditos de ${p}.`);
    return fail(res, 502, 'provider_error', `El servicio de voz (${p}) respondió con un error.`);
  } catch (e) {
    console.error('[tts]', e);
    return fail(res, 502, 'network', 'No se pudo conectar con el servicio de voz.');
  }
}
