// TK Digital — Studio Son : worker de calcul (module).
// Garde l'audio d'origine, le cache de l'étape lourde et le modèle IA en mémoire.
import { analyze, processAudio } from './son-video-dsp.js';

const DF_URL = new URL('./vendor/deepfilternet-0.1.0/df_bg.wasm', import.meta.url).href;
let original = null, sampleRate = 48000, cache = {};
let dfModule = null, dfBlobUrl = null, dfLoading = null;

// Téléchargement du modèle (34 Mo, mis en cache par le navigateur) avec progression.
function loadDF(onProgress) {
  if (!dfLoading) {
    dfLoading = (async () => {
      const res = await fetch(DF_URL);
      if (!res.ok) throw new Error(`modèle IA introuvable (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 34135648;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        onProgress && onProgress(Math.min(1, got / total));
      }
      dfBlobUrl = URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
      dfModule = await import('./vendor/deepfilternet-0.1.0/index.js');
      // Initialise le wasm une fois (compilation ~1-2 s).
      const probe = await dfModule.DeepFilter.create({ wasmUrl: dfBlobUrl });
      probe.destroy();
      return true;
    })();
    dfLoading.catch(() => { dfLoading = null; });
  }
  return dfLoading;
}

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'preloadAI') {
      await loadDF((p) => post({ id, type: 'progress', progress: p, label: 'Téléchargement du modèle IA' }));
      post({ id, type: 'done' });
      return;
    }
    if (type === 'load') {
      original = e.data.channels;
      sampleRate = e.data.sampleRate;
      cache = {};
      post({ id, type: 'done', analysis: analyze(original, sampleRate) });
      return;
    }
    if (type === 'process') {
      const s = e.data.settings;
      let last = 0;
      const progress = (p, label) => {
        const now = Date.now();
        if (now - last > 80) { last = now; post({ id, type: 'progress', progress: p, label }); }
      };
      const deps = {
        createDF: async (limitDb) => {
          await loadDF((p) => progress(0.06 * p, 'Téléchargement du modèle IA'));
          return dfModule.DeepFilter.create({ wasmUrl: dfBlobUrl, attenuationLimit: limitDb });
        },
      };
      const { chs, report } = await processAudio(original, sampleRate, s, progress, deps, cache);
      post({ id, type: 'done', channels: chs, report }, chs.map((c) => c.buffer));
    }
  } catch (err) {
    post({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
