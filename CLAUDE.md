# CLAUDE.md

This file provides guidance to Claude Code (and other AI assistants) when working in this repository.

## Project Overview

A company-internal vehicle noise measurement web app (PWA) for field drivers. Drivers pick a measurement type, tap once, and get an immediate pass / caution / over verdict in dB(A), with automatic saving, sharing (image card + text to KakaoTalk etc.), CSV export and a printable PDF report. UI text is Korean.

- **Language / runtime:** Vanilla JavaScript ES modules in the browser; Node 22 for tests
- **Framework(s):** None. Web Audio (AudioWorklet + AnalyserNode), IndexedDB, Service Worker
- **Package manager:** npm (no runtime dependencies; `playwright` only for the e2e test)

## Repository Structure

```
index.html, css/app.css     App shell and styles (light/dark tokens, print styles for the report)
js/app.js                   Screens + hash router (#/ main screen, #/record/<id>, #/history, #/report, #/settings; #/measure/<mode> just selects a mode)
js/spectrum.js              Canvas spectrum chart (1/3-octave dB(A) bars, max-hold marks, overall bar), live and on results
js/meter.js                 Mic level meter: getUserMedia -> AudioWorklet (levels) + AnalyserNode (spectrum)
js/level-processor.js       AudioWorklet: A-weighting biquads, energy sums, Fast (125 ms) detector
js/dsp.js                   Pure DSP functions (A-weighting design, analyser bin -> power, 1/3-octave BANDS, bandMap/foldBands, peak, judge)
js/settings.js              MODES (measurement types, default criteria, guide text) + localStorage settings
js/store.js                 IndexedDB records
js/share.js                 Share card (canvas PNG), summary text, CSV, share/download helper
js/charts.js, js/format.js  SVG/HTML charts; Korean labels and formatting
sw.js, manifest.webmanifest, icons/   Offline cache and install
tests/dsp.test.mjs          Unit tests (node:test), including the worklet run in a vm sandbox
tests/e2e.cjs               Playwright run with a WAV file as fake microphone
.github/workflows/pages.yml Tests, then deploys to GitHub Pages from the default branch
```

## Development Workflow

```bash
npm start                                   # serve on http://localhost:8080 (mic works on localhost)
npm test                                    # unit tests
NODE_PATH=$(npm root -g) node tests/e2e.cjs [screenshot-dir]   # e2e; writes screenshots + report.pdf if a dir is given
```

No build step. After changing any cached file, bump `VERSION` in `sw.js` (and add new files to its `FILES` list).

## Conventions

- **Measurement chain:** levels come from the worklet (every sample), never from analyser frames. dB SPL = dBFS + per-device `offset` (calibration). The first 0.5 s of each measurement is discarded.
- **Main screen:** the live spectrum is the default view (portrait: chart fills the spare height; landscape >= 640px wide: chart left, controls right; phone landscape hides the top bar). Spectrum = 1/3-octave bands 25 Hz–10 kHz, A-weighted, from a 16384-point analyser.
- **Verdict:** `judge()` in `dsp.js`; each mode's `metric` decides whether Leq or LAFmax is judged. Records store a snapshot of the criteria used, so later settings changes don't alter old verdicts.
- **Copy:** Korean, plain words for drivers (정상 / 주의 / 초과, 저음 / 중음 / 고음). Frequency explanations are framed as hints, never diagnoses.
- **Escaping:** any user text (vehicle, driver, memo, company) goes through `esc()` before entering HTML; CSV cells are guarded against formula injection.
- **Testing:** DSP changes need unit tests in `tests/dsp.test.mjs`; flow changes should keep `tests/e2e.cjs` passing.

## Git & Branching

- Develop on feature branches; do not commit directly to the default branch (`claude/claude-md-docs-5ggcy7`).
- Write clear, descriptive commit messages.
- Open a pull request only when explicitly requested.

## Notes for AI Assistants

- Phone mic readings are reference values, not legal measurements; keep that disclaimer on results and reports.
- Default criteria in `MODES` are examples; the company sets real ones in the admin screen (default PIN `0000`).
- Settings and records live per device (localStorage / IndexedDB); there is no server yet.
