# Music Alphabet

Draw the alphabet with your voice. Sing into the microphone: pitch moves the pen up and down, time moves it left to right. Build each letter from one or more sung strokes, save it, then type words in your own sung alphabet and play them back.

## Features

- Pitch → vertical position, time → horizontal position; multiple strokes per letter
- Volume can control nothing, line thickness, or a wobble in the line
- Each saved letter downloads as a zip:
  - transparent PNG and white-background JPG (3000 × 3000 px), plus a vector SVG
  - a WAV recording of every stroke, plus all strokes overlaid in one file
  - a MusicXML score
- Write mode: type words, see them in your letters, play the recordings in sequence, and save the word as PNG, WAV, or MusicXML
- Letters are saved in your browser (IndexedDB), so each visitor builds their own alphabet

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Microphone access needs `localhost` or `https`.

## Opening scores

Open the `.musicxml` files with [MuseScore Studio](https://musescore.org) (free), or upload them to [flat.io](https://flat.io) or [Noteflight](https://noteflight.com) in the browser.
