// TK Digital — Studio Son : interface, lecture A/B et export vidéo.
import * as MB from './vendor/mediabunny-1.59.1.min.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), studio: $('studio'), fname: $('fname'), fmeta: $('fmeta'),
  another: $('another'), video: $('video'), player: $('player'), play: $('play'),
  icPlay: $('icPlay'), icPause: $('icPause'), time: $('time'), wave: $('wave'), spec: $('spec'),
  status: $('status'), bar: $('bar'), stats: $('stats'), steps: $('steps'), warn: $('warn'),
  dlVideo: $('dlVideo'), dlWav: $('dlWav'), presets: $('presets'), target: $('target'),
  denoise: $('denoise'), clarity: $('clarity'), compress: $('compress'), autoEq: $('autoEq'),
  expandT: $('expandT'), deessT: $('deessT'), highpass: $('highpass'), dehum: $('dehum'),
  monoT: $('monoT'), declipT: $('declipT'), toast: $('toast'),
};

const PRESETS = {
  face:      { mode: 'voice', denoise: 55, clarity: 40, compress: 50, autoEq: true,  expand: true,  deess: true,  highpass: 80 },
  outdoor:   { mode: 'voice', denoise: 80, clarity: 45, compress: 55, autoEq: true,  expand: true,  deess: true,  highpass: 120 },
  interview: { mode: 'voice', denoise: 60, clarity: 50, compress: 60, autoEq: true,  expand: true,  deess: true,  highpass: 90 },
  mix:       { mode: 'mix',   denoise: 30, clarity: 25, compress: 30, autoEq: true,  expand: false, deess: true,  highpass: 60 },
  podcast:   { mode: 'voice', denoise: 55, clarity: 40, compress: 70, autoEq: true,  expand: true,  deess: true,  highpass: 80, target: '-16' },
  music:     { mode: 'music', denoise: 0,  clarity: 0,  compress: 15, autoEq: false, expand: false, deess: false, highpass: 30 },
};

const state = {
  file: null, hasVideo: false, videoOk: true,
  sr: 48000, t0: 0, orig: null, proc: null, // AudioBuffer
  analysis: null, report: null, mode: 'voice', preset: 'auto',
  view: 'after', ctx: null, analyser: null, src: null, startedAt: 0,
  playing: false, clockOffset: 0, duration: 0,
  worker: null, jobId: 0, busy: false, exporting: false,
  peaksOrig: null, peaksProc: null,
};

/* --------------------------------------------------------------- UI utils */

let toastTimer;
function toast(msg, err = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', err);
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 4200);
}
function setStatus(msg, p = null) {
  els.status.textContent = msg;
  if (p !== null) els.bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}
const fmtTime = (t) => {
  if (!Number.isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const fmtDb = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',').replace('-', '−') : '—');
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} Go` : `${(b / 1e6).toFixed(1)} Mo`);

/* ---------------------------------------------------------- Chargement */

els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault(); els.drop.classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
els.file.addEventListener('change', () => { const f = els.file.files[0]; if (f) loadFile(f); els.file.value = ''; });
els.another.addEventListener('click', () => els.file.click());

function ensureCtx() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 4096;
    state.analyser.smoothingTimeConstant = 0.78;
    state.analyser.connect(state.ctx.destination);
  }
  return state.ctx;
}

async function decodeWithMediabunny(file, onProgress) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw Object.assign(new Error('Aucune piste audio dans ce fichier.'), { noAudio: true });
  if (!(await track.canDecode())) throw new Error('Codec audio non décodable via WebCodecs.');
  const video = await input.getPrimaryVideoTrack();
  const sr = track.sampleRate;
  const nch = Math.min(2, track.numberOfChannels);
  const duration = await track.computeDuration();
  let cap = Math.ceil((duration + 0.5) * sr) + 4096;
  let chs = Array.from({ length: nch }, () => new Float32Array(cap));
  let t0 = null, end = 0;
  const sink = new MB.AudioSampleSink(track);
  for await (const s of sink.samples()) {
    if (t0 === null) t0 = s.timestamp;
    const idx = Math.max(0, Math.round((s.timestamp - t0) * sr));
    const frames = s.numberOfFrames;
    if (idx + frames > cap) {
      cap = Math.ceil((idx + frames) * 1.25);
      chs = chs.map((c) => { const n = new Float32Array(cap); n.set(c); return n; });
    }
    for (let c = 0; c < nch; c++) {
      s.copyTo(chs[c].subarray(idx, idx + frames), { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar' });
    }
    end = Math.max(end, idx + frames);
    s.close();
    if (duration) onProgress(Math.min(1, (s.timestamp - t0) / duration));
  }
  if (!end) throw new Error('Piste audio vide.');
  return { chs: chs.map((c) => c.slice(0, end)), sr, t0: t0 || 0, hasVideo: !!video, input };
}

async function decodeWithWebAudio(file) {
  const ctx = ensureCtx();
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const nch = Math.min(2, buf.numberOfChannels);
  const chs = Array.from({ length: nch }, (_, c) => buf.getChannelData(c).slice());
  return { chs, sr: buf.sampleRate, t0: 0, hasVideo: file.type.startsWith('video') };
}

async function loadFile(file) {
  stopAudio();
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  Object.assign(state, { file, orig: null, proc: null, report: null, analysis: null, peaksOrig: null, peaksProc: null, preset: 'auto', busy: false });
  els.studio.classList.add('on');
  els.fname.textContent = file.name;
  els.fmeta.textContent = fmtBytes(file.size);
  els.dlVideo.disabled = true; els.dlWav.disabled = true;
  els.stats.innerHTML = ''; els.steps.innerHTML = ''; els.warn.classList.remove('on');
  highlightPreset('auto');
  setTimeout(() => els.studio.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);

  // Aperçu vidéo
  if (els.video.src) URL.revokeObjectURL(els.video.src);
  state.videoOk = true;
  els.video.src = URL.createObjectURL(file);
  els.player.classList.toggle('audio', file.type.startsWith('audio'));

  setStatus('Lecture de la piste audio…', 0);
  let dec;
  try {
    dec = await decodeWithMediabunny(file, (p) => setStatus(`Lecture de la piste audio… ${Math.round(p * 100)} %`, p * 0.3));
  } catch (e) {
    if (e.noAudio) { setStatus('Ce fichier ne contient pas de son.'); toast('Aucune piste audio trouvée dans ce fichier.', true); return; }
    console.warn('Mediabunny decode failed, fallback Web Audio', e);
    try { dec = await decodeWithWebAudio(file); }
    catch (e2) {
      console.error(e2);
      setStatus('Impossible de lire le son de ce fichier.');
      toast('Format non pris en charge par ce navigateur. Essaie Chrome, Edge ou Safari récent, ou un MP4.', true);
      return;
    }
  }
  if (state.file !== file) return;
  state.sr = dec.sr; state.t0 = dec.t0; state.hasVideo = dec.hasVideo;
  if (!dec.hasVideo) els.player.classList.add('audio');
  const ctx = ensureCtx();
  state.orig = ctx.createBuffer(dec.chs.length, dec.chs[0].length, dec.sr);
  dec.chs.forEach((c, i) => state.orig.copyToChannel(c, i));
  state.duration = state.orig.duration;
  els.fmeta.textContent = `${fmtBytes(file.size)} · ${fmtTime(state.duration)} · ${dec.sr / 1000} kHz · ${dec.chs.length === 1 ? 'mono' : 'stéréo'}`;
  state.peaksOrig = computePeaks(state.orig);
  drawWave();
  if (state.duration > 1800) toast('Fichier long : le traitement peut prendre quelques minutes.');

  setStatus('Analyse du son…', 0.32);
  const analysis = await runWorker({ type: 'analyze', channels: dec.chs, sampleRate: dec.sr });
  if (!analysis || state.file !== file) return;
  state.analysis = analysis.analysis;
  applyPreset('auto', false);
  process();
}

/* ----------------------------------------------------------- Worker */

function getWorker() {
  if (!state.worker) state.worker = new Worker(new URL('./son-video-dsp.js', import.meta.url));
  return state.worker;
}

function runWorker(msg, onProgress, transfer = []) {
  const id = ++state.jobId;
  const w = getWorker();
  return new Promise((resolve) => {
    const handler = (e) => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.type === 'progress') { onProgress && onProgress(d.progress, d.label); return; }
      w.removeEventListener('message', handler);
      if (d.type === 'error') { console.error(d.message); toast(`Erreur de traitement : ${d.message}`, true); resolve(null); return; }
      resolve(d);
    };
    w.addEventListener('message', handler);
    w.postMessage({ ...msg, id }, transfer);
  });
}

/* --------------------------------------------------------- Réglages */

function highlightPreset(p) {
  els.presets.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
}

function autoSettings(a) {
  const snr = a ? a.snrDb : 30;
  let denoise = snr < 12 ? 85 : snr < 20 ? 70 : snr < 28 ? 55 : snr < 38 ? 38 : 20;
  if (a && a.noiseFloorDb < -72) denoise = Math.min(denoise, 15);
  return {
    mode: 'voice', denoise, clarity: 40, compress: 50, autoEq: true,
    expand: snr < 40, deess: true, highpass: 80,
  };
}

function applyPreset(name, reprocess = true) {
  state.preset = name;
  highlightPreset(name);
  const p = name === 'auto' ? autoSettings(state.analysis) : PRESETS[name];
  state.mode = p.mode;
  els.denoise.value = p.denoise; els.clarity.value = p.clarity; els.compress.value = p.compress;
  els.autoEq.checked = p.autoEq; els.expandT.checked = p.expand; els.deessT.checked = p.deess;
  els.highpass.value = p.highpass;
  if (p.target) els.target.value = p.target;
  else if (name !== 'podcast' && els.target.value === '-16' && state.presetTargetFromPodcast) els.target.value = '-14';
  state.presetTargetFromPodcast = !!p.target;
  const voice = p.mode !== 'music';
  [els.clarity, els.autoEq, els.expandT, els.deessT].forEach((el) => { el.disabled = !voice; });
  refreshOutputs();
  if (reprocess) scheduleProcess(0);
}

function refreshOutputs() {
  $('denoiseV').textContent = `${els.denoise.value} %`;
  $('clarityV').textContent = `${els.clarity.value} %`;
  $('compressV').textContent = `${els.compress.value} %`;
  $('highpassV').textContent = Number(els.highpass.value) ? `${els.highpass.value} Hz` : 'off';
}

function currentSettings() {
  const t = els.target.value;
  return {
    mode: state.mode,
    denoise: Number(els.denoise.value),
    clarity: Number(els.clarity.value),
    compress: Number(els.compress.value),
    autoEq: els.autoEq.checked,
    expand: els.expandT.checked ? 50 : 0,
    deess: els.deessT.checked ? 45 : 0,
    highpass: Number(els.highpass.value),
    dehum: els.dehum.value,
    monoVoice: els.monoT.checked,
    declip: els.declipT.checked,
    target: t === 'off' ? NaN : Number(t),
    ceiling: -1.5,
  };
}

els.presets.addEventListener('click', (e) => {
  const b = e.target.closest('.preset');
  if (b && state.orig) applyPreset(b.dataset.p);
});
['denoise', 'clarity', 'compress', 'highpass'].forEach((k) => {
  els[k].addEventListener('input', refreshOutputs);
  els[k].addEventListener('change', () => scheduleProcess());
});
['target', 'autoEq', 'expandT', 'deessT', 'dehum', 'monoT', 'declipT'].forEach((k) => els[k].addEventListener('change', () => scheduleProcess()));

let procTimer;
function scheduleProcess(delay = 350) {
  if (!state.orig) return;
  clearTimeout(procTimer);
  procTimer = setTimeout(process, delay);
}

async function process() {
  if (!state.orig || state.exporting) return;
  const file = state.file;
  const chs = Array.from({ length: state.orig.numberOfChannels }, (_, c) => state.orig.getChannelData(c).slice());
  // Un nouveau réglage annule le calcul en cours.
  if (state.busy && state.worker) { state.worker.terminate(); state.worker = null; }
  state.busy = true;
  els.studio.classList.add('busy');
  els.dlVideo.disabled = true; els.dlWav.disabled = true;
  setStatus('Amélioration du son…', 0.35);
  const t = performance.now();
  const res = await runWorker(
    { type: 'process', channels: chs, sampleRate: state.sr, settings: currentSettings() },
    (p, label) => setStatus(`${label}… ${Math.round(p * 100)} %`, 0.35 + p * 0.65),
    chs.map((c) => c.buffer),
  );
  if (state.file !== file || (res && res.id !== state.jobId)) return;
  if (!res) { state.busy = false; els.studio.classList.remove('busy'); setStatus('Le traitement a échoué. Essaie un autre réglage ou un autre fichier.'); return; }
  state.busy = false;
  els.studio.classList.remove('busy');
  const ctx = ensureCtx();
  const buf = ctx.createBuffer(res.channels.length, res.channels[0].length, state.sr);
  res.channels.forEach((c, i) => buf.copyToChannel(c, i));
  state.proc = buf;
  state.report = res.report;
  state.peaksProc = computePeaks(buf);
  drawWave();
  renderReport();
  setStatus(`Prêt ✓ — traité en ${((performance.now() - t) / 1000).toFixed(1).replace('.', ',')} s. Compare avec « Avant / Après ».`, 1);
  els.dlVideo.disabled = !state.hasVideo;
  els.dlVideo.hidden = !state.hasVideo;
  els.dlWav.className = state.hasVideo ? 'btn btn-g' : 'btn btn-a';
  els.dlWav.textContent = state.hasVideo ? 'Audio seul (WAV)' : 'Télécharger l\'audio (WAV)';
  els.dlWav.disabled = false;
  if (state.playing && state.view === 'after') startAudio();
}

function renderReport() {
  const b = state.report.before, a = state.report.after;
  const stat = (k, v, unit, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v} <small>${unit}</small></div><div class="d">${d}</div></div>`;
  const nr = state.report.noiseReductionDb;
  const nrTxt = nr === null || nr === undefined ? ['—', '', 'pas de blanc à mesurer']
    : nr < 1.5 ? ['OK', '', 'son déjà propre'] : [`−${Math.round(nr)}`, 'dB', 'pendant les blancs, à voix égale'];
  els.stats.innerHTML = [
    stat('Volume perçu', fmtDb(a.loudness), 'LUFS', `avant ${fmtDb(b.loudness)}`),
    stat('Bruit de fond', nrTxt[0], nrTxt[1], nrTxt[2]),
    stat('Ronflement', b.hum && currentSettings().dehum !== '0' ? `${b.hum} Hz` : 'aucun', '', b.hum && currentSettings().dehum !== '0' ? '<b>supprimé</b>' : 'rien détecté'),
    stat('Crête max', fmtDb(a.peakDb), 'dBFS', `avant ${fmtDb(b.peakDb)}`),
  ].join('');
  els.steps.innerHTML = state.report.steps.map((s) => `<li>${s}</li>`).join('');
  const warns = [];
  if (b.clipRatio > 0.001) warns.push('Le son d\'origine sature beaucoup : la réparation limite les dégâts, mais pense à baisser le gain du micro au prochain tournage.');
  if (b.snrDb < 10) warns.push('La voix est presque aussi forte que le bruit : le résultat sera meilleur avec un micro plus proche de la bouche (même un micro-cravate à 15 €).');
  els.warn.innerHTML = warns.join('<br>');
  els.warn.classList.toggle('on', warns.length > 0);
}

/* ------------------------------------------------------------ Lecture */

function currentBuffer() { return state.view === 'after' && state.proc ? state.proc : state.orig; }

function mediaTime() {
  if (state.videoOk && state.hasVideo) return els.video.currentTime;
  if (state.playing) return state.ctx.currentTime - state.clockStart;
  return state.clockOffset;
}

function stopAudio() {
  if (state.src) { try { state.src.stop(); } catch { /* déjà arrêté */ } state.src.disconnect(); state.src = null; }
}

function startAudio() {
  stopAudio();
  const buf = currentBuffer();
  if (!buf || !state.playing) return;
  const ctx = ensureCtx();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.analyser);
  const t = mediaTime();
  const off = t - state.t0;
  if (off >= 0) src.start(0, Math.min(off, buf.duration));
  else src.start(ctx.currentTime - off);
  state.audioAnchor = ctx.currentTime - t; // horloge audio ↔ temps média
  state.src = src;
}

function usingVideoClock() { return state.videoOk && state.hasVideo; }

async function play() {
  if (!state.orig) return;
  const ctx = ensureCtx();
  await ctx.resume();
  if (usingVideoClock()) {
    if (els.video.ended || els.video.currentTime >= state.duration - 0.05) els.video.currentTime = 0;
    try { await els.video.play(); } catch (e) { console.warn(e); state.videoOk = false; }
  }
  if (!usingVideoClock()) {
    if (state.clockOffset >= state.duration - 0.05) state.clockOffset = 0;
    state.clockStart = ctx.currentTime - state.clockOffset;
  }
  state.playing = true;
  startAudio();
  updatePlayIcon();
}

function pause() {
  if (usingVideoClock()) els.video.pause();
  else state.clockOffset = mediaTime();
  state.playing = false;
  stopAudio();
  updatePlayIcon();
}

function seek(t) {
  t = Math.max(0, Math.min(state.duration, t));
  if (usingVideoClock()) els.video.currentTime = t;
  else { state.clockOffset = t; if (state.playing) state.clockStart = state.ctx.currentTime - t; }
  if (state.playing) startAudio();
}

function updatePlayIcon() {
  els.icPlay.style.display = state.playing ? 'none' : '';
  els.icPause.style.display = state.playing ? '' : 'none';
}

els.play.addEventListener('click', () => (state.playing ? pause() : play()));
els.video.addEventListener('click', () => (state.playing ? pause() : play()));
els.video.addEventListener('error', () => {
  if (!state.file) return;
  state.videoOk = false;
  els.player.classList.add('audio');
  els.player.querySelector('.audio-only').textContent = 'Aperçu image indisponible dans ce navigateur — le son et l\'export fonctionnent.';
});
els.video.addEventListener('seeked', () => { if (state.playing) startAudio(); });
els.video.addEventListener('waiting', () => stopAudio());
els.video.addEventListener('playing', () => { if (state.playing && !state.src) startAudio(); });
els.video.addEventListener('ended', () => { state.playing = false; stopAudio(); updatePlayIcon(); });

document.querySelectorAll('.ab-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
function setView(v) {
  state.view = v;
  document.querySelectorAll('.ab-switch button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
  if (state.playing) startAudio();
}

document.addEventListener('keydown', (e) => {
  if (!state.orig || e.target.closest('input,select,textarea,button')) return;
  if (e.key === 'a' || e.key === 'A') { setView(state.view === 'after' ? 'before' : 'after'); }
  else if (e.key === ' ') { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === 'ArrowRight') seek(mediaTime() + 5);
  else if (e.key === 'ArrowLeft') seek(mediaTime() - 5);
});

/* --------------------------------------------------- Visualisations */

function computePeaks(buf, cols = 1600) {
  const d = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(d.length / cols));
  const out = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    let m = 0;
    const s = i * step, e = Math.min(d.length, s + step);
    for (let j = s; j < e; j++) { const a = Math.abs(d[j]); if (a > m) m = a; }
    out[i] = m;
  }
  return out;
}

function fitCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { g: c.getContext('2d'), w, h, dpr };
}

function drawWave() {
  const { g, w, h, dpr } = fitCanvas(els.wave);
  g.clearRect(0, 0, w, h);
  const mid = h / 2;
  const css = getComputedStyle(document.documentElement);
  // Original en haut, version améliorée en bas : même échelle, comparaison directe.
  const paint = (peaks, color, dir) => {
    if (!peaks) return;
    g.fillStyle = color;
    const n = peaks.length;
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.min(n - 1, Math.floor((x / w) * n))];
      const y = Math.max(dpr, Math.sqrt(v) * (mid - 2 * dpr)); // échelle racine : les détails faibles restent visibles
      g.fillRect(x, dir < 0 ? mid - dpr - y : mid + dpr, 1, y);
    }
  };
  paint(state.peaksOrig, css.getPropertyValue('--before').trim() || '#777', -1);
  paint(state.peaksProc, css.getPropertyValue('--a').trim() || '#c8f135', 1);
  if (state.duration) {
    const x = (mediaTime() / state.duration) * w;
    g.fillStyle = '#fff';
    g.fillRect(Math.round(x), 0, Math.max(1, dpr), h);
  }
}

function drawSpectrum() {
  const { g, w, h } = fitCanvas(els.spec);
  g.clearRect(0, 0, w, h);
  if (!state.analyser || !state.playing) return;
  const a = state.analyser;
  const data = new Float32Array(a.frequencyBinCount);
  a.getFloatFrequencyData(data);
  const sr = state.ctx.sampleRate, bins = data.length;
  const bars = Math.max(24, Math.floor(w / 7));
  const fMin = 40, fMax = Math.min(18000, sr / 2);
  const color = state.view === 'after' ? '#c8f135' : '#9a9a92';
  g.fillStyle = color;
  for (let i = 0; i < bars; i++) {
    const f0 = fMin * Math.pow(fMax / fMin, i / bars), f1 = fMin * Math.pow(fMax / fMin, (i + 1) / bars);
    const k0 = Math.floor((f0 / (sr / 2)) * bins), k1 = Math.max(k0 + 1, Math.floor((f1 / (sr / 2)) * bins));
    let m = -Infinity;
    for (let k = k0; k < k1 && k < bins; k++) m = Math.max(m, data[k]);
    const v = Math.max(0, Math.min(1, (m + 95) / 70));
    const bh = Math.max(1, v * h);
    g.fillRect((i * w) / bars + 1, h - bh, w / bars - 2, bh);
  }
}

els.wave.addEventListener('click', (e) => {
  if (!state.duration) return;
  const r = els.wave.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * state.duration);
});
window.addEventListener('resize', drawWave);

(function loop() {
  if (state.orig) {
    const t = mediaTime();
    if (!usingVideoClock() && state.playing && t >= state.duration) { pause(); state.clockOffset = state.duration; }
    els.time.textContent = `${fmtTime(t)} / ${fmtTime(state.duration)}`;
    // Resynchronisation si l'audio dérive de la vidéo.
    if (state.playing && state.src && usingVideoClock() && !els.video.paused) {
      const expected = state.ctx.currentTime - state.audioAnchor;
      if (Math.abs(expected - t) > 0.12) startAudio();
    }
    drawWave();
    drawSpectrum();
  }
  requestAnimationFrame(loop);
})();

/* -------------------------------------------------------------- Export */

function baseName() { return state.file.name.replace(/\.[^.]+$/, '') || 'video'; }

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function encodeWav(buf) {
  const nch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * nch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * nch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * nch * 2, true); out.setUint16(32, nch * 2, true);
  out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * nch * 2, true);
  const chs = Array.from({ length: nch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const dither = (Math.random() - Math.random()) / 32768; // TPDF
      const v = Math.max(-1, Math.min(1, chs[c][i] + dither));
      out.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

els.dlWav.addEventListener('click', () => {
  if (!state.proc) return;
  download(encodeWav(state.proc), `${baseName()}-son-ameliore.wav`);
  toast('Audio WAV téléchargé ✓');
});

async function pickOutput(input) {
  const inFmt = await input.getFormat();
  const candidates = [];
  if (inFmt === MB.WEBM) candidates.push([() => new MB.WebMOutputFormat(), 'webm']);
  else if (inFmt === MB.MATROSKA) candidates.push([() => new MB.MkvOutputFormat(), 'mkv']);
  else if (inFmt === MB.QTFF) candidates.push([() => new MB.MovOutputFormat({ fastStart: 'in-memory' }), 'mov']);
  candidates.push([() => new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), 'mp4']);
  const nch = state.proc.numberOfChannels;
  for (const [make, ext] of candidates) {
    const fmt = make();
    const order = ['aac', 'opus', 'vorbis', 'flac'].filter((c) => fmt.getSupportedAudioCodecs().includes(c));
    for (const codec of order) {
      const sampleRate = codec === 'opus' ? 48000 : state.sr;
      if (await MB.canEncodeAudio(codec, { numberOfChannels: nch, sampleRate, bitrate: 192000 }).catch(() => false)) {
        return { fmt, ext, codec, sampleRate };
      }
    }
  }
  return null;
}

els.dlVideo.addEventListener('click', async () => {
  if (!state.proc || state.exporting) return;
  state.exporting = true;
  els.dlVideo.disabled = true; els.dlWav.disabled = true;
  const label = els.dlVideo.querySelector('span');
  const proc = state.proc;
  try {
    const input = new MB.Input({ source: new MB.BlobSource(state.file), formats: MB.ALL_FORMATS });
    const out = await pickOutput(input);
    if (!out) throw new Error('Ton navigateur ne sait pas encoder l\'audio. Télécharge le WAV et remplace la piste dans ton logiciel de montage.');
    const output = new MB.Output({ format: out.fmt, target: new MB.BufferTarget() });
    const nch = proc.numberOfChannels, procSr = proc.sampleRate, outSr = out.sampleRate, t0 = state.t0;
    const data = Array.from({ length: nch }, (_, c) => proc.getChannelData(c));
    const len = proc.length;
    const conversion = await MB.Conversion.init({
      input, output, showWarnings: false,
      audio: {
        codec: out.codec,
        bitrate: MB.QUALITY_HIGH,
        forceTranscode: true,
        processedNumberOfChannels: nch,
        processedSampleRate: outSr,
        process: (sample) => {
          // Remplace chaque bloc audio par la version traitée au même instant.
          const ts = sample.timestamp;
          const start = Math.round((ts - t0) * outSr);
          const end = Math.round((ts + sample.duration - t0) * outSr);
          const frames = end - start;
          if (frames <= 0) return null;
          const buf = new Float32Array(frames * nch);
          const ratio = procSr / outSr;
          for (let c = 0; c < nch; c++) {
            const src = data[c], o = c * frames;
            if (ratio === 1) {
              for (let i = 0; i < frames; i++) { const k = start + i; buf[o + i] = k >= 0 && k < len ? src[k] : 0; }
            } else {
              for (let i = 0; i < frames; i++) {
                const p = (start + i) * ratio, k = Math.floor(p), f = p - k;
                const a = k >= 0 && k < len ? src[k] : 0, b = k + 1 >= 0 && k + 1 < len ? src[k + 1] : 0;
                buf[o + i] = a + (b - a) * f;
              }
            }
          }
          return new MB.AudioSample({ data: buf, format: 'f32-planar', numberOfChannels: nch, sampleRate: outSr, timestamp: t0 + start / outSr });
        },
      },
    });
    if (!conversion.isValid) {
      console.warn(conversion.discardedTracks);
      throw new Error('Ce fichier ne peut pas être réassemblé dans ce navigateur. Télécharge le WAV à la place.');
    }
    conversion.onProgress = (p) => { label.textContent = `Export… ${Math.round(p * 100)} %`; setStatus(`Export de la vidéo… ${Math.round(p * 100)} %`, p); };
    await conversion.execute();
    const blob = new Blob([output.target.buffer], { type: out.fmt.mimeType });
    download(blob, `${baseName()}-son-ameliore.${out.ext}`);
    setStatus(`Vidéo exportée ✓ (${fmtBytes(blob.size)}, audio ${out.codec.toUpperCase()}). L'image n'a pas été réencodée.`, 1);
    toast('Vidéo téléchargée ✓');
  } catch (e) {
    console.error(e);
    setStatus('L\'export vidéo a échoué — le WAV reste disponible.', 1);
    toast(e.message || 'Export impossible.', true);
  } finally {
    state.exporting = false;
    label.textContent = 'Télécharger la vidéo';
    els.dlVideo.disabled = !state.hasVideo; els.dlWav.disabled = false;
  }
});

refreshOutputs();
