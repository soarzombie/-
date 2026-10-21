# CLAUDE.md

This file provides guidance to Claude Code (and other AI assistants) when working in this repository.

## Project Overview

A company-internal real-time noise analyzer web app (PWA) for field use, referencing common analyzer apps but with its own features. It opens on a live FFT spectrum (x: 20 Hz – 20 kHz, y: weighted dB per bin, A by default) under a level panel (LED bar, big current value, min / average / max, help and reset buttons), in portrait and landscape layouts. The main view is two graphs, as the user specified: the frequency graph (spectrum) on top and a smaller time-axis graph (live level over time) below; the spectrogram and 1/3-octave bars are separate views in the mode bar (the needle gauge and a spectrum + spectrogram view were dropped at the user's request). A "측정 상황" button (the reference app's "사용자 지정 ⌄") picks a situation preset — 공회전 / 주행 / 실내 / 저주파 / 사용자 지정 — that sets several settings at once. The chart button opens a menu like the reference app's: chart style (fill / line / bar), max tracking, min tracking, peak hold, minimum hold, hold reset, "축 범위" (axis ranges sheet) and a last item that opens the "측정 · 그래프 설정" sheet (측정: microphone, A/C/Z weighting, Fast/Slow, timed length, GPS speed; 그래프: time-axis length 30 s / 1 min / 5 min, FFT size, log/linear, 화면 밝기). Own features: one cursor that reads the live level and the maximum at its frequency (the user dropped the A/B cursors and their difference), a red record button kept separate from start/pause (record until stop; the recording goes to the file analysis, opened from a toast), attached-file analysis, and "save" that keeps the last N seconds of sound (rolling buffer) with the snapshot for playback and WAV sharing. Snapshots also carry vehicle number and memo, share as image + text, and export as CSV. Added in v0.12 at the user's request ("추천하는 거 다 반영, 판정 표시는 나중에"): an optional external measurement microphone (the user plans a Dayton iMM-6C; the phone's own mic stays the default), a timed "N초 측정" button, before/after comparison (a saved record's average spectrum as a dashed reference on the live graph, and record vs record), optional GPS speed, pinch zoom on the frequency axis, a bright theme for sunlight, and moving records between phones with one backup file (no server). A pass/fail verdict display is deliberately not built yet (the user will ask for it later). There is no report feature (the user asked to drop it). UI text is Korean.

- **Language / runtime:** Vanilla JavaScript ES modules in the browser; Node 22 for tests
- **Framework(s):** None. Web Audio (AudioWorklet + AnalyserNode), Canvas, IndexedDB, Service Worker
- **Package manager:** npm (no runtime dependencies; `playwright` only for the e2e test)

## Repository Structure

```
index.html, css/app.css     App shell (bottom tab bar) and styles (dark, plus a bright theme on :root[data-theme="light"]; portrait and landscape analyzer layouts)
js/app.js                   Screens + hash router (#/ analyzer, #/file attached-file analysis, #/history, #/record/<id>, #/settings); chart menu, "측정 · 그래프 설정" sheet, help, backup sheet, applyTheme()
js/meter.js                 Mic meter: getUserMedia -> AudioWorklet (Fast/Slow level, Leq/max/min since reset, sound ring buffer, recording) + AnalyserNode (spectrum per bin); setWeighting(A/C/Z); measureFor(sec) timed measurement
js/level-processor.js       AudioWorklet: weighting biquads (replaced by an 'sos' message), energy sums, Fast (125 ms) max/min, raw-sound ring buffer (dump/pause/clear), 'record' on/off -> 0.5 s 'chunk' messages
js/spectrum.js              drawSpectrum() + SpectrumView: fill/line/bar styles, peak/min hold, max/min tracking, avg and dashed ref curves (curveLook() gives their colours for legends), log/linear axis, peak labels, one cursor (live + max readings, readingColors()), two-finger pinch (pinchRange); SPECTRUM_COLORS + setChartTheme('dark'|'light'), DARK_COLORS for the share card; plotBox/freqToX shared layout
js/octave.js                OctaveView: 1/3-octave bars 10 Hz – 20 kHz (under 20 Hz shaded as a guide) with per-band max/min marks and an overall bar
js/spectrogram.js           SpectrogramView: live waterfall (newest row on top; the last 1200 rows kept on a fixed 1024-point grid so history survives hiding, rotation and axis changes) and static render from saved sound with playhead
js/audio.js                 encodeWav/decodeWav (16-bit mono PCM), decodeAudioFile (any browser-playable file -> 48 kHz mono, first 5 min)
js/analysis.js              analyzeSound(): levelHistory + average/max spectrum + per-frame spectra on a 400-point log grid + peaks; frameAt()
js/timeline.js              TimelineView: a recording's level over time with Leq line and playhead, tap to seek; LiveTimelineView: live trace (last 30 s – 5 min, per-pixel min/max via columnRange) with an optional speed line
js/levelbar.js              LevelBar: LED segments 30–120 dB, green/yellow/red by alert level, held max
js/dsp.js                   Pure DSP (A/C/Z weighting curves and filter design, binLevelTable/binLevels, BANDS/bandIndex/bandLevels, findPeaks, rangeIndex/reduceRanges, logGrid, fft/stft)
js/settings.js              localStorage settings (display options, calibration offset, alert level, PIN)
js/presets.js               Measurement situations: PRESETS, choosePreset(), customize() (pure, unit-tested)
js/mics.js                  Microphones: per-microphone calibration (micProfile/saveMicProfile), calibration-file parser and frequency-response correction (pure, unit-tested)
js/gps.js                   haversine(), trackSpeed(): GPS fixes -> km/h (pure, unit-tested)
js/backup.js                backupBlob()/readBackup()/importPlan(): all records + sound in one .nmb file, import only unknown ids (pure, unit-tested)
js/store.js                 IndexedDB records (saved snapshots)
js/share.js                 Share card (canvas PNG), summary text, CSV, share/download helper
js/format.js                Korean labels and number/date formatting
sw.js, manifest.webmanifest, icons/   Offline cache and install
tests/dsp.test.mjs          Unit tests (node:test), including the worklet run in a vm sandbox
tests/e2e.cjs               Playwright run with a WAV file as fake microphone (also a second fake input, fake geolocation, CDP touch for pinch); screenshots both orientations and the bright theme
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
- **Spectrum values:** per-bin dB = analyser dB + 10·log10(2/window power) + W(f) + offset, so bins sum to the overall level. `settings.window` ('blackman' default = the AnalyserNode's own; 'hann', 'hamming') — other windows go through `WindowedSpectrum` (dsp.js: the analyser's time-domain samples, the window, our FFT, the analyser's 1/N scaling and |X| smoothing); `binLevelTable(..., window)`, `frameSpectrum`/`stft`/`analyzeSound` take the window too, and records store `window`. Not part of measurement situations. Peak labels come from a ~1 s averaged spectrum (steady), not the raw frame. 1/3-octave bands are energy sums of those bins; the octave view runs the analyser at 32768 so every band, 10 Hz included, has bins.
- **Layouts:** portrait = mode bar, sub row (측정 상황 button, mode name, status), level panel, chart (fills spare height, peak pill + settings button top right), round buttons with captions in two groups (record | timed ⏱, start/pause, save); in the main view the time-axis graph always takes the lower third of the chart, below a divider; landscape (>= 600px wide, or the 가로 button) = a 156 px column on the left, filled top to bottom (the user asked for no empty space and that it not cover the graph): the 측정 상황 button at full width, the status line, then the level panel stretched to the bottom, the chart beside it, and one bottom row of buttons, mode bar and nav; the tab bar hides on the analyzer in landscape.
- **Landscape layout:** the analyzer's landscape CSS hangs on `html[data-layout="landscape"]`, set by `updateLayout()` (app.js) from the `(orientation: landscape) and (min-width: 600px)` media query, a real orientation lock (`data-lock`, Android: fullscreen + `screen.orientation.lock`, kept only if the screen really turns) or the CSS quarter turn (`data-rotate`, iPhone: the body on the analyzer is rotated 90° clockwise, safe areas swapped). Turned, screen coordinates are not page coordinates: use `pageRect()` (app.js) and `sideways()` (spectrum.js, pointer x = clientY); views size their canvases from `clientWidth/clientHeight`, never the bounding rect. Sheets stay upright (top layer).
- **Holds:** `newHolds()/updateHolds()` in dsp.js keep per-bin peak hold, minimum hold and max/min tracking (12 dB/s back towards the current level). They start after the meter's 0.5 s warm-up (and 0.4 s after an FFT size change) so start-up silence never becomes the minimum. Settings `peakHold`, `minHold`, `maxTrack`, `minTrack` (old `hold` migrates to `peakHold`); "홀드 재설정" clears only these. Snapshots store `spectrum.min` when minimum hold is on; file analysis has `min` (quietest frame per point).
- **Measurement situations:** a preset sets `PRESET_KEYS` (weighting, FFT, style, axis, the four curves, time-axis length), never the view or calibration. `settings.preset` is the chosen id; leaving 사용자 지정 stores its values in `settings.custom`, choosing it again restores them. Every change by hand goes through `changeSettings()` (app.js), which turns a chosen preset into 사용자 지정; the analyzer applies any settings change through `applyLive(prev)`.
- **Time weighting:** `settings.timeWeighting` 'F' (125 ms) or 'S' (1 s) sets the worklet detector ('tau' message) and levelHistory/analyzeSound; part of measurement situations. Records store `timeWeighting`.
- **Microphones:** the meter opens `settings.micId` (falls back to the default), and the opened track's label picks the calibration: `micProfile(st, label)`; the phone's own microphone (`baseMic`) uses the old `offset`/`calibratedAt`. A calibration file's response is corrected per FFT bin (`binLevelTable(..., correction)`), so spectra, octave bands and holds are corrected; the big level number uses the offset only. Records store `mic` and `micCal`. The phone's own mic is the default; an external one (iMM-6C etc.) is optional, picked in the sheet or from the "새 마이크" toast, and never becomes `baseMic` (`EXTERNAL_MIC` names: USB, iMM, UMIK, headset ...). The calibration card has its own microphone list (`#f-cal-mic`). `parseCalFile()` keeps a Dayton "*1000Hz -40.3" line as `sens1k` and makes files written as absolute sensitivity relative to 1 kHz.
- **Level trace:** pushed from `onLevel` only when the meter's measured sample count grows (not while warming up or paused), one value per 50 ms worklet block; time labels are measuring time; cleared on reset/weighting change.
- **Recording is separate from measuring (start/pause):** the record button never resumes a paused measurement (it only starts the mic if it is off), pausing does not stop the worklet's recording (only the display and the "save" ring buffer hold still), and stopping keeps measuring on the analyzer. Raw PCM from the worklet, at most 5 min (`MAX_RECORD_SEC`, the file analysis limit); on stop it becomes a WAV `File` in `openedFile` and a toast offers "분석 보기" (#/file). Leaving the screen mid-recording keeps what was recorded there. The recording has its own clock (`#a-rec-time` in the red badge on the chart); the status clock always shows measuring time.
- **Frequency axis** defaults to 20 Hz – 20 kHz (log) / 0 – 20 kHz (linear); `freqMin`/`freqMax` narrow it for the live spectrum, the spectrogram and the file screen (saved records and the share card always show the whole range). Axis helpers take a `freqAxis(scale, fmin, fmax)` object; `freqTicks()` gives 1-2-5 decades on a wide log axis and round steps otherwise. The spectrogram uses the same plotBox and axis so columns line up with the spectrum.
- **Axis ranges:** `specDb`, `traceDb`, `gramDb`, `octDb` are `[lo, hi]` or null (automatic); `checkFreqRange()`/`checkDbRange()` in spectrum.js decide what the sheet accepts. They are not part of measurement situations.
- **Saved snapshots** store a 241-point log-spaced resample (20 Hz and 20 kHz included) of the current and max-hold spectra (missing points as -999), stats, peaks and, if enabled, `audio` (WAV Blob) + `audioSec`. The record screen recomputes the spectrogram from the WAV with `stft()` (same analyser convention, so levels match the live view).
- **Attached files** are analysed on the device only: decode -> analyzeSound() with the calibration offset ("보정 dB(A)") or 0 ("파일 dBFS"). Saved file records have `source: 'file'`, `fileName`, `unit`, and keep the original file as `audio` when <= 30 MB. Records with sound (mic or file) rebuild spectrogram + timeline with analyzeSound() on open.
- **Timed measurement:** the ⏱ button resets, then `meter.measureFor(timedSec)` stops counting at the block that completes N s (blocks are 50 ms) and pauses the meter; the app then opens the save sheet with the last N s of sound (`captureAudio(sec)`; the ring holds max(audioSec, 60 s)). Tapping it again or pausing cancels; reset restarts the N s. Records store `timedSec`. The warm-up drops every block ending within the first 0.5 s.
- **Average spectrum and comparison:** the analyzer sums per-bin power since reset (after the warm-up) and snapshots store it as `spectrum.avg`. `refCurve(rec)` uses `avg`, else `cur` (a file's average, or an old snapshot's moment). `settings.refId` puts a record on the live graph as `data.ref` (dashed, own frequency points) with a chip comparing Leq (only for the same weighting); cursors read `ref` too; a snapshot taken meanwhile stores `refId` and its record screen compares with it.
- **GPS speed:** optional (`settings.gps`), watched only while the mic is on; `trackSpeed()` uses `coords.speed` or distance over time; only speed is stored (`speed`, `speedAvg`, `speedMax`), never the position.
- **Theme:** `settings.theme` 'dark' | 'light'; CSS variables on `:root[data-theme]`, chart colours through `setChartTheme()`; canvas code takes colours from SPECTRUM_COLORS at draw time (no new hard-coded colours). The share card always uses DARK_COLORS.
- **Backup:** "기록 백업 보내기" writes every record with its sound into one file (magic `NOISEBK1`, 8-hex header length, JSON header, then the sound Blobs); "백업 파일 넣기" adds records whose id is unknown, with `device` (phone name, `settings.device`) and `importedAt`.
- **Calibration:** 기준 소음계 (type the meter's Leq) or 음향 교정기 (94/114 dB at 1 kHz, value filled in; the loudest bin must be near 1 kHz). `calStability()` (mics.js) grades the spread of the time-weighted levels during the 5 s (stricter for a calibrator); poor stability warns, it does not block.
- **Video:** `ScreenVideo` (video.js) redraws the readings (from the DOM) and every visible canvas of the chart (layout offsets, so it works turned) onto one canvas and records `captureStream(30)` + the mic track with MediaRecorder; H.264 MP4 first, then WebM, a plain MP4 last; max `MAX_VIDEO_SEC`; the stop sheet's 보내기 gives the share a fresh tap. The disclaimer is in the frame.
- **Audio details / auto-save:** `meter.trackSettings` keeps what getUserMedia really gave (the details sheet warns if processing stayed on). `settings.autoSave` makes a finished timed measurement save at once (`saveNow`, last vehicle number).
- **Copy:** Korean, plain words. **Escaping:** user text goes through `esc()`; CSV cells are guarded against formula injection.
- **Testing:** DSP changes need unit tests in `tests/dsp.test.mjs`; flow changes should keep `tests/e2e.cjs` passing.

## Git & Branching

- Develop on feature branches; do not commit directly to the default branch (`claude/claude-md-docs-5ggcy7`).
- Write clear, descriptive commit messages.
- Open a pull request only when explicitly requested.

## Notes for AI Assistants

- Phone mic readings are reference values, not legal measurements; keep that disclaimer in the app and shared output.
- The admin PIN (default `0000`) guards calibration and company settings only; it is a deterrent, not security.
- Settings and records live per device (localStorage / IndexedDB); there is no server yet (records move between phones with the backup file).
- Headless Chromium here names downloads with non-ASCII names "download"; don't assert Korean file names in e2e.
