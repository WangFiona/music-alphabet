// Pitch detection (YIN algorithm) + note helpers.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
function midiToName(m) {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

/**
 * Returns { freq, rms }. freq is 0 when the input is silent/unpitched.
 * buf: Float32Array of time-domain samples (2048 works well).
 */
function detectPitch(buf, sampleRate, gate) {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < gate) return { freq: 0, rms };

  const minTau = Math.max(2, Math.floor(sampleRate / 1400)); // ~F6
  const maxTau = Math.min(Math.floor(sampleRate / 60), Math.floor(buf.length / 2)); // ~B1
  const W = buf.length - maxTau;

  // difference function
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const v = buf[j] - buf[j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  const c = new Float32Array(maxTau + 1);
  c[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    run += d[tau];
    c[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }

  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (c[t] < 0.15) {
      while (t + 1 <= maxTau && c[t + 1] < c[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    let best = minTau;
    for (let t = minTau; t <= maxTau; t++) if (c[t] < c[best]) best = t;
    if (c[best] < 0.3) tau = best;
    else return { freq: 0, rms };
  }

  // parabolic interpolation for sub-sample accuracy
  let better = tau;
  if (tau > 1 && tau < maxTau) {
    const a = c[tau - 1], b = c[tau], g = c[tau + 1];
    const den = a + g - 2 * b;
    if (den !== 0) better = tau + (a - g) / (2 * den);
  }
  return { freq: sampleRate / better, rms };
}
