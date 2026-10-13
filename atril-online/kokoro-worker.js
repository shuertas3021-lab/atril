// Atril · voz Kokoro en el navegador (gratis, sin llaves).
// Corre en un Web Worker para no trabar la página mientras genera el audio.
// 1) espeak-ng convierte el texto en español latino a sonidos (IPA).
// 2) Kokoro-82M convierte esos sonidos en voz con Dora, Alex o Santa.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
import ESpeakNg from 'https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ESPEAK_WASM = 'https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.wasm';
const PUNCT = /([;:,.!?¡¿—…"«»“”()]+)/;
const HAS_WORD = /[\p{L}\p{N}]/u;
const post = (m, t) => self.postMessage(m, t || []);

let ttsP = null, wasmP = null, device = 'wasm';

function getWasm() {
  if (!wasmP) wasmP = (async () => {
    const r = await fetch(ESPEAK_WASM);
    if (!r.ok) throw new Error('No se pudo descargar el fonetizador de español.');
    try { return await WebAssembly.compileStreaming(r.clone()); }
    catch { return WebAssembly.compile(await r.arrayBuffer()); }
  })().catch((e) => { wasmP = null; throw e; });
  return wasmP;
}

function getTTS() {
  if (!ttsP) ttsP = (async () => {
    const files = {};
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files[p.file] = [p.loaded, p.total];
        let loaded = 0, total = 0;
        for (const [l, t] of Object.values(files)) { loaded += l; total += t; }
        post({ type: 'progress', loaded, total });
      },
    });
    return tts;
  })().catch((e) => { ttsP = null; throw e; });
  return ttsP;
}

/** Texto en español → IPA de espeak-ng (variante latinoamericana), una línea por cláusula. */
async function espeak(text) {
  const mod = await getWasm();
  const m = await ESpeakNg({
    arguments: ['--phonout', 'out', '-q', '-b', '1', '--ipa=3', '-v', 'es-419', '-f', 'in.txt'],
    preRun: [(mm) => mm.FS.writeFile('in.txt', text)],
    instantiateWasm(imports, cb) { WebAssembly.instantiate(mod, imports).then((inst) => cb(inst)); return {}; },
    print() {}, printErr() {},
  });
  return m.FS.readFile('out', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Fonetiza respetando la puntuación (Kokoro la usa para las pausas y la entonación). */
async function phonemizeEs(text) {
  const parts = text.split(PUNCT).filter((p) => p !== '');
  const words = parts.filter((p) => !PUNCT.test(p) && HAS_WORD.test(p)).map((w) => w.trim());
  if (!words.length) return '';
  const lines = await espeak(words.join('.\n'));
  let i = 0;
  const joined = lines.length === words.length
    ? parts.map((p) => (PUNCT.test(p) ? p : HAS_WORD.test(p) ? lines[i++] : p)).join(' ')
    : lines.join(', ');
  return joined
    .replace(/‍/g, '')
    .replace(/\s+([;:,.!?…)”»])/g, '$1')
    .replace(/([¡¿(“«])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Divide frases muy largas para no pasar el límite del modelo. */
function chunks(text, max = 240) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(',', max), rest.lastIndexOf(';', max), rest.lastIndexOf(':', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

function wav16(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), d = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  w(36, 'data'); d.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    d.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

async function speak(text, voice) {
  const tts = await getTTS();
  const pieces = [];
  let rate = 24000;
  for (const part of chunks(text)) {
    const ph = await phonemizeEs(part);
    if (!ph) continue;
    const { input_ids } = tts.tokenizer(ph, { truncation: true });
    const audio = await tts.generate_from_ids(input_ids, { voice, speed: 1 });
    rate = audio.sampling_rate || rate;
    pieces.push(audio.audio);
    pieces.push(new Float32Array(Math.round(rate * 0.08))); // pausa breve entre trozos
  }
  const total = pieces.reduce((a, p) => a + p.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const p of pieces) { all.set(p, o); o += p.length; }
  return wav16(all, rate);
}

// Cola de trabajos: uno a la vez (el modelo no admite generaciones simultáneas).
const queue = [];
let busy = false;
function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  job().finally(() => { busy = false; pump(); });
}

self.onmessage = (e) => {
  const { id, type, text, voice } = e.data || {};
  if (type === 'clear') {
    // Al saltar a otra parte del libro, descarta lo que estaba en espera.
    for (const job of queue.splice(0)) post({ id: job.id, type: 'error', message: 'cancelled' });
    return;
  }
  const job = async () => {
    try {
      if (type === 'load') {
        await Promise.all([getTTS(), getWasm()]);
        post({ id, type: 'ready', device });
      } else if (type === 'speak') {
        const t0 = performance.now();
        const wav = await speak(String(text || ''), String(voice || 'ef_dora'));
        post({ id, type: 'audio', wav, ms: Math.round(performance.now() - t0) }, [wav]);
      }
    } catch (err) {
      post({ id, type: 'error', message: String((err && err.message) || err) });
    }
  };
  job.id = id;
  queue.push(job);
  pump();
};
