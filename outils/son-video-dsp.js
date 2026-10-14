/*
 * TK Digital — Studio Son : moteur de traitement audio (Web Worker)
 * Tout est calculé localement dans le navigateur, aucun envoi de fichier.
 *
 * Chaîne : réparation saturation → coupe-bas → anti-ronflement 50/60 Hz →
 * débruitage spectral (Wiener « decision-directed ») → EQ auto voix + clarté →
 * de-esser → compresseur → nettoyage des silences → normalisation LUFS
 * (ITU-R BS.1770) → limiteur à anticipation.
 */
'use strict';

const LOG10 = Math.log(10);
const dbToLin = (db) => Math.exp((db / 20) * LOG10);
const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/* ---------------------------------------------------------------- FFT */

function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  // FFT complexe en place ; inverse = true pour la transformée inverse (non normalisée).
  function transform(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const wr = cos[k], wi = sgn * sin[k];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  return { n, transform };
}

/* ------------------------------------------------------------ Biquads */

// Coefficients RBJ (Audio EQ Cookbook).
function biquad(type, f0, fs, Q, gainDb = 0) {
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const c = Math.cos(w0), s = Math.sin(w0);
  const alpha = s / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass':
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'lowpass':
      b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * c; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * c + sa);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - sa);
      a0 = (A + 1) + (A - 1) * c + sa;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - sa; break;
    }
    case 'highshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * c + sa);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - sa);
      a0 = (A + 1) - (A - 1) * c + sa;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - sa; break;
    }
    default: throw new Error('biquad inconnu ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Filtre (forme directe II transposée). Écrit dans `out` (peut être === x).
function runBiquad(f, x, out = x) {
  let z1 = 0, z2 = 0;
  const { b0, b1, b2, a1, a2 } = f;
  for (let i = 0, n = x.length; i < n; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    out[i] = y;
  }
  return out;
}

function runChain(filters, x) {
  for (const f of filters) runBiquad(f, x);
  return x;
}

/* --------------------------------------------------------- Utilitaires */

function mixMid(chs) {
  const n = chs[0].length;
  if (chs.length === 1) return chs[0].slice();
  const m = new Float32Array(n);
  const k = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] * k;
  return m;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function samplePeak(chs) {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}

// Niveaux RMS (dBFS) par blocs courts sur le signal mono.
function blockLevels(x, fs, blockSec) {
  const L = Math.max(1, Math.round(blockSec * fs));
  const out = [];
  for (let i = 0; i + L <= x.length; i += L) {
    let s = 0;
    for (let j = i; j < i + L; j++) s += x[j] * x[j];
    const rms = Math.sqrt(s / L);
    if (rms > 1e-7) out.push(linToDb(rms));
  }
  return out;
}

/* ---------------------------------------------- Loudness (BS.1770-4) */

function kWeight(x, fs) {
  const y = Float32Array.from(x);
  runBiquad(biquad('highshelf', 1681.974450955533, fs, 0.7071752369554196, 3.999843853973347), y);
  runBiquad(biquad('highpass', 38.13547087602444, fs, 0.5003270373238773), y);
  return y;
}

function integratedLoudness(chs, fs) {
  const kw = chs.slice(0, 2).map((c) => kWeight(c, fs)); // L/R (poids 1.0)
  const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs);
  const n = kw[0].length;
  if (n < block) {
    // Signal très court : un seul bloc.
    let z = 0;
    for (const c of kw) { let s = 0; for (let i = 0; i < n; i++) s += c[i] * c[i]; z += s / Math.max(1, n); }
    return z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity;
  }
  // Somme cumulée des carrés pour des blocs rapides.
  const cums = kw.map((c) => {
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + c[i] * c[i];
    return cs;
  });
  const zs = [];
  for (let i = 0; i + block <= n; i += step) {
    let z = 0;
    for (const cs of cums) z += (cs[i + block] - cs[i]) / block;
    zs.push(z);
  }
  const lk = (z) => -0.691 + 10 * Math.log10(z);
  const abs = zs.filter((z) => z > 0 && lk(z) > -70);
  if (!abs.length) return -Infinity;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const relThr = lk(meanAbs) - 10;
  const rel = abs.filter((z) => lk(z) > relThr);
  const mean = rel.reduce((a, b) => a + b, 0) / rel.length;
  return lk(mean);
}

/* ------------------------------------------------------------ Analyse */

function detectHum(mid, fs) {
  const N = 16384;
  if (mid.length < N) return { freq: 0, prominence: 0 };
  // Le ronflement est stationnaire : on l'écoute surtout dans les passages calmes,
  // là où les harmoniques de la voix ne peuvent pas le simuler.
  const fft = makeFFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const maxSegs = 64;
  const hop = Math.max(N / 2, Math.floor((mid.length - N) / maxSegs));
  const segs = [];
  for (let off = 0; off + N <= mid.length && segs.length < maxSegs; off += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      re[i] = mid[off + i] * w; im[i] = 0; e += re[i] * re[i];
    }
    if (e < 1e-14) continue;
    fft.transform(re, im, false);
    const p = new Float32Array(Math.ceil(1100 * N / fs));
    for (let k = 0; k < p.length; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    segs.push({ e, p });
  }
  if (!segs.length) return { freq: 0, prominence: 0 };
  segs.sort((a, b) => a.e - b.e);
  const quiet = segs.slice(0, Math.max(1, Math.ceil(segs.length * 0.4)));
  const pow = new Float64Array(quiet[0].p.length);
  for (const sg of quiet) for (let k = 0; k < pow.length; k++) pow[k] += sg.p[k];
  const binHz = fs / N;
  const prom = (f) => {
    // Somme des harmoniques 1..4 : pic vs voisinage (médiane).
    let score = 0, count = 0;
    for (let h = 1; h <= 4; h++) {
      const fk = f * h, k = Math.round(fk / binHz);
      if (k + 12 >= pow.length) break;
      const peak = Math.max(pow[k - 1], pow[k], pow[k + 1]);
      const neigh = [];
      for (let d = 4; d <= 12; d++) { neigh.push(pow[k - d], pow[k + d]); }
      const med = percentile(neigh, 0.5) + 1e-20;
      score += 10 * Math.log10(peak / med); count++;
    }
    return count ? score / count : 0;
  };
  const p50 = prom(50), p60 = prom(60);
  const best = p50 >= p60 ? { freq: 50, prominence: p50 } : { freq: 60, prominence: p60 };
  return best;
}

function detectClipping(chs) {
  const peak = samplePeak(chs);
  if (peak < 0.5) return { ratio: 0, level: peak };
  const thr = peak * 0.995;
  let runs = 0, total = 0;
  for (const c of chs) {
    total += c.length;
    let run = 0;
    for (let i = 0; i < c.length; i++) {
      if (Math.abs(c[i]) >= thr) run++;
      else { if (run >= 3) runs += run; run = 0; }
    }
  }
  return { ratio: runs / total, level: peak };
}

function analyze(chs, fs) {
  const mid = mixMid(chs);
  const levels = blockLevels(mid, fs, 0.05);
  const noiseFloor = levels.length ? percentile(levels, 0.1) : -96;
  const speech = levels.length ? percentile(levels, 0.9) : -96;
  const hum = detectHum(mid, fs);
  const clip = detectClipping(chs);
  return {
    loudness: integratedLoudness(chs, fs),
    peakDb: linToDb(samplePeak(chs)),
    noiseFloorDb: noiseFloor,
    speechDb: speech,
    snrDb: speech - noiseFloor,
    hum: hum.prominence > 8 ? hum.freq : 0,
    humProminence: hum.prominence,
    clipRatio: clip.ratio,
  };
}

/* ----------------------------------------------------- Traitements */

// Reconstruction des crêtes écrêtées par interpolation cubique d'Hermite.
function declip(c) {
  let peak = 0;
  for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (peak < 0.5) return 0;
  const thr = peak * 0.995;
  let fixed = 0;
  let i = 2;
  while (i < c.length - 3) {
    if (Math.abs(c[i]) < thr) { i++; continue; }
    let j = i;
    while (j < c.length - 3 && Math.abs(c[j]) >= thr && Math.sign(c[j]) === Math.sign(c[i])) j++;
    const len = j - i;
    if (len >= 2 && len <= 200) {
      const a = i - 1, b = j;
      const ma = c[a] - c[a - 1], mb = c[b + 1] - c[b];
      const span = b - a;
      for (let k = 1; k < span; k++) {
        const t = k / span, t2 = t * t, t3 = t2 * t;
        const v = (2 * t3 - 3 * t2 + 1) * c[a] + (t3 - 2 * t2 + t) * ma * span +
          (-2 * t3 + 3 * t2) * c[b] + (t3 - t2) * mb * span;
        // La crête reconstruite ne peut pas être plus basse que le plateau d'origine.
        const s = Math.sign(c[i]);
        c[a + k] = s * Math.min(Math.max(s * v, thr), peak * 4);
      }
      fixed += len;
    }
    i = j + 1;
  }
  return fixed;
}

function humFilters(freq, fs) {
  const fl = [];
  for (let h = 1; h <= 10; h++) {
    const f = freq * h;
    if (f > fs * 0.45 || f > 1000) break;
    fl.push(biquad('notch', f, fs, f / 2.5));
  }
  return fl;
}

/*
 * Débruitage spectral : STFT (fenêtre racine de Hann, 75 % de recouvrement),
 * profil de bruit estimé sur les trames les plus calmes, gain de Wiener
 * « decision-directed » (Ephraim–Malah) avec plancher et lissage fréquentiel
 * pour éviter le « bruit musical ». Les gains sont calculés sur le signal mono
 * et appliqués à chaque canal pour préserver l'image stéréo.
 */
function spectralDenoise(chs, fs, strength, progress) {
  const N = fs >= 32000 ? 2048 : 1024;
  const hop = N / 4;
  const bins = N / 2 + 1;
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const len = chs[0].length;
  const pad = N;
  const total = len + 2 * pad;
  const frames = Math.floor((total - N) / hop) + 1;
  const mid = mixMid(chs);
  const midP = new Float32Array(total); midP.set(mid, pad);

  // 1) Énergie par trame → seuil des trames « bruit ».
  const energies = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const off = f * hop;
    for (let i = 0; i < N; i++) { const v = midP[off + i] * win[i]; e += v * v; }
    energies[f] = e;
  }
  const nonZero = Array.from(energies).filter((e) => e > 1e-14);
  const thr = nonZero.length ? percentile(nonZero, 0.12) : 0;

  // 2) Profil de bruit moyen sur ces trames.
  const re = new Float64Array(N), im = new Float64Array(N);
  const noise = new Float64Array(bins);
  let nCount = 0;
  for (let f = 0; f < frames; f++) {
    const e = energies[f];
    if (e <= 1e-14 || e > thr) continue;
    const off = f * hop;
    for (let i = 0; i < N; i++) { re[i] = midP[off + i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);
    for (let k = 0; k < bins; k++) noise[k] += re[k] * re[k] + im[k] * im[k];
    nCount++;
  }
  if (!nCount) return;
  // Lissage du profil (évite les trous) + marge.
  const prof = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let s = 0, c = 0;
    for (let d = -2; d <= 2; d++) { const kk = k + d; if (kk >= 0 && kk < bins) { s += noise[kk]; c++; } }
    prof[k] = Math.max((s / c) / nCount, 1e-14);
  }

  const st = strength / 100;
  const beta = 1 + st * 1.6;                       // sur-soustraction
  const floor = dbToLin(-(6 + st * 26));           // jusqu'à -32 dB
  const alpha = 0.97;
  const prevPow = new Float64Array(bins);
  const prevGain = new Float64Array(bins).fill(1);
  const gain = new Float64Array(bins);
  const gSm = new Float64Array(bins);

  // Stéréo : les deux canaux sont empaquetés dans une seule FFT complexe
  // (G + iD), puis séparés ; le spectre mono en découle par linéarité.
  const stereo = chs.length >= 2;
  const outs = chs.map(() => new Float64Array(total));
  const xs = chs.map((c) => { const p = new Float32Array(total); p.set(c, pad); return p; });
  const rL = new Float64Array(bins), iL = new Float64Array(bins);
  const rR = new Float64Array(bins), iR = new Float64Array(bins);
  const reportEvery = Math.max(1, Math.floor(frames / 50));

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    if (stereo) {
      const a = xs[0], b = xs[1];
      for (let i = 0; i < N; i++) { re[i] = a[off + i] * win[i]; im[i] = b[off + i] * win[i]; }
      fft.transform(re, im, false);
      for (let k = 0; k < bins; k++) {
        const j = (N - k) % N;
        rL[k] = 0.5 * (re[k] + re[j]); iL[k] = 0.5 * (im[k] - im[j]);
        rR[k] = 0.5 * (im[k] + im[j]); iR[k] = -0.5 * (re[k] - re[j]);
      }
    } else {
      for (let i = 0; i < N; i++) { re[i] = midP[off + i] * win[i]; im[i] = 0; }
      fft.transform(re, im, false);
      for (let k = 0; k < bins; k++) { rL[k] = re[k]; iL[k] = im[k]; }
    }
    for (let k = 0; k < bins; k++) {
      const mr = stereo ? 0.5 * (rL[k] + rR[k]) : rL[k];
      const mi = stereo ? 0.5 * (iL[k] + iR[k]) : iL[k];
      const p = mr * mr + mi * mi;
      const nk = prof[k] * beta;
      const post = p / nk;
      const prior = alpha * (prevGain[k] * prevGain[k] * prevPow[k]) / nk + (1 - alpha) * Math.max(post - 1, 0);
      let g = prior / (1 + prior);
      if (g < floor) g = floor;
      gain[k] = g;
      prevPow[k] = p;
    }
    // Lissage fréquentiel léger (plus large dans les aigus).
    for (let k = 0; k < bins; k++) {
      const w = k < bins / 8 ? 1 : 2;
      let s = 0, c = 0;
      for (let d = -w; d <= w; d++) { const kk = k + d; if (kk >= 0 && kk < bins) { s += gain[kk]; c++; } }
      gSm[k] = s / c;
    }
    for (let k = 0; k < bins; k++) prevGain[k] = gSm[k];

    // Reconstruction : Y = G·L + i·G·R (les deux sorties réelles).
    for (let k = 0; k < bins; k++) {
      const g = gSm[k];
      const lr = rL[k] * g, li = iL[k] * g;
      const sr = stereo ? rR[k] * g : 0, si = stereo ? iR[k] * g : 0;
      re[k] = lr - si; im[k] = li + sr;
      if (k > 0 && k < N / 2) { re[N - k] = lr + si; im[N - k] = -li + sr; }
    }
    fft.transform(re, im, true);
    const o0 = outs[0], o1 = stereo ? outs[1] : null;
    for (let i = 0; i < N; i++) {
      const w = win[i] / N;
      o0[off + i] += re[i] * w;
      if (o1) o1[off + i] += im[i] * w;
    }
    if (progress && f % reportEvery === 0) progress(f / frames);
  }
  // Canaux supplémentaires (> 2) : copie du canal gauche traité.
  for (let c = 2; c < chs.length; c++) outs[c] = outs[0];
  // Somme des fenêtres de Hann à 75 % de recouvrement = 2.
  for (let c = 0; c < chs.length; c++) {
    const x = chs[c], o = outs[c];
    for (let i = 0; i < len; i++) x[i] = o[i + pad] * 0.5;
  }
}

// Spectre moyen à long terme (bandes d'octave) des passages de voix.
const EQ_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// Forme du spectre moyen de la parole (LTASS, Byrne et al. 1994), dB relatifs.
const LTASS = [-4, 0, 0, -5, -10, -13, -16, -23];

function autoEqFilters(mid, fs, amount) {
  if (amount <= 0) return [];
  const N = 4096;
  if (mid.length < N * 4) return [];
  const fft = makeFFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const band = new Float64Array(EQ_BANDS.length);
  const levels = blockLevels(mid, fs, N / fs);
  const loud = percentile(levels, 0.6);
  let used = 0;
  for (let off = 0; off + N <= mid.length; off += N) {
    let e = 0;
    for (let i = 0; i < N; i++) e += mid[off + i] * mid[off + i];
    if (linToDb(Math.sqrt(e / N)) < loud) continue; // trames de voix seulement
    for (let i = 0; i < N; i++) { re[i] = mid[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft.transform(re, im, false);
    for (let b = 0; b < EQ_BANDS.length; b++) {
      const lo = EQ_BANDS[b] / Math.SQRT2, hi = EQ_BANDS[b] * Math.SQRT2;
      const k0 = Math.max(1, Math.floor((lo * N) / fs)), k1 = Math.min(N / 2, Math.ceil((hi * N) / fs));
      for (let k = k0; k < k1; k++) band[b] += re[k] * re[k] + im[k] * im[k];
    }
    used++;
  }
  if (used < 4) return [];
  const meas = Array.from(band, (v) => 10 * Math.log10(v + 1e-20));
  // Alignement sur la zone 250 Hz – 4 kHz.
  const idx = [1, 2, 3, 4, 5];
  const off = idx.reduce((s, i) => s + (LTASS[i] - meas[i]), 0) / idx.length;
  const fl = [];
  for (let b = 0; b < EQ_BANDS.length; b++) {
    const f = EQ_BANDS[b];
    if (f >= fs * 0.45) break;
    if (b === 0) continue; // le grave est géré par le coupe-bas
    let corr = (LTASS[b] - (meas[b] + off)) * 0.6 * amount;
    // On ne remonte pas ce qui n'existe pas (micro bas de gamme, bruit) : boost limité.
    corr = Math.max(-6, Math.min(b >= 6 ? 3 : 4.5, corr));
    if (Math.abs(corr) > 0.3) fl.push(biquad('peaking', f, fs, 1.2, corr));
  }
  return fl;
}

function clarityFilters(fs, clarity) {
  const c = clarity / 100;
  if (c <= 0) return [];
  return [
    biquad('peaking', 280, fs, 1.0, -3.5 * c),     // boue
    biquad('peaking', 3200, fs, 0.9, 4 * c),       // présence / intelligibilité
    biquad('highshelf', Math.min(10000, fs * 0.4), fs, 0.7, 2.5 * c), // air
  ];
}

// De-esser large bande dynamique : réduit la bande > 5,5 kHz quand elle domine.
function deEss(chs, fs, amount) {
  if (amount <= 0 || fs < 16000) return;
  const mid = mixMid(chs);
  const hpF = biquad('highpass', 5500, fs, 0.707);
  const side = runBiquad(hpF, mid, new Float32Array(mid.length));
  const atk = Math.exp(-1 / (0.001 * fs)), rel = Math.exp(-1 / (0.06 * fs));
  let eS = 0, eF = 0;
  const g = new Float32Array(mid.length);
  const ratioThr = 0.45 - 0.2 * (amount / 100); // part de sibilance tolérée
  const maxRed = dbToLin(-(4 + 8 * (amount / 100)));
  let gs = 1;
  const gRel = Math.exp(-1 / (0.04 * fs));
  for (let i = 0; i < mid.length; i++) {
    const s = Math.abs(side[i]), f = Math.abs(mid[i]);
    eS = s > eS ? atk * eS + (1 - atk) * s : rel * eS + (1 - rel) * s;
    eF = f > eF ? atk * eF + (1 - atk) * f : rel * eF + (1 - rel) * f;
    let target = 1;
    const r = eS / (eF + 1e-9);
    if (r > ratioThr && eS > 0.003) target = Math.max(maxRed, ratioThr / r);
    gs = target < gs ? target : gRel * gs + (1 - gRel) * target;
    g[i] = gs;
  }
  for (const c of chs) {
    const hp = runBiquad(hpF, c, new Float32Array(c.length));
    for (let i = 0; i < c.length; i++) c[i] = c[i] - hp[i] * (1 - g[i]);
  }
}

// Compresseur (détection RMS lissée, genou doux) lié sur tous les canaux.
function compress(chs, fs, amount, speechDb) {
  if (amount <= 0) return;
  const a = amount / 100;
  const ratio = 1.5 + a * 3;
  const thr = speechDb - (3 + a * 9);
  const knee = 8;
  // Détecteur rapide (2 ms) : les attaques sont prises, sinon le facteur de crête augmente.
  const atk = Math.exp(-1 / (0.002 * fs)), rel = Math.exp(-1 / (0.12 * fs));
  const gAtk = Math.exp(-1 / (0.003 * fs)), gRel = Math.exp(-1 / (0.15 * fs));
  const mid = mixMid(chs);
  let env = 0, gDb = 0;
  const gainLin = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) {
    const p = mid[i] * mid[i];
    env = p > env ? atk * env + (1 - atk) * p : rel * env + (1 - rel) * p;
    const lvl = 10 * Math.log10(env + 1e-12);
    const over = lvl - thr;
    let red = 0;
    if (over > knee / 2) red = over * (1 - 1 / ratio);
    else if (over > -knee / 2) red = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    gDb = red > gDb ? gAtk * gDb + (1 - gAtk) * red : gRel * gDb + (1 - gRel) * red;
    gainLin[i] = dbToLin(-gDb);
  }
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= gainLin[i];
}

// Expandeur vers le bas : nettoie les blancs entre les phrases.
function expand(chs, fs, amount) {
  if (amount <= 0) return;
  const mid = mixMid(chs);
  const levels = blockLevels(mid, fs, 0.05);
  if (levels.length < 10) return;
  const floorDb = percentile(levels, 0.1), speech = percentile(levels, 0.9);
  if (speech - floorDb < 10) return;
  const thr = floorDb + (speech - floorDb) * 0.3;
  const maxRed = 6 + 10 * (amount / 100);
  const atk = Math.exp(-1 / (0.003 * fs)), rel = Math.exp(-1 / (0.03 * fs));
  const gAtk = Math.exp(-1 / (0.002 * fs)), gRel = Math.exp(-1 / (0.12 * fs));
  const hold = Math.round(0.12 * fs);
  let env = 0, gDb = 0, held = 0;
  const gain = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) {
    const p = mid[i] * mid[i];
    env = p > env ? atk * env + (1 - atk) * p : rel * env + (1 - rel) * p;
    const lvl = 10 * Math.log10(env + 1e-12);
    let red = 0;
    if (lvl >= thr) held = hold;
    else if (held > 0) held--;
    else red = Math.min(maxRed, (thr - lvl) * 1.0);
    gDb = red < gDb ? gAtk * gDb + (1 - gAtk) * red : gRel * gDb + (1 - gRel) * red;
    gain[i] = dbToLin(-gDb);
  }
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= gain[i];
}

// Limiteur à anticipation (hors-ligne) : aucune crête ne dépasse `ceilDb`.
function limit(chs, fs, ceilDb) {
  const ceil = dbToLin(ceilDb);
  const n = chs[0].length;
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of chs) { const a = Math.abs(c[i]); if (a > p) p = a; }
    req[i] = p > ceil ? ceil / p : 1;
  }
  const L = Math.max(1, Math.round(0.002 * fs));
  // Minimum glissant symétrique (fenêtre 2L+1) via deque.
  const mn = new Float32Array(n);
  const dq = new Int32Array(n + 2 * L + 2);
  let h = 0, t = 0;
  for (let i = 0; i < n + L; i++) {
    if (i < n) {
      while (t > h && req[dq[t - 1]] >= req[i]) t--;
      dq[t++] = i;
    }
    const center = i - L;
    if (center >= 0) {
      while (dq[h] < center - L) h++;
      mn[center] = req[dq[h]];
    }
  }
  // Moyenne glissante (même fenêtre) → transitions douces, toujours ≤ requis.
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + mn[i];
  const rel = 1 - Math.exp(-1 / (0.08 * fs));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - L), b = Math.min(n, i + L + 1);
    // Bords : on complète avec 1 (pas de réduction) mais on borne au minimum local.
    const avg = Math.min((cs[b] - cs[a] + (2 * L + 1 - (b - a))) / (2 * L + 1), mn[i]);
    g = avg < g ? avg : g + (avg - g) * rel;
    for (const c of chs) c[i] *= g;
  }
}

function applyGain(chs, db) {
  const g = dbToLin(db);
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
}


// Gain de rapport voix/bruit mesuré sur les mêmes instants avant et après :
// blocs les plus calmes (bruit) vs blocs les plus forts (voix) de l'original.
function noiseReduction(orig, out, fs) {
  const a = mixMid(orig), b = mixMid(out);
  const L = Math.round(0.05 * fs);
  const blocks = [];
  for (let i = 0; i + L <= a.length; i += L) {
    let ea = 0, eb = 0;
    for (let j = i; j < i + L; j++) { ea += a[j] * a[j]; eb += b[j] * b[j]; }
    if (ea > 1e-12 * L) blocks.push([ea, eb]);
  }
  if (blocks.length < 20) return null;
  const sorted = blocks.map((x) => x[0]).sort((x, y) => x - y);
  const lo = sorted[Math.floor(sorted.length * 0.15)], hi = sorted[Math.floor(sorted.length * 0.85)];
  if (10 * Math.log10(hi / lo) < 12) return null; // pas de vrais blancs : mesure non fiable
  let qa = 0, qb = 0, la = 0, lb = 0;
  for (const [ea, eb] of blocks) {
    if (ea <= lo) { qa += ea; qb += eb; }
    if (ea >= hi) { la += ea; lb += eb; }
  }
  return 10 * Math.log10((lb / Math.max(qb, 1e-20)) / (la / qa));
}

/* ------------------------------------------------------------ Pipeline */

function processAudio(input, fs, s, progress) {
  const chs = input.map((c) => Float32Array.from(c));
  const report = { steps: [] };
  const step = (name, base, span) => (p) => progress(base + span * p, name);

  const before = analyze(chs, fs);
  report.before = before;
  progress(0.03, 'Analyse');

  if (s.monoVoice && chs.length > 1) {
    const m = mixMid(chs);
    for (const c of chs) c.set(m);
    report.steps.push('Voix recentrée en mono');
  }

  if (s.declip && before.clipRatio > 0.00005) {
    let fixed = 0;
    for (const c of chs) fixed += declip(c);
    if (fixed) report.steps.push(`Saturation réparée (${fixed.toLocaleString('fr-FR')} échantillons)`);
  }
  progress(0.06, 'Coupe-bas');

  // Coupe-bas 24 dB/oct + suppression composante continue.
  if (s.highpass > 0) {
    const hp = biquad('highpass', s.highpass, fs, 0.5412);
    const hp2 = biquad('highpass', s.highpass, fs, 1.3066);
    for (const c of chs) runChain([hp, hp2], c);
    report.steps.push(`Coupe-bas ${s.highpass} Hz (grondements, vent, manipulations)`);
  }

  const humFreq = s.dehum === 'auto' ? before.hum : Number(s.dehum) || 0;
  if (humFreq) {
    const fl = humFilters(humFreq, fs);
    for (const c of chs) runChain(fl, c);
    report.steps.push(`Ronflement électrique ${humFreq} Hz supprimé (${fl.length} harmoniques)`);
  }
  progress(0.1, 'Débruitage');

  if (s.denoise > 0) {
    spectralDenoise(chs, fs, s.denoise, step('Débruitage', 0.1, 0.6));
    report.steps.push(`Bruit de fond réduit (intensité ${s.denoise} %)`);
  }
  progress(0.72, 'Égalisation');

  const voice = s.mode !== 'music';
  const eq = [];
  if (voice && s.autoEq) {
    const fl = autoEqFilters(mixMid(chs), fs, s.mode === 'mix' ? 0.5 : 1);
    eq.push(...fl);
    if (fl.length) report.steps.push('Égalisation automatique calée sur une voix de référence');
  }
  if (voice && s.clarity > 0) {
    eq.push(...clarityFilters(fs, s.clarity));
    report.steps.push(`Clarté de la voix +${s.clarity} %`);
  }
  for (const c of chs) runChain(eq, c);
  progress(0.78, 'De-esser');

  if (voice && s.deess > 0) {
    deEss(chs, fs, s.deess);
    report.steps.push('Sifflantes adoucies (de-esser)');
  }
  progress(0.82, 'Compression');

  if (s.compress > 0) {
    const levels = blockLevels(mixMid(chs), fs, 0.4);
    compress(chs, fs, s.compress, levels.length ? percentile(levels, 0.85) : -20);
    report.steps.push(`Volume de la voix stabilisé (compression ${s.compress} %)`);
  }
  progress(0.88, 'Silences');

  if (voice && s.expand > 0) {
    expand(chs, fs, s.expand);
    report.steps.push('Silences nettoyés entre les phrases');
  }
  progress(0.92, 'Normalisation');

  // Normalisation + limiteur, itérée pour atteindre la cible malgré le limiteur.
  const ceiling = s.ceiling ?? -1.5;
  let pre = Infinity;
  let work = chs;
  if (Number.isFinite(s.target)) {
    let gainDb = s.target - integratedLoudness(chs, fs);
    for (let it = 0; it < 10 && Number.isFinite(gainDb); it++) {
      work = chs.map((c) => Float32Array.from(c));
      applyGain(work, Math.min(gainDb, 60));
      limit(work, fs, ceiling);
      pre = integratedLoudness(work, fs);
      const err = s.target - pre;
      if (Math.abs(err) < 0.2) break;
      gainDb += err * (it ? 1.6 : 1);
    }
    report.steps.push(`Volume normalisé à ${s.target} LUFS, crêtes ≤ ${ceiling} dB`);
  } else {
    limit(work, fs, ceiling);
  }
  progress(0.98, 'Mesures finales');

  report.after = analyze(work, fs);
  report.noiseReductionDb = noiseReduction(input, work, fs);
  return { chs: work, report };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { id, type, channels, sampleRate, settings } = e.data;
    try {
      if (type === 'analyze') {
        self.postMessage({ id, type: 'analysis', analysis: analyze(channels, sampleRate) });
        return;
      }
      let last = 0;
      const { chs, report } = processAudio(channels, sampleRate, settings, (p, label) => {
        const now = Date.now();
        if (now - last > 80) { last = now; self.postMessage({ id, type: 'progress', progress: p, label }); }
      });
      self.postMessage({ id, type: 'done', channels: chs, report }, chs.map((c) => c.buffer));
    } catch (err) {
      self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
    }
  };
}

if (typeof module !== 'undefined') module.exports = { processAudio, analyze, integratedLoudness, biquad, runBiquad };
