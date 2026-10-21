# CLAUDE.md

This file provides guidance to Claude Code (and other AI assistants) when working in this repository.

## Project Overview

A company-internal real-time noise analyzer web app (PWA) for field use, referencing common analyzer apps but with its own features. It opens on a live FFT spectrum (x: 20 Hz – 20 kHz, y: weighted dB per bin, A by default) under a level panel (LED bar, big current value, min / average / max, help and reset buttons), in portrait and landscape layouts. A mode bar switches between spectrum, spectrogram (time axis), both, 1/3-octave bars and a needle gauge; a graph-settings sheet sets A/C/Z weighting, fill/line, max hold, FFT size and axis. Own features: crosshair A/B cursors, a red record button kept separate from start/pause (record until stop; the recording goes to the file analysis, opened from a toast), attached-file analysis, and "save" that keeps the last N seconds of sound (rolling buffer) with the snapshot for playback and WAV sharing. Snapshots also carry vehicle number and memo, share as image + text, and export as CSV. There is no report feature (the user asked to drop it). UI text is Korean.

- **Language / runtime:** Vanilla JavaScript ES modules in the browser; Node 22 for tests
- **Framework(s):** None. Web Audio (AudioWorklet + AnalyserNode), Canvas, IndexedDB, Service Worker
- **Package manager:** npm (no runtime dependencies; `playwright` only for the e2e test)

## Repository Structure

```
index.html, css/app.css     App shell (bottom tab bar) and styles (dark only; portrait and landscape analyzer layouts)
js/app.js                   Screens + hash router (#/ analyzer, #/file attached-file analysis, #/history, #/record/<id>, #/settings); chart-settings and help sheets
js/meter.js                 Mic meter: getUserMedia -> AudioWorklet (Fast level, Leq/max/min since reset, sound ring buffer, recording) + AnalyserNode (spectrum per bin); setWeighting(A/C/Z)
js/level-processor.js       AudioWorklet: weighting biquads (replaced by an 'sos' message), energy sums, Fast (125 ms) max/min, raw-sound ring buffer (dump/pause/clear), 'record' on/off -> 0.5 s 'chunk' messages
js/spectrum.js              drawSpectrum() + SpectrumView: fill/line styles, max hold, log/linear axis fixed to 20 kHz, peak labels, crosshair A/B cursors; plotBox/freqToX shared layout
js/octave.js                OctaveView: 1/3-octave bars 25 Hz – 20 kHz with per-band max marks and an overall bar
js/spectrogram.js           SpectrogramView: live waterfall (newest row on top) and static render from saved sound with playhead
js/audio.js                 encodeWav/decodeWav (16-bit mono PCM), decodeAudioFile (any browser-playable file -> 48 kHz mono, first 5 min)
js/analysis.js              analyzeSound(): levelHistory + average/max spectrum + per-frame spectra on a 400-point log grid + peaks; frameAt()
js/timeline.js              TimelineView: Fast level over time with Leq line and playhead, tap to seek
js/gauge.js                 SVG needle gauge 20–130 dB with alert zone and min/max marks; LevelBar (LED segments 30–120 dB, green/yellow/red by alert level)
js/dsp.js                   Pure DSP (A/C/Z weighting curves and filter design, binLevelTable/binLevels, BANDS/bandIndex/bandLevels, findPeaks, rangeIndex/reduceRanges, logGrid, fft/stft)
js/settings.js              localStorage settings (display options, calibration offset, alert level, PIN)
js/store.js                 IndexedDB records (saved snapshots)
js/share.js                 Share card (canvas PNG), summary text, CSV, share/download helper
js/format.js                Korean labels and number/date formatting
sw.js, manifest.webmanifest, icons/   Offline cache and install
tests/dsp.test.mjs          Unit tests (node:test), including the worklet run in a vm sandbox
tests/e2e.cjs               Playwright run with a WAV file as fake microphone; screenshots both orientations
.github/workflows/pages.yml Tests, then deploys to GitHub Pages from the default branch
```

## Development Workflow

```bash
npm start                                   # serve on http://localhost:8080 (mic works on localhost)
npm test                                    # unit tests
NODE_PATH=$(npm root -g) node tests/e2e.cjs [screenshot-dir]   # e2e; writes screenshots if a dir is given
```

No build step. After changing any cached file, bump `VERSION` in `sw.js` (and add new files to its `FILES` list).

## Conventions

- **Measurement chain:** levels come from the worklet (every sample), never from analyser frames. dB SPL = dBFS + per-device `offset` (calibration). The first 0.5 s after start/reset/weighting change is discarded. Calibration always measures with A weighting.
- **Weighting:** `settings.weighting` ('A' | 'C' | 'Z') applies to the worklet filter, the per-bin spectrum table and file/record analysis alike; units come from `unitOf()` (dB(A), dB(C), dB(Z), dBFS(A) ...). Records store `weighting` and `unit`; old records without them are A.
- **Spectrum values:** per-bin dB = analyser dB + 10·log10(2/Blackman power) + W(f) + offset, so bins sum to the overall level. Peak labels come from a ~1 s averaged spectrum (steady), not the raw frame. 1/3-octave bands are energy sums of those bins; the octave view runs the analyser at 16384 so every band has bins.
- **Layouts:** portrait = mode bar, sub row (weighting, mode name, status), level panel, chart (fills spare height, peak pill + settings button top right), round buttons with captions in two groups (record | start/pause, save); landscape (>= 600px wide) = chart full screen with the level panel (status in its top row) floating top left, and one bottom row of buttons, mode bar and nav; the tab bar hides on the analyzer in landscape.
- **Recording is separate from measuring (start/pause):** the record button never resumes a paused measurement (it only starts the mic if it is off), pausing does not stop the worklet's recording (only the display and the "save" ring buffer hold still), and stopping keeps measuring on the analyzer. Raw PCM from the worklet, at most 5 min (`MAX_RECORD_SEC`, the file analysis limit); on stop it becomes a WAV `File` in `openedFile` and a toast offers "분석 보기" (#/file). Leaving the screen mid-recording keeps what was recorded there. The recording has its own clock (`#a-rec-time` in the red badge on the chart); the status clock always shows measuring time.
- **Frequency axis** is always 20 Hz – 20 kHz (log) / 0 – 20 kHz (linear); the spectrogram uses the same plotBox so columns line up with the spectrum.
- **Saved snapshots** store a 241-point log-spaced resample (20 Hz and 20 kHz included) of the current and max-hold spectra (missing points as -999), stats, peaks and, if enabled, `audio` (WAV Blob) + `audioSec`. The record screen recomputes the spectrogram from the WAV with `stft()` (same analyser convention, so levels match the live view).
- **Attached files** are analysed on the device only: decode -> analyzeSound() with the calibration offset ("보정 dB(A)") or 0 ("파일 dBFS"). Saved file records have `source: 'file'`, `fileName`, `unit`, and keep the original file as `audio` when <= 30 MB. Records with sound (mic or file) rebuild spectrogram + timeline with analyzeSound() on open.
- **Copy:** Korean, plain words. **Escaping:** user text goes through `esc()`; CSV cells are guarded against formula injection.
- **Testing:** DSP changes need unit tests in `tests/dsp.test.mjs`; flow changes should keep `tests/e2e.cjs` passing.

## Git & Branching

- Develop on feature branches; do not commit directly to the default branch (`claude/claude-md-docs-5ggcy7`).
- Write clear, descriptive commit messages.
- Open a pull request only when explicitly requested.

## Notes for AI Assistants

- Phone mic readings are reference values, not legal measurements; keep that disclaimer in the app and shared output.
- The admin PIN (default `0000`) guards calibration and company settings only; it is a deterrent, not security.
- Settings and records live per device (localStorage / IndexedDB); there is no server yet.
