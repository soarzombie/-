# CLAUDE.md

This file provides guidance to Claude Code (and other AI assistants) when working in this repository.

## Project Overview

A company-internal real-time noise analyzer web app (PWA) for field use. It opens on a live FFT spectrum (x: frequency, y: A-weighted dB(A) per bin) with current / average / max / min levels, peak-frequency labels and a needle gauge, in portrait and landscape layouts modelled on common analyzer apps. Snapshots can be saved with a vehicle number and memo, shared as an image + text, and exported as CSV. There is no report feature (the user asked to drop it). UI text is Korean.

- **Language / runtime:** Vanilla JavaScript ES modules in the browser; Node 22 for tests
- **Framework(s):** None. Web Audio (AudioWorklet + AnalyserNode), Canvas, IndexedDB, Service Worker
- **Package manager:** npm (no runtime dependencies; `playwright` only for the e2e test)

## Repository Structure

```
index.html, css/app.css     App shell (bottom tab bar) and styles (dark only; portrait and landscape analyzer layouts)
js/app.js                   Screens + hash router (#/ analyzer, #/history, #/record/<id>, #/settings)
js/meter.js                 Mic meter: getUserMedia -> AudioWorklet (LAF, LAeq/LAFmax/LAFmin since reset) + AnalyserNode (spectrum per bin)
js/level-processor.js       AudioWorklet: A-weighting biquads, energy sums, Fast (125 ms) max/min
js/spectrum.js              drawSpectrum() + SpectrumView: filled current/max-hold areas, log/linear axis, peak labels
js/gauge.js                 SVG needle gauge 20–130 dB with alert zone and min/max marks
js/dsp.js                   Pure DSP (A-weighting design, binLevelTable/binLevels, findPeaks, rangeIndex/reduceRanges, logGrid)
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

- **Measurement chain:** levels come from the worklet (every sample), never from analyser frames. dB SPL = dBFS + per-device `offset` (calibration). The first 0.5 s after start/reset is discarded.
- **Spectrum values:** per-bin dB(A) = analyser dB + 10·log10(2/Blackman power) + A(f) + offset, so bins sum to the overall level. Peak labels come from a ~1 s averaged spectrum (steady), not the raw frame.
- **Layouts:** portrait = head, chart (fills spare height), option chips, gauge with the controls row overlapping its hub, numbers; landscape (>= 600px wide) = chart full screen with numbers/status overlaid and one bottom control row; the tab bar hides on the analyzer in landscape.
- **Saved snapshots** store a 240-point log-spaced resample of the current and max-hold spectra (missing points as -999) plus stats and peaks.
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
