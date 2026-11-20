(() => {
  const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const W = 1000, H = 1000, PAD = 16; // logical drawing units; canvases are scaled to fit
  const EXPORT_SCALE = 3;             // saved PNG/JPG are 3000 × 3000 px
  const RANGES = {
    bass:     { lo: 40, hi: 64, label: 'Bass · E2–E4' },
    baritone: { lo: 43, hi: 67, label: 'Baritone · G2–G4' },
    tenor:    { lo: 48, hi: 72, label: 'Tenor · C3–C5' },
    alto:     { lo: 53, hi: 77, label: 'Alto · F3–F5' },
    soprano:  { lo: 60, hi: 84, label: 'Soprano · C4–C6' },
    wide:     { lo: 45, hi: 81, label: 'Wide · A2–A5' },
  };
  const SWATCHES = ['#000000', '#e5383b', '#ff8c42', '#2a9d8f', '#3a6ea5', '#8e44ad'];

  const $ = (s) => document.querySelector(s);
  const drawCv = $('#draw'), dctx = drawCv.getContext('2d');
  const overCv = $('#overlay'), octx = overCv.getContext('2d');
  const wordCv = $('#word'), wctx = wordCv.getContext('2d');

  const S = {
    // settings (persisted)
    volMode: 'off', color: '#000000', width: 8, duration: 4, range: 'wide', gate: 0.01,
    // drawing state
    current: 0, strokes: [], rec: null, busy: false, micReady: false,
    // live analysis
    hist: [], voiced: 0, midi: null, rms: 0, vol: 0, jit: 0,
    // saved alphabet
    letters: {},
    // write view
    layout: null, hl: -1, playing: null,
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // ───────────────────────── settings ─────────────────────────
  const SETTINGS_KEY = 'music-alphabet-settings';
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      for (const k of ['volMode', 'color', 'width', 'duration', 'range', 'gate']) if (s[k] != null) S[k] = s[k];
      if (!RANGES[S.range]) S.range = 'wide';
    } catch (e) { /* storage unavailable */ }
  }
  function saveSettings() {
    try {
      const { volMode, color, width, duration, range, gate } = S;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ volMode, color, width, duration, range, gate }));
    } catch (e) { /* ignore */ }
  }

  function initControls() {
    const range = $('#range');
    for (const [k, r] of Object.entries(RANGES)) range.add(new Option(r.label, k));
    range.value = S.range;
    range.onchange = () => { S.range = range.value; saveSettings(); };

    const dur = $('#duration');
    dur.value = S.duration;
    dur.oninput = () => { S.duration = +dur.value; saveSettings(); updateUI(); };

    const width = $('#width');
    width.value = S.width;
    width.oninput = () => { S.width = +width.value; saveSettings(); updateUI(); };

    const gate = $('#gate');
    gate.value = S.gate;
    gate.oninput = () => { S.gate = +gate.value; saveSettings(); updateUI(); };

    document.querySelectorAll('#vol-mode button').forEach((b) => {
      b.onclick = () => { S.volMode = b.dataset.mode; saveSettings(); updateUI(); };
    });

    const color = $('#color');
    color.value = S.color;
    color.oninput = () => { S.color = color.value; saveSettings(); updateUI(); };
    const sw = $('#swatches');
    for (const c of SWATCHES) {
      const b = document.createElement('button');
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.onclick = () => { S.color = c; color.value = c; saveSettings(); updateUI(); };
      sw.appendChild(b);
    }

    $('#enable-mic').onclick = enableMic;
    $('#stroke-btn').onclick = () => (S.rec ? endStroke() : startStroke());
    $('#undo-btn').onclick = undo;
    $('#clear-btn').onclick = clearLetter;
    $('#save-btn').onclick = saveLetter;

    document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.view)));

    const input = $('#word-input');
    input.oninput = () => {
      const clean = input.value.toUpperCase().replace(/[^A-Z ]/g, '');
      if (clean !== input.value) input.value = clean;
      stopWord();
      renderWord();
    };
    $('#play-btn').onclick = playWord;
    $('#stop-btn').onclick = stopWord;
    $('#word-png').onclick = saveWordPNG;
    $('#word-wav').onclick = saveWordWAV;
    $('#word-score').onclick = saveWordScore;
    $('#export-all').onclick = exportAlphabet;
    $('#reset-all').onclick = resetAlphabet;
    window.addEventListener('resize', () => renderWord());

    document.addEventListener('keydown', (e) => {
      if (!$('#view-draw').classList.contains('active')) return;
      if (e.target.matches('input[type=text], input:not([type]), select, textarea')) return;
      const isShortcut = e.code === 'Space' || e.key === 'Enter';
      if (isShortcut && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      if (e.code === 'Space') { e.preventDefault(); S.rec ? endStroke() : startStroke(); }
      else if (e.key === 'Enter') { e.preventDefault(); saveLetter(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    });
  }

  function showView(v) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
    if (v === 'write') { renderWord(); $('#word-input').focus(); }
    else stopWord();
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ───────────────────────── mic ─────────────────────────
  async function enableMic() {
    const msg = $('#mic-msg');
    try {
      msg.textContent = 'Waiting for permission…';
      await AudioEngine.initMic();
      S.micReady = true;
      $('#mic-gate').classList.add('hidden');
      updateUI();
    } catch (err) {
      console.error(err);
      msg.innerHTML = 'Could not open the microphone.<br>Allow mic access and serve this page from localhost or https.';
    }
  }

  // ───────────────────────── mapping ─────────────────────────
  function midiToY(m) {
    const { lo, hi } = RANGES[S.range];
    return PAD + (1 - (m - lo) / (hi - lo)) * (H - 2 * PAD);
  }

  // ───────────────────────── main loop ─────────────────────────
  function tick(now) {
    if (S.micReady) {
      const r = detectPitch(AudioEngine.read(), AudioEngine.sampleRate(), S.gate);
      S.rms = r.rms;
      const v = clamp((20 * Math.log10(r.rms + 1e-9) + 50) / 40, 0, 1); // −50 dB … −10 dB → 0 … 1
      S.vol = S.vol * 0.6 + v * 0.4;
      if (r.freq > 0) {
        S.hist.push(freqToMidi(r.freq));
        if (S.hist.length > 5) S.hist.shift();
        S.voiced++;
      } else {
        S.hist = [];
        S.voiced = 0;
      }
      S.midi = S.voiced >= 2 ? median(S.hist) : null;
      updateReadout();
      if (S.rec) recordFrame(now);
    }
    drawOverlay(now);
    requestAnimationFrame(tick);
  }

  function updateReadout() {
    if (S.midi != null) {
      const cents = Math.round((S.midi - Math.round(S.midi)) * 100);
      $('#note').textContent = midiToName(S.midi);
      $('#hz').textContent = `${(440 * Math.pow(2, (S.midi - 69) / 12)).toFixed(1)} Hz · ${cents >= 0 ? '+' : ''}${cents}¢`;
    } else {
      $('#note').textContent = '—';
      $('#hz').textContent = '';
    }
    $('#meter-fill').style.width = `${(S.vol * 100).toFixed(1)}%`;
  }

  // ───────────────────────── strokes ─────────────────────────
  function startStroke() {
    if (!S.micReady) { toast('Enable the microphone first'); return; }
    if (S.rec || S.busy) return;
    AudioEngine.startRec();
    S.rec = { start: performance.now(), color: S.color, duration: S.duration, points: [], frames: [], samples: null, sampleRate: AudioEngine.sampleRate() };
    S.strokes.push(S.rec);
    S.jit = 0;
    updateUI();
  }

  function recordFrame(now) {
    const st = S.rec;
    const t = (now - st.start) / 1000;
    if (t >= st.duration) { endStroke(); return; }
    st.frames.push({ t: +t.toFixed(4), midi: S.midi == null ? null : +S.midi.toFixed(2), rms: +S.rms.toFixed(4) });

    const last = st.points[st.points.length - 1];
    if (S.midi == null) {
      if (last) st.points.push(null); // pen up
      return;
    }
    let y = midiToY(S.midi);
    let w = S.width;
    if (S.volMode === 'thickness') w = S.width * (0.15 + 1.85 * S.vol);
    if (S.volMode === 'jitter') {
      S.jit = S.jit * 0.35 + (Math.random() * 2 - 1) * 0.65;
      y += S.jit * (0.25 + S.vol) * H * 0.035;
    }
    const p = { x: +((t / st.duration) * W).toFixed(1), y: +clamp(y, PAD, H - PAD).toFixed(1), w: +w.toFixed(2) };
    drawSeg(dctx, last || null, p, st.color);
    st.points.push(p);
  }

  async function endStroke() {
    const st = S.rec;
    if (!st) return;
    S.rec = null;
    S.busy = true;
    updateUI();
    const samples = await AudioEngine.stopRec();
    st.samples = samples.subarray(0, Math.round(st.duration * st.sampleRate)).slice();
    S.busy = false;
    updateUI();
  }

  function drawSeg(ctx, a, b, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!a) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.w / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.lineWidth = (a.w + b.w) / 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function renderStrokes(ctx, strokes) {
    for (const st of strokes) {
      let prev = null;
      for (const p of st.points) {
        if (!p) { prev = null; continue; }
        drawSeg(ctx, prev, p, st.color);
        prev = p;
      }
    }
  }

  function redraw() {
    dctx.clearRect(0, 0, W, H);
    renderStrokes(dctx, S.strokes);
  }

  // match the canvas backing store to its on-screen size × devicePixelRatio so lines stay sharp
  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.round($('#stage').clientWidth * dpr));
    for (const [cv, ctx] of [[drawCv, dctx], [overCv, octx]]) {
      if (cv.width !== px) { cv.width = px; cv.height = px; }
      ctx.setTransform(px / W, 0, 0, px / H, 0, 0);
    }
    redraw();
  }

  function undo() {
    if (S.rec || S.busy || !S.strokes.length) return;
    S.strokes.pop();
    redraw();
    updateUI();
  }

  function clearLetter() {
    if (S.rec || S.busy || !S.strokes.length) return;
    S.strokes = [];
    redraw();
    updateUI();
  }

  // ───────────────────────── overlay (grid + cursor; never exported) ─────────────────────────
  function drawOverlay(now) {
    octx.clearRect(0, 0, W, H);
    const { lo, hi } = RANGES[S.range];
    const semitonePx = (H - 2 * PAD) / (hi - lo);
    const smallFont = clamp(semitonePx * 0.8, 13, 20);
    octx.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      const y = midiToY(m);
      const pc = m % 12;
      const natural = [0, 2, 4, 5, 7, 9, 11].includes(pc);
      octx.strokeStyle = pc === 0 ? 'rgba(0,0,0,.28)' : natural ? 'rgba(0,0,0,.1)' : 'rgba(0,0,0,.04)';
      octx.lineWidth = pc === 0 ? 2 : 1.5;
      octx.beginPath();
      octx.moveTo(0, y);
      octx.lineTo(W, y);
      octx.stroke();
      if (natural) {
        // label sits in a white tag on the left edge so it stays readable over ink
        const label = midiToName(m);
        octx.font = pc === 0 ? `600 ${smallFont + 6}px Futura, "Futura PT", Jost, sans-serif`
                             : `500 ${smallFont}px Futura, "Futura PT", Jost, sans-serif`;
        const tw = octx.measureText(label).width;
        octx.fillStyle = 'rgba(255,255,255,.85)';
        octx.fillRect(4, y - smallFont * 0.6, tw + 12, smallFont * 1.2);
        octx.fillStyle = pc === 0 ? '#000' : 'rgba(0,0,0,.5)';
        octx.fillText(label, 10, y);
      }
    }
    // one faint vertical line per second
    const dur = S.rec ? S.rec.duration : S.duration;
    octx.strokeStyle = 'rgba(0,0,0,.06)';
    octx.lineWidth = 1.5;
    for (let s = 1; s < dur; s++) {
      const x = (s / dur) * W;
      octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke();
    }

    let x = 0;
    if (S.rec) {
      x = clamp(((now - S.rec.start) / 1000 / S.rec.duration) * W, 0, W);
      octx.strokeStyle = '#000';
      octx.lineWidth = 2;
      octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke();
    }
    if (S.midi != null) {
      const y = clamp(midiToY(S.midi), PAD, H - PAD);
      octx.strokeStyle = S.color;
      octx.lineWidth = 3;
      octx.beginPath();
      octx.arc(Math.max(x, 12), y, 12, 0, Math.PI * 2);
      octx.stroke();
    }
  }

  // ───────────────────────── saving letters ─────────────────────────
  const canvasBlob = (cv, type, q) => new Promise((res) => cv.toBlob(res, type, q));

  function flatten(cv, bg) {
    const c = document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    const x = c.getContext('2d');
    x.fillStyle = bg;
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(cv, 0, 0);
    return c;
  }

  // high-resolution render of the strokes for export
  function renderHiRes(strokes) {
    const c = document.createElement('canvas');
    c.width = W * EXPORT_SCALE;
    c.height = H * EXPORT_SCALE;
    const ctx = c.getContext('2d');
    ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    renderStrokes(ctx, strokes);
    return c;
  }

  // horizontal extent of the ink (logical units), used to space letters nicely in words
  function findCrop(strokes) {
    let x0 = W, x1 = -1;
    for (const st of strokes) for (const p of st.points) {
      if (!p) continue;
      x0 = Math.min(x0, p.x - p.w / 2);
      x1 = Math.max(x1, p.x + p.w / 2);
    }
    if (x1 < 0) return { x0: 0, x1: W };
    return { x0: Math.max(0, Math.floor(x0 - 12)), x1: Math.min(W, Math.ceil(x1 + 12)) };
  }

  async function saveLetter() {
    if (S.rec || S.busy) return;
    if (!S.strokes.length) { toast('Sing at least one stroke first'); return; }
    const L = ALPHABET[S.current];
    const strokes = S.strokes.map(({ color, duration, points, frames, samples, sampleRate }) => ({ color, duration, points, frames, samples, sampleRate }));
    const sampleRate = strokes[0].sampleRate;
    const duration = Math.max(...strokes.map((s) => s.duration));
    const hi = renderHiRes(strokes);
    const rec = {
      letter: L,
      png: await canvasBlob(hi, 'image/png'),
      jpg: await canvasBlob(flatten(hi, '#ffffff'), 'image/jpeg', 0.95),
      crop: findCrop(strokes),
      sampleRate,
      duration,
      strokes,
      mix: AudioEngine.mix(strokes.map((s) => s.samples)),
      xml: Score.build(`Letter ${L}`, strokes.map((s) => s.frames), duration),
      savedAt: Date.now(),
    };
    try { await Store.put(rec); } catch (e) { console.warn('Could not persist letter', e); }
    await attachImage(rec);
    if (S.letters[L] && S.letters[L].url) URL.revokeObjectURL(S.letters[L].url);
    S.letters[L] = rec;

    if ($('#auto-download').checked) await downloadFiles(letterFiles(rec), `letter_${L}.zip`);

    S.strokes = [];
    redraw();
    toast(`${L} saved`);
    advance();
    renderStrip();
    updateUI();
  }

  function attachImage(rec) {
    rec.url = URL.createObjectURL(rec.png);
    rec.img = new Image();
    return new Promise((res) => { rec.img.onload = res; rec.img.onerror = res; rec.img.src = rec.url; });
  }

  function letterFiles(rec, folder = '') {
    const L = rec.letter;
    const files = [
      [`${folder}${L}.png`, rec.png],
      [`${folder}${L}.jpg`, rec.jpg],
      [`${folder}${L}_combined.wav`, AudioEngine.encodeWAV(rec.mix, rec.sampleRate)],
      [`${folder}${L}_score.musicxml`, new Blob([rec.xml], { type: 'application/vnd.recordare.musicxml+xml' })],
    ];
    rec.strokes.forEach((s, i) => files.push([`${folder}${L}_stroke${i + 1}.wav`, AudioEngine.encodeWAV(s.samples, s.sampleRate)]));
    return files;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function downloadFiles(files, zipName) {
    if (window.JSZip) {
      const zip = new JSZip();
      for (const [name, blob] of files) zip.file(name, blob);
      download(await zip.generateAsync({ type: 'blob' }), zipName);
    } else {
      // offline fallback: individual downloads
      for (const [name, blob] of files) { download(blob, name.replace(/\//g, '_')); await new Promise((r) => setTimeout(r, 250)); }
    }
  }

  function advance() {
    for (let k = 1; k <= ALPHABET.length; k++) {
      const i = (S.current + k) % ALPHABET.length;
      if (!S.letters[ALPHABET[i]]) { S.current = i; return; }
    }
    toast('Alphabet complete! Head to Write.');
    setTimeout(() => showView('write'), 1200);
  }

  function selectLetter(i) {
    if (S.rec || S.busy) return;
    if (S.strokes.length && !confirm('Discard the strokes on the current letter?')) return;
    S.current = i;
    S.strokes = [];
    redraw();
    renderStrip();
    updateUI();
  }

  // ───────────────────────── UI state ─────────────────────────
  function renderStrip() {
    const strip = $('#strip');
    strip.innerHTML = '';
    ALPHABET.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'cell' + (S.letters[L] ? ' done' : '') + (i === S.current ? ' current' : '');
      b.title = S.letters[L] ? `Redraw ${L}` : `Draw ${L}`;
      b.innerHTML = `<span>${L}</span>`;
      if (S.letters[L]) {
        const img = document.createElement('img');
        img.src = S.letters[L].url;
        img.alt = L;
        b.appendChild(img);
      }
      b.onclick = () => selectLetter(i);
      strip.appendChild(b);
    });
  }

  function updateUI() {
    const n = S.strokes.length;
    $('#current-letter').textContent = ALPHABET[S.current];
    $('#stroke-count').textContent = `${n} stroke${n === 1 ? '' : 's'}${S.letters[ALPHABET[S.current]] ? ' · redrawing' : ''}`;

    const sb = $('#stroke-btn');
    sb.classList.toggle('rec', !!S.rec);
    sb.innerHTML = S.rec ? 'Stop stroke <kbd>space</kbd>' : S.busy ? 'Saving take…' : 'Sing stroke <kbd>space</kbd>';
    sb.disabled = S.busy;
    $('#undo-btn').disabled = !n || !!S.rec || S.busy;
    $('#clear-btn').disabled = !n || !!S.rec || S.busy;
    $('#save-btn').disabled = !n || !!S.rec || S.busy;

    $('#duration').disabled = n > 0; // keep every stroke of a letter the same length
    $('#duration-val').textContent = `${S.duration.toFixed(1)} s`;
    $('#width-val').textContent = S.width;
    $('#gate-val').textContent = S.gate.toFixed(3);
    $('#meter-gate').style.left = `${(clamp((20 * Math.log10(S.gate) + 50) / 40, 0, 1) * 100).toFixed(1)}%`;
    document.querySelectorAll('#vol-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.volMode));
    document.querySelectorAll('#swatches button').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === S.color.toLowerCase()));
  }

  // ───────────────────────── write view ─────────────────────────
  function layoutWord(text, maxW, GH) {
    const scale = GH / H;
    const gap = GH * 0.05, space = GH * 0.35, lineGap = GH * 0.12;
    const words = text.trim().split(/ +/).filter(Boolean);
    const glyphs = [];
    let x = 0, y = 0, widest = 0;
    words.forEach((word, wi) => {
      const items = [...word].map((ch) => {
        const rec = S.letters[ch];
        return { ch, rec, w: rec ? (rec.crop.x1 - rec.crop.x0) * scale : GH * 0.45, word: wi };
      });
      const ww = items.reduce((s, g) => s + g.w, 0) + gap * (items.length - 1);
      if (x > 0 && x + space + ww > maxW) { x = 0; y += GH + lineGap; }
      else if (x > 0) x += space;
      for (const g of items) {
        if (x > 0 && x + g.w > maxW) { x = 0; y += GH + lineGap; } // a single very long word
        g.x = x; g.y = y;
        glyphs.push(g);
        x += g.w + gap;
        widest = Math.max(widest, x - gap);
      }
    });
    return { glyphs, width: Math.ceil(widest), height: glyphs.length ? Math.ceil(y + GH) : 0, GH };
  }

  function paintWord(ctx, layout, { placeholders, highlight }) {
    const { GH } = layout;
    layout.glyphs.forEach((g, i) => {
      if (g.rec) {
        const { x0, x1 } = g.rec.crop;
        const k = (g.rec.img.naturalWidth || W) / W; // older letters were saved at 1000 px
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(g.rec.img, x0 * k, 0, (x1 - x0) * k, H * k, g.x, g.y, g.w, GH);
      } else if (placeholders) {
        ctx.save();
        ctx.strokeStyle = '#cfcfcf';
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(g.x + 2, g.y + 2, g.w - 4, GH - 4);
        ctx.fillStyle = '#bdbdbd';
        ctx.font = `500 ${GH * 0.3}px Futura, "Futura PT", Jost, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.ch, g.x + g.w / 2, g.y + GH / 2);
        ctx.restore();
      }
      if (i === highlight) {
        ctx.fillStyle = '#000';
        ctx.fillRect(g.x, g.y + GH + 4, g.w, 4);
      }
    });
  }

  function renderWord() {
    const wrap = $('#word-wrap');
    if (!wrap.offsetParent) return; // view hidden
    const text = $('#word-input').value;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth - 48;
    const GH = Math.min(200, Math.max(90, cssW / 5)) * dpr;
    const layout = layoutWord(text, cssW * dpr, GH);
    S.layout = layout;
    wordCv.width = Math.max(1, Math.round(cssW * dpr));
    wordCv.height = Math.max(1, layout.height + 12 * dpr);
    wordCv.style.height = `${wordCv.height / dpr}px`;
    wctx.clearRect(0, 0, wordCv.width, wordCv.height);
    paintWord(wctx, layout, { placeholders: true, highlight: S.hl });
    $('#word-empty').classList.toggle('hidden', layout.glyphs.length > 0);
  }

  function wordSequence() {
    const layout = S.layout || layoutWord($('#word-input').value, 1e9, 200);
    const trim = $('#trim').checked;
    const seq = [];
    layout.glyphs.forEach((g, i) => {
      if (i > 0 && g.word !== layout.glyphs[i - 1].word) seq.push({ gap: 0.5 });
      if (g.rec) seq.push({ i, sr: g.rec.sampleRate, samples: trim ? AudioEngine.trimSilence(g.rec.mix, g.rec.sampleRate) : g.rec.mix });
      else seq.push({ i, gap: 0.3 });
    });
    return seq;
  }

  function playWord() {
    stopWord();
    const seq = wordSequence();
    if (!seq.some((s) => s.samples)) { toast('None of these letters are drawn yet'); return; }
    const ctx = AudioEngine.getCtx();
    let t = ctx.currentTime + 0.1;
    const sources = [], sched = [];
    for (const item of seq) {
      if (item.samples) {
        const b = ctx.createBuffer(1, item.samples.length, item.sr);
        b.copyToChannel(item.samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(ctx.destination);
        src.start(t);
        sources.push(src);
        sched.push({ i: item.i, start: t, end: t + b.duration });
        t += b.duration;
      } else {
        if (item.i != null) sched.push({ i: item.i, start: t, end: t + item.gap });
        t += item.gap;
      }
    }
    const playing = { sources, sched, end: t };
    S.playing = playing;
    const step = () => {
      if (S.playing !== playing) return;
      const now = ctx.currentTime;
      const cur = sched.find((s) => now >= s.start && now < s.end);
      const hl = cur ? cur.i : -1;
      if (hl !== S.hl) { S.hl = hl; renderWord(); }
      if (now < playing.end) requestAnimationFrame(step);
      else stopWord();
    };
    requestAnimationFrame(step);
  }

  function stopWord() {
    if (S.playing) {
      for (const s of S.playing.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
      S.playing = null;
    }
    if (S.hl !== -1) { S.hl = -1; renderWord(); }
  }

  function wordName() {
    return ($('#word-input').value.trim().replace(/ +/g, '_') || 'word').toLowerCase();
  }

  async function saveWordPNG() {
    const text = $('#word-input').value;
    const GH = 900; // letter height in the exported word image
    const layout = layoutWord(text, GH * 10, GH);
    if (!layout.glyphs.some((g) => g.rec)) { toast('Nothing to save yet'); return; }
    const m = 80;
    const c = document.createElement('canvas');
    c.width = layout.width + m * 2;
    c.height = layout.height + m * 2;
    const x = c.getContext('2d');
    x.translate(m, m);
    paintWord(x, layout, { placeholders: false, highlight: -1 });
    download(await canvasBlob(c, 'image/png'), `${wordName()}.png`);
  }

  function saveWordWAV() {
    const seq = wordSequence();
    const first = seq.find((s) => s.samples);
    if (!first) { toast('Nothing to save yet'); return; }
    const sr = first.sr;
    const parts = seq.map((s) => (s.samples ? s.samples : new Float32Array(Math.round(s.gap * sr))));
    download(AudioEngine.encodeWAV(AudioEngine.concat(parts), sr), `${wordName()}.wav`);
  }

  function saveWordScore() {
    const words = $('#word-input').value.trim().split(/ +/).filter(Boolean);
    const items = [];
    for (const word of words) {
      const letters = [...word].map((ch) => S.letters[ch]).filter(Boolean);
      if (!letters.length) continue;
      if (items.length) items.push('gap');
      for (const r of letters) items.push({ letter: r.letter, strokeFrames: r.strokes.map((s) => s.frames), duration: r.duration });
    }
    if (!items.length) { toast('Nothing to save yet'); return; }
    const xml = Score.buildWord(words.join(' '), items);
    download(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${wordName()}_score.musicxml`);
  }

  async function exportAlphabet() {
    const recs = ALPHABET.map((L) => S.letters[L]).filter(Boolean);
    if (!recs.length) { toast('No letters saved yet'); return; }
    if (!window.JSZip) { toast('Export needs an internet connection (JSZip)'); return; }
    toast('Preparing zip…');
    const files = recs.flatMap((r) => letterFiles(r, `${r.letter}/`));
    await downloadFiles(files, 'music_alphabet.zip');
  }

  async function resetAlphabet() {
    if (!confirm('Delete every saved letter? This cannot be undone.')) return;
    stopWord();
    try { await Store.clear(); } catch (e) { console.warn(e); }
    for (const r of Object.values(S.letters)) if (r.url) URL.revokeObjectURL(r.url);
    S.letters = {};
    S.current = 0;
    renderStrip();
    renderWord();
    updateUI();
    toast('Alphabet cleared');
  }

  // ───────────────────────── boot ─────────────────────────
  async function boot() {
    loadSettings();
    initControls();
    try {
      const recs = await Store.getAll();
      await Promise.all(recs.map(attachImage));
      for (const r of recs) S.letters[r.letter] = r;
      const firstMissing = ALPHABET.findIndex((L) => !S.letters[L]);
      S.current = firstMissing >= 0 ? firstMissing : 0;
    } catch (e) {
      console.warn('Could not load saved letters', e);
    }
    renderStrip();
    updateUI();
    resizeCanvases();
    new ResizeObserver(resizeCanvases).observe($('#stage'));
    requestAnimationFrame(tick);
  }

  boot();
})();
