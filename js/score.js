// Turns the pitch track of each stroke into a MusicXML score.
// Opens in MuseScore, Finale, Sibelius, Dorico, flat.io, etc.
// Each stroke becomes its own staff, all playing at the same time (like the overlay recording).

const Score = (() => {
  const STEP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  // durations in 16th notes → [type, dotted]
  const DUR = { 16: ['whole', 0], 12: ['half', 1], 8: ['half', 0], 6: ['quarter', 1], 4: ['quarter', 0], 3: ['eighth', 1], 2: ['eighth', 0], 1: ['16th', 0] };
  const CHUNKS = [16, 12, 8, 6, 4, 3, 2, 1];

  function mode(arr) {
    const counts = {};
    let best = arr[0], bc = 0;
    for (const v of arr) { counts[v] = (counts[v] || 0) + 1; if (counts[v] > bc) { bc = counts[v]; best = v; } }
    return best;
  }

  // Quantise a pitch track onto a 16th-note grid.
  function quantise(frames, slots, duration) {
    const slotDur = duration / slots;
    const buckets = Array.from({ length: slots }, () => []);
    const counts = new Array(slots).fill(0);
    for (const f of frames) {
      const i = Math.floor(f.t / slotDur);
      if (i < 0 || i >= slots) continue;
      counts[i]++;
      if (f.midi != null) buckets[i].push(Math.round(f.midi));
    }
    const seq = buckets.map((b, i) => (b.length > 0 && b.length >= counts[i] / 2 ? mode(b) : null));
    // smooth out one-slot wobbles between two equal notes
    for (let i = 1; i < slots - 1; i++) {
      if (seq[i - 1] != null && seq[i - 1] === seq[i + 1] && seq[i] !== seq[i - 1]) seq[i] = seq[i - 1];
    }
    return seq;
  }

  function split(len) {
    const out = [];
    while (len > 0) { const c = CHUNKS.find((x) => x <= len); out.push(c); len -= c; }
    return out;
  }

  function noteXML(midi, d, tieStart, tieStop) {
    const [type, dot] = DUR[d];
    const dotXML = dot ? '<dot/>' : '';
    if (midi == null) return `<note><rest/><duration>${d}</duration><type>${type}</type>${dotXML}</note>`;
    const [step, alter] = STEP[midi % 12];
    const oct = Math.floor(midi / 12) - 1;
    let tie = '', tied = '';
    if (tieStop) { tie += '<tie type="stop"/>'; tied += '<tied type="stop"/>'; }
    if (tieStart) { tie += '<tie type="start"/>'; tied += '<tied type="start"/>'; }
    return `<note><pitch><step>${step}</step>${alter ? '<alter>1</alter>' : ''}<octave>${oct}</octave></pitch>` +
      `<duration>${d}</duration>${tie}<type>${type}</type>${dotXML}${tied ? `<notations>${tied}</notations>` : ''}</note>`;
  }

  /**
   * A section is a run of bars: one drawn letter, or a rest between words.
   * { label, bpm, measures, seqs: [16th-grid pitch array per stroke] }
   * The stroke length is mapped onto whole 4/4 bars; tempo is chosen to fit.
   */
  function letterSection(label, strokeFrames, duration) {
    const measures = Math.max(1, Math.round(duration / 2));
    const bpm = Math.round((measures * 4 * 60) / duration);
    const seqs = strokeFrames.map((f) => quantise(f, measures * 16, duration));
    return { label, bpm, measures, seqs };
  }
  const restSection = () => ({ label: null, bpm: null, measures: 1, seqs: [] });

  function partXML(id, p, sections) {
    const voiced = sections.flatMap((s) => (s.seqs[p] || []).filter((m) => m != null));
    const avg = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 67;
    const clef = avg < 57 ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>';
    let xml = `<part id="${id}">`;
    let number = 1, lastBpm = null;
    for (const sec of sections) {
      const seq = sec.seqs[p] || new Array(sec.measures * 16).fill(null);
      for (let m = 0; m < sec.measures; m++, number++) {
        xml += `<measure number="${number}">`;
        if (number === 1) {
          xml += `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>${clef}</attributes>`;
        }
        if (m === 0 && p === 0) {
          if (sec.label) xml += `<direction placement="above"><direction-type><rehearsal>${sec.label}</rehearsal></direction-type></direction>`;
          if (sec.bpm && sec.bpm !== lastBpm) {
            xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${sec.bpm}</per-minute></metronome></direction-type><sound tempo="${sec.bpm}"/></direction>`;
            lastBpm = sec.bpm;
          }
        }
        const base = m * 16;
        let i = 0;
        while (i < 16) {
          let j = i;
          while (j < 16 && seq[base + j] === seq[base + i]) j++;
          const pitch = seq[base + i];
          // ties only within a letter, never across letters
          const tieIn = pitch != null && i === 0 && m > 0 && seq[base - 1] === pitch;
          const tieOut = pitch != null && j === 16 && m < sec.measures - 1 && seq[base + 16] === pitch;
          const parts = split(j - i);
          parts.forEach((d, k) => {
            xml += noteXML(pitch, d, k < parts.length - 1 || tieOut, k > 0 || tieIn);
          });
          i = j;
        }
        xml += '</measure>';
      }
    }
    return xml + '</part>';
  }

  function assemble(title, sections) {
    const nParts = Math.max(1, ...sections.map((s) => s.seqs.length));
    let list = '', parts = '';
    for (let p = 0; p < nParts; p++) {
      const id = `P${p + 1}`;
      list += `<score-part id="${id}"><part-name>Stroke ${p + 1}</part-name></score-part>`;
      parts += partXML(id, p, sections);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
      `<score-partwise version="3.1"><work><work-title>${title}</work-title></work>` +
      `<part-list>${list}</part-list>${parts}</score-partwise>\n`;
  }

  /** One letter: strokeFrames = array of [{t (s), midi|null}], duration = stroke length (s). */
  function build(title, strokeFrames, duration) {
    return assemble(title, [letterSection(null, strokeFrames, duration)]);
  }

  /**
   * A word: items = [{ letter, strokeFrames, duration } | 'gap'].
   * Letters follow each other; a bar of rest separates words; each letter is marked above the staff.
   */
  function buildWord(title, items) {
    const sections = items.map((it) => (it === 'gap' ? restSection() : letterSection(it.letter, it.strokeFrames, it.duration)));
    return assemble(title, sections);
  }

  return { build, buildWord };
})();
