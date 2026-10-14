import { authenticate } from './_lib.js';

const LANG_NAME = {
  'es-MX': 'México', 'es-US': 'Latino (EE. UU.)', 'es-ES': 'España', 'es-AR': 'Argentina',
  'es-CO': 'Colombia', 'es-CL': 'Chile', 'es-PE': 'Perú', 'es-VE': 'Venezuela',
};
const LANG_ORDER = ['es-MX', 'es-US', 'es-419', 'es-CO', 'es-AR', 'es-CL', 'es-PE', 'es-ES'];
const langRank = (l) => { const i = LANG_ORDER.indexOf(l); return i < 0 ? 99 : i; };

async function azureVoices() {
  const region = process.env.AZURE_SPEECH_REGION;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY },
  });
  if (!r.ok) throw new Error(`Azure ${r.status}`);
  const list = await r.json();
  return list
    .filter((v) => /^es-/i.test(v.Locale) && /neural/i.test(v.VoiceType || 'Neural'))
    .sort((a, b) => langRank(a.Locale) - langRank(b.Locale) || a.LocalName.localeCompare(b.LocalName))
    .map((v) => ({
      p: 'azure', id: v.ShortName, name: v.LocalName || v.DisplayName, lang: LANG_NAME[v.Locale] || v.Locale,
      group: v.Locale === 'es-MX' ? 'México' : 'Otros países', star: v.Locale === 'es-MX',
    }));
}

const GOOGLE_KIND = [
  [/Chirp3-HD/i, 'Chirp 3 HD', 0], [/Chirp-HD/i, 'Chirp HD', 1], [/Studio/i, 'Studio', 2],
  [/Neural2/i, 'Neural2', 3], [/Wavenet/i, 'WaveNet', 4], [/Polyglot/i, 'Polyglot', 5],
];
async function googleVoices() {
  const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=es&key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`);
  if (!r.ok) throw new Error(`Google ${r.status}`);
  const { voices = [] } = await r.json();
  return voices
    .map((v) => {
      const lang = (v.languageCodes && v.languageCodes[0]) || v.name.split('-').slice(0, 2).join('-');
      const kind = GOOGLE_KIND.find(([re]) => re.test(v.name));
      if (!kind || !/^es-/i.test(lang)) return null; // sin voces Standard: suenan robóticas
      const last = v.name.split('-').pop();
      const g = v.ssmlGender === 'FEMALE' ? 'Femenina' : v.ssmlGender === 'MALE' ? 'Masculina' : 'Voz';
      const short = last.length > 2 ? last : `${g} ${last}`;
      return { p: 'google', id: v.name, name: `${short} (${kind[1]})`, lang: LANG_NAME[lang] || lang, group: kind[1], star: kind[2] === 0, _k: kind[2], _l: langRank(lang) };
    })
    .filter(Boolean)
    .sort((a, b) => a._k - b._k || a._l - b._l || a.name.localeCompare(b.name))
    .map(({ _k, _l, ...v }) => v);
}

async function elevenVoices() {
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
  const { voices = [] } = await r.json();
  return voices
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((v) => ({ p: 'elevenlabs', id: v.voice_id, name: v.name.split(' - ')[0], lang: (v.labels && v.labels.accent) || '', group: v.category === 'cloned' || v.category === 'professional' ? 'Mis voces' : 'Biblioteca' }));
}

export default async function handler(req, res) {
  if (!(await authenticate(req, res))) return;
  const jobs = [];
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) jobs.push(['azure', azureVoices()]);
  if (process.env.GOOGLE_TTS_API_KEY) jobs.push(['google', googleVoices()]);
  if (process.env.ELEVENLABS_API_KEY) jobs.push(['elevenlabs', elevenVoices()]);
  const out = await Promise.allSettled(jobs.map(([, p]) => p));
  const voices = [], errors = [];
  out.forEach((r, i) => (r.status === 'fulfilled' ? voices.push(...r.value) : errors.push(`${jobs[i][0]}: ${r.reason && r.reason.message}`)));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(200).json({ voices, errors });
}
