// Microphone, raw-PCM recorder (AudioWorklet), WAV encoding, mixing.

const AudioEngine = (() => {
  let ctx = null, analyser = null, recNode = null, buf = null;
  let recChunks = null, recResolve = null;

  const WORKLET = `
    class RecorderProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.on = false;
        this.buf = new Float32Array(4096);
        this.n = 0;
        this.port.onmessage = (e) => {
          if (e.data === 'start') { this.on = true; this.n = 0; }
          else if (e.data === 'stop') { this.flush(true); this.on = false; }
        };
      }
      flush(done) {
        this.port.postMessage({ chunk: this.buf.slice(0, this.n), done });
        this.n = 0;
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (this.on && ch) {
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === this.buf.length) this.flush(false);
          }
        }
        return true;
      }
    }
    registerProcessor('recorder', RecorderProcessor);
  `;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  async function initMic() {
    const c = getCtx();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = c.createMediaStreamSource(stream);
    analyser = c.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    buf = new Float32Array(analyser.fftSize);

    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await c.audioWorklet.addModule(url);
    recNode = new AudioWorkletNode(c, 'recorder');
    const mute = c.createGain();
    mute.gain.value = 0; // keeps the worklet running without echoing the mic
    source.connect(recNode);
    recNode.connect(mute);
    mute.connect(c.destination);

    recNode.port.onmessage = (e) => {
      const { chunk, done } = e.data;
      if (recChunks && chunk) recChunks.push(chunk);
      if (done && recResolve) {
        const out = concat(recChunks || []);
        recChunks = null;
        const r = recResolve;
        recResolve = null;
        r(out);
      }
    };
  }

  function read() { analyser.getFloatTimeDomainData(buf); return buf; }
  function startRec() { recChunks = []; recNode.port.postMessage('start'); }
  function stopRec() {
    return new Promise((res) => { recResolve = res; recNode.port.postMessage('stop'); });
  }

  function concat(arrays) {
    const len = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Float32Array(len);
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
  }

  // overlay several takes on top of each other (all start at t=0)
  function mix(arrays) {
    const len = Math.max(0, ...arrays.map((a) => a.length));
    const out = new Float32Array(len);
    for (const a of arrays) for (let i = 0; i < a.length; i++) out[i] += a[i];
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0.98) { const k = 0.98 / peak; for (let i = 0; i < len; i++) out[i] *= k; }
    return out;
  }

  function trimSilence(x, sr) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const thr = Math.max(0.01, peak * 0.08);
    const win = Math.max(1, Math.floor(sr * 0.02));
    const loud = (i) => { for (let j = i; j < Math.min(i + win, x.length); j++) if (Math.abs(x[j]) > thr) return true; return false; };
    let a = 0, b = x.length;
    for (let i = 0; i < x.length; i += win) if (loud(i)) { a = Math.max(0, i - win); break; }
    for (let i = x.length - win; i >= 0; i -= win) if (loud(i)) { b = Math.min(x.length, i + 2 * win); break; }
    return b > a ? x.subarray(a, b) : x;
  }

  function encodeWAV(samples, sr) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  return {
    getCtx, initMic, read, startRec, stopRec, concat, mix, trimSilence, encodeWAV,
    sampleRate: () => (ctx ? ctx.sampleRate : 48000),
  };
})();
