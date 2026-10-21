// Screens and navigation. Routes live in the URL hash so the phone's back button works:
// #/ (real-time analyzer), #/history, #/record/<id>, #/settings

import { APP_VERSION, getSettings, saveSettings, rememberVehicle } from './settings.js';
import { Meter, FFT_SIZES } from './meter.js';
import { findPeaks, logGrid, rangeIndex, reduceRanges, stft, binLevelTable, binLevels } from './dsp.js';
import * as store from './store.js';
import { esc, fmtDb, fmtHz, fmtClock, fmtDate, fmtDay, fmtShortDate, fmtTime, fileStamp } from './format.js';
import { SpectrumView } from './spectrum.js';
import { SpectrogramView } from './spectrogram.js';
import { encodeWav, decodeWav } from './audio.js';
import { Gauge } from './gauge.js';
import { summaryText, renderCard, recordsCsv, deliverFile } from './share.js';

const view = document.getElementById('view');
let cleanup = null; // runs before the next screen renders
let adminUnlocked = false;

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  play: svg('<path class="fill" d="M8 5.5v13l10.5-6.5z"/>'),
  pause: svg('<path d="M9 5.5v13M15 5.5v13"/>'),
  reset: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><circle class="fill" cx="12" cy="12" r="1.4"/>'),
  save: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>'),
  history: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
};

const routes = {
  home: renderAnalyzer,
  history: renderHistory,
  record: renderRecord,
  settings: renderSettings,
};

function route() {
  cleanup?.();
  cleanup = null;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = routes[name] ? name : 'home';
  document.body.dataset.view = key;
  const tab = key === 'record' ? 'history' : key;
  document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  window.scrollTo(0, 0);
  Promise.resolve(routes[key](arg ? decodeURIComponent(arg) : undefined)).catch(showFatal);
}

function showFatal(err) {
  console.error(err);
  view.innerHTML = `<div class="page"><div class="alert">문제가 생겼습니다: ${esc(err?.message || err)}</div>
    <a class="btn btn-wide" href="#/">처음으로</a></div>`;
}

/* ---------- small UI helpers ---------- */

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function openSheet(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-body">${html}</div>`;
  document.body.append(dlg);
  const close = () => (dlg.open && dlg.close ? dlg.close() : dlg.remove());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute('open', '');
  return { dlg, close };
}

async function keepScreenOn() {
  try {
    return (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    return null;
  }
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

const VIEW_LABEL = { spectrum: '스펙트럼', gram: '시간축', both: '함께' };
const NEXT_VIEW = { spectrum: 'gram', gram: 'both', both: 'spectrum' };

// One-line cursor read-out: "A 1,250 Hz 62.3  B 125 Hz 47.6  B−A −14.7 dB" (levels in dB(A)).
function cursorText(values) {
  const parts = values.map((v, i) => `<span><b>${'AB'[i]}</b> ${fmtHz(v.hz)} <em>${fmtDb(v.cur)}</em></span>`);
  if (values.length === 2) {
    const d = values[1].cur - values[0].cur;
    parts.push(`<span class="cr-diff">B−A ${d >= 0 ? '+' : ''}${fmtDb(d)} dB</span>`);
  }
  return parts.join('');
}

function bindCursorReadout(el) {
  let shown = '';
  return (values) => {
    const html = values.length ? cursorText(values) : '';
    if (html === shown) return;
    shown = html;
    el.hidden = !html;
    el.querySelector('.cr-lines').innerHTML = html;
  };
}

const cursorBox = (id) =>
  `<div class="cursor-readout" id="${id}" hidden><div class="cr-lines"></div><button type="button" class="cr-close" aria-label="커서 지우기">×</button></div>`;

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MISSING = -999; // stored for empty spectrum points (JSON has no -Infinity)

/* ---------- real-time analyzer ---------- */

async function renderAnalyzer() {
  const s = getSettings();
  view.innerHTML = `
    <section class="analyzer" data-state="off">
      <header class="an-head">
        <h1>실시간 소음 분석</h1>
        <p class="an-status"><i class="rec-dot"></i><span id="a-state">대기</span><b id="a-time">00:00</b></p>
      </header>
      <div class="an-chart" data-view="${s.view}">
        <div class="chart-plot" id="a-chart"></div>
        <div class="gram-plot" id="a-gram"></div>
        <p class="an-peak" id="a-peak">피크 –</p>
        ${cursorBox('a-cursor')}
        <div class="chart-overlay" id="a-overlay">
          <button type="button" class="mic-button" data-act="mic">${ICON.mic}<strong>눌러서 측정 시작</strong></button>
          <p class="overlay-note" id="a-note">처음 한 번은 마이크 사용을 "허용"해 주세요.</p>
        </div>
      </div>
      <div class="an-options" role="group" aria-label="그래프 설정">
        <button type="button" class="opt" data-opt="view"><span>보기</span><b>${VIEW_LABEL[s.view]}</b></button>
        <button type="button" class="opt" data-opt="style"><span>모양</span><b>${s.style === 'line' ? '선' : '면'}</b></button>
        <button type="button" class="opt" data-opt="hold" aria-pressed="${s.hold}"><span>최대값</span><b>${s.hold ? '표시' : '숨김'}</b></button>
        <button type="button" class="opt" data-opt="fft"><span>FFT</span><b>${s.fftSize}</b></button>
        <button type="button" class="opt" data-opt="scale"><span>주파수 축</span><b>${s.scale === 'log' ? '로그' : '선형'}</b></button>
      </div>
      <div class="an-gauge" id="a-gauge"></div>
      <div class="an-controls">
        <button type="button" class="ctl" data-act="reset" aria-label="초기화">${ICON.reset}<span>초기화</span></button>
        <button type="button" class="ctl ctl-main" data-act="toggle" aria-label="측정 시작">${ICON.play}</button>
        <button type="button" class="ctl" data-act="save" aria-label="저장">${ICON.save}<span>저장</span></button>
      </div>
      <div class="an-numbers">
        <div class="num num-avg"><span>평균</span><b id="a-leq">–</b></div>
        <div class="num num-now"><b id="a-now">--.-</b><span>dB(A)</span></div>
        <div class="num num-max"><span>최대</span><b id="a-max">–</b></div>
        <div class="num num-min"><span>최소</span><b id="a-min">–</b></div>
      </div>
      <nav class="an-nav" aria-label="메뉴">
        <a href="#/history" aria-label="기록">${ICON.history}</a>
        <a href="#/settings" aria-label="설정">${ICON.settings}</a>
      </nav>
    </section>`;

  const $ = (id) => view.querySelector(`#${id}`);
  const root = view.querySelector('.analyzer');
  const toggleBtn = view.querySelector('[data-act=toggle]');
  const chartBox = view.querySelector('.an-chart');
  const chart = new SpectrumView($('a-chart'), { cursor: true });
  chart.onCursor = bindCursorReadout($('a-cursor'));
  $('a-cursor').querySelector('.cr-close').onclick = () => chart.clearCursors();
  const gram = new SpectrogramView($('a-gram'));
  gram.configure({ scale: s.scale, xLabels: s.view === 'gram' });
  const gauge = new Gauge($('a-gauge'), s.alertLevel);
  let meter = null;
  let raf = 0;
  let wake = null;
  let hold = null; // per-bin maximum since reset, dB(A)
  let avgPow = null; // slowly averaged spectrum, for steady peak labels
  let peaks = [];
  let lastPeakAt = 0;
  let lastRowAt = 0;
  let range = [-20, 100];

  const draw = (cur) => {
    const st = getSettings();
    chart.update({ freqs: meter.freqs, cur, max: st.hold ? hold : null, peaks }, { scale: st.scale, style: st.style, range });
  };

  function showRunning(paused) {
    root.dataset.state = paused ? 'pause' : 'run';
    toggleBtn.innerHTML = paused ? ICON.play : ICON.pause;
    toggleBtn.setAttribute('aria-label', paused ? '다시 측정' : '일시정지');
    $('a-state').textContent = paused ? '일시정지' : '측정 중';
  }

  function clearReadings() {
    hold = null;
    avgPow = null;
    peaks = [];
    range = [-20, 100];
    $('a-peak').textContent = '피크 –';
    ['a-leq', 'a-max', 'a-min'].forEach((id) => ($(id).textContent = '–'));
    $('a-time').textContent = '00:00';
    gauge.marks(NaN, NaN);
    gram.clear();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!meter) return;
    if (!meter.running) {
      $('a-overlay').hidden = false;
      return;
    }
    if (!$('a-overlay').hidden) {
      $('a-overlay').hidden = true;
      showRunning(meter.paused);
    }
    if (meter.paused) return;
    const cur = meter.spectrum();
    if (!hold || hold.length !== cur.length) {
      hold = new Float32Array(cur.length).fill(-Infinity);
      avgPow = new Float64Array(cur.length);
    }
    let top = -Infinity;
    for (let k = 1; k < cur.length; k++) {
      if (cur[k] > hold[k]) hold[k] = cur[k];
      if (hold[k] > top) top = hold[k];
      avgPow[k] += (10 ** (cur[k] / 10) - avgPow[k]) * 0.1;
    }
    if (top > range[1] - 4 && range[1] < 140) range = [range[0], range[1] + 20];
    if (now - lastPeakAt > 300) {
      lastPeakAt = now;
      const avgDb = Float32Array.from(avgPow, (p) => 10 * Math.log10(p));
      peaks = findPeaks(avgDb, meter.binHz, { count: 2 });
      const main = peaks[0] || findPeaks(avgDb, meter.binHz, { count: 1, minProminence: -Infinity })[0];
      $('a-peak').textContent = main ? `피크 ${fmtHz(main.hz)}` : '피크 –';
    }
    if (now - lastRowAt >= 50) {
      lastRowAt = now;
      gram.push(cur, meter.freqs);
    }
    draw(cur);
  }

  function onLevel(db) {
    gauge.set(db);
    $('a-now').textContent = fmtDb(db);
    $('a-now').parentElement.dataset.alert = String(db >= getSettings().alertLevel);
    $('a-leq').textContent = fmtDb(meter.leq);
    $('a-max').textContent = fmtDb(meter.lmax);
    $('a-min').textContent = fmtDb(meter.lmin);
    $('a-time').textContent = fmtClock(meter.elapsed);
    gauge.marks(meter.lmin, meter.lmax);
  }

  async function startMic() {
    if (meter) {
      if (!meter.running) await meter.wake();
      return true;
    }
    meter = new Meter(getSettings().offset);
    try {
      await meter.start(getSettings().fftSize, getSettings().audioSec);
    } catch (err) {
      meter = null;
      if (err.code !== 'cancelled') {
        $('a-overlay').hidden = false;
        $('a-note').textContent = err.message;
        $('a-note').classList.add('is-error');
      }
      return false;
    }
    meter.onLevel = onLevel;
    $('a-note').textContent = '';
    clearReadings();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    keepScreenOn().then((w) => (wake = w));
    return true;
  }

  function stopMic() {
    cancelAnimationFrame(raf);
    meter?.stop();
    meter = null;
    wake?.release?.().catch(() => {});
    wake = null;
    root.dataset.state = 'off';
    toggleBtn.innerHTML = ICON.play;
    $('a-state').textContent = '대기';
    $('a-now').textContent = '--.-';
    $('a-overlay').hidden = false;
    gauge.set(NaN);
  }

  // Everything needed to look at this moment again later.
  function snapshot() {
    const grid = logGrid(241, 20, 20000);
    const idx = rangeIndex(meter.freqs, grid.edges);
    const keep = (arr) => Array.from(arr, (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : MISSING));
    const st = getSettings();
    return {
      id: store.newId(),
      ts: Date.now(),
      leq: round1(meter.leq),
      lmax: round1(meter.lmax),
      lmin: round1(meter.lmin),
      laf: round1(meter.laf),
      elapsed: round1(meter.elapsed),
      clipped: meter.stats.clipped,
      peaks: peaks.map((p) => ({ hz: Math.round(p.hz), db: round1(p.db) })),
      spectrum: {
        freqs: Array.from(grid.centres, (f) => Math.round(f * 10) / 10),
        cur: keep(reduceRanges(meter.levels, meter.freqs, idx, grid.centres)),
        max: keep(reduceRanges(hold, meter.freqs, idx, grid.centres)),
        range: [...range],
      },
      fftSize: st.fftSize,
      sampleRate: meter.sampleRate,
      offset: meter.offset,
      calibrated: !!st.calibratedAt,
      vehicle: '',
      memo: '',
      app: APP_VERSION,
    };
  }

  function openSave(rec, audio) {
    const st = getSettings();
    const { dlg, close } = openSheet(`
      <form class="sheet-form">
        <h2>지금 측정 저장</h2>
        <dl class="save-summary">
          <div><dt>평균</dt><dd>${fmtDb(rec.leq)}</dd></div>
          <div><dt>최대</dt><dd>${fmtDb(rec.lmax)}</dd></div>
          <div><dt>최소</dt><dd>${fmtDb(rec.lmin)}</dd></div>
          <div><dt>측정 시간</dt><dd>${fmtClock(rec.elapsed)}</dd></div>
        </dl>
        <label class="field"><span>차량번호 <small>(선택)</small></span>
          <input id="f-vehicle" value="${esc(st.vehicle)}" placeholder="예: 12가 3456" autocomplete="off"></label>
        ${st.recentVehicles.length ? `<div class="chips">${st.recentVehicles.map((v) => `<button type="button" class="chip-pick" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>` : ''}
        <label class="field"><span>메모 <small>(선택)</small></span>
          <textarea id="f-memo" rows="3" placeholder="예: 시속 80km, 오른쪽 뒤에서 윙 소리"></textarea></label>
        ${st.audioSec > 0 ? '<label class="check"><input type="checkbox" id="f-audio" checked> <span id="f-audio-label">방금 들린 소리도 함께 저장</span></label>' : ''}
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" data-close>취소</button>
          <button class="btn btn-primary" type="submit">저장</button>
        </div>
      </form>`);
    const input = dlg.querySelector('#f-vehicle');
    dlg.querySelectorAll('.chip-pick').forEach((b) => (b.onclick = () => (input.value = b.dataset.v)));
    audio.then((samples) => {
      const label = dlg.querySelector('#f-audio-label');
      if (label) label.textContent = samples.length ? `방금 들린 소리 ${(samples.length / meter.sampleRate).toFixed(0)}초도 함께 저장` : '저장할 소리가 없습니다';
    });
    dlg.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      rec.vehicle = input.value.trim();
      rec.memo = dlg.querySelector('#f-memo').value.trim();
      if (rec.vehicle) rememberVehicle(rec.vehicle);
      const samples = dlg.querySelector('#f-audio')?.checked ? await audio : null;
      if (samples?.length) {
        rec.audio = encodeWav(samples, rec.sampleRate);
        rec.audioSec = round1(samples.length / rec.sampleRate);
      }
      await store.putRecord(rec);
      close();
      toast('기록에 저장했습니다');
    };
  }

  const onVisibility = () => {
    if (document.hidden) stopMic();
    else micPermission().then((p) => p === 'granted' && !meter && startMic());
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    stopMic();
    chart.destroy();
    gram.destroy();
  };

  view.querySelector('[data-act=mic]').onclick = () => startMic();
  toggleBtn.onclick = async () => {
    if (!meter || !meter.running) return startMic();
    meter.paused = !meter.paused;
    showRunning(meter.paused);
  };
  view.querySelector('[data-act=reset]').onclick = () => {
    if (!meter) return;
    meter.resetStats();
    clearReadings();
    if (meter.paused) draw(meter.levels);
  };
  view.querySelector('[data-act=save]').onclick = () => {
    if (!meter || !hold || meter.elapsed < 1) return toast('측정을 시작한 뒤에 저장할 수 있습니다');
    // grab the sound first: it is "what was just heard", before the sheet takes any time
    const audio = getSettings().audioSec > 0 ? meter.captureAudio() : Promise.resolve(new Float32Array(0));
    openSave(snapshot(), audio);
  };
  view.querySelectorAll('[data-opt]').forEach((b) =>
    b.addEventListener('click', () => {
      const st = getSettings();
      if (b.dataset.opt === 'view') {
        const next = NEXT_VIEW[st.view];
        saveSettings({ view: next });
        b.querySelector('b').textContent = VIEW_LABEL[next];
        chartBox.dataset.view = next;
        gram.configure({ xLabels: next === 'gram' });
      } else if (b.dataset.opt === 'style') {
        const style = st.style === 'line' ? 'fill' : 'line';
        saveSettings({ style });
        b.querySelector('b').textContent = style === 'line' ? '선' : '면';
      } else if (b.dataset.opt === 'hold') {
        saveSettings({ hold: !st.hold });
        b.setAttribute('aria-pressed', String(!st.hold));
        b.querySelector('b').textContent = st.hold ? '숨김' : '표시';
      } else if (b.dataset.opt === 'fft') {
        const next = FFT_SIZES[(FFT_SIZES.indexOf(st.fftSize) + 1) % FFT_SIZES.length];
        saveSettings({ fftSize: next });
        b.querySelector('b').textContent = next;
        if (meter) {
          meter.setFftSize(next);
          hold = null;
          avgPow = null;
          peaks = [];
        }
      } else {
        const scale = st.scale === 'log' ? 'linear' : 'log';
        saveSettings({ scale });
        b.querySelector('b').textContent = scale === 'log' ? '로그' : '선형';
        gram.configure({ scale });
      }
      if (meter?.paused && hold) draw(meter.levels);
    }),
  );

  if ((await micPermission()) === 'granted') startMic();
}

/* ---------- history ---------- */

async function renderHistory() {
  const all = (await store.allRecords()).filter((r) => r.spectrum);
  view.innerHTML = `
    <div class="page">
      <h1 class="page-title">측정 기록</h1>
      <input type="search" id="f-search" placeholder="차량번호·메모로 찾기" aria-label="차량번호·메모로 찾기">
      <div id="h-list"></div>
      <div class="action-bar"><button class="btn" data-act="csv">엑셀 파일로 받기</button></div>
    </div>`;
  let current = all;
  const update = () => {
    const q = view.querySelector('#f-search').value.replace(/\s/g, '');
    current = all.filter((r) => !q || `${r.vehicle}${r.memo}`.replace(/\s/g, '').includes(q));
    const groups = new Map();
    current.forEach((r) => {
      const day = fmtDay(r.ts);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(r);
    });
    view.querySelector('#h-list').innerHTML = current.length
      ? [...groups].map(([day, rows]) => `<h2 class="day-head">${day}</h2><ul class="record-list">${rows.map(recordRow).join('')}</ul>`).join('')
      : `<p class="empty-hint">${all.length ? '찾는 기록이 없습니다.' : '측정 화면에서 저장 버튼을 누르면 여기에 쌓입니다.'}</p>`;
  };
  update();
  view.querySelector('#f-search').addEventListener('input', update);
  view.querySelector('[data-act=csv]').onclick = async () => {
    if (!current.length) return toast('내보낼 기록이 없습니다');
    const result = await deliverFile(recordsCsv(current), `소음분석기록_${fileStamp(Date.now())}.csv`, { title: '소음 분석 기록' });
    if (result === 'downloaded') toast('엑셀에서 열 수 있는 파일(CSV)을 저장했습니다');
  };
}

function recordRow(r) {
  return `<li><a class="record-row" href="#/record/${encodeURIComponent(r.id)}">
    <span class="rr-time">${fmtTime(r.ts)}</span>
    <span class="rr-main"><strong>${esc(r.vehicle || '차량 미입력')}</strong><span>${esc(r.memo || `측정 ${fmtClock(r.elapsed)}${r.peaks?.[0] ? ` · 피크 ${fmtHz(r.peaks[0].hz)}` : ''}`)}</span></span>
    <span class="rr-value"><small>평균</small>${fmtDb(r.leq)}<small>최대</small>${fmtDb(r.lmax)}</span>
  </a></li>`;
}

/* ---------- saved analysis ---------- */

async function renderRecord(id) {
  const rec = await store.getRecord(id);
  if (!rec?.spectrum) {
    view.innerHTML = '<div class="page"><p class="alert">기록을 찾을 수 없습니다.</p><a class="btn btn-wide" href="#/history">기록 목록</a></div>';
    return;
  }
  const s = getSettings();
  view.innerHTML = `
    <div class="page">
      <a class="back" href="#/history">← 기록 목록</a>
      <div class="rec-layout">
        <header class="rec-head">
          <h1>${esc(rec.vehicle || '차량 미입력')}</h1>
          <p>${fmtDate(rec.ts)} · 측정 ${fmtClock(rec.elapsed)}</p>
        </header>
        <section class="card chart-card">
          <div class="chart-box-rec"><div class="chart-plot" id="rec-chart"></div></div>
          ${cursorBox('rec-cursor')}
          <p class="legend" data-style="${s.style}"><i class="lg-cur"></i>저장 순간 <i class="lg-max"></i>측정 중 최대 <span class="fine">· 그래프를 누르면 커서</span></p>
        </section>
        <section class="stats-grid">
          <div><span>평균</span><b>${fmtDb(rec.leq)}</b><small>dB(A)</small></div>
          <div><span>최대</span><b>${fmtDb(rec.lmax)}</b><small>dB(A)</small></div>
          <div><span>최소</span><b>${fmtDb(rec.lmin)}</b><small>dB(A)</small></div>
        </section>
        ${rec.clipped ? '<p class="alert">소리가 휴대폰 마이크의 측정 한계를 넘은 순간이 있었습니다. 실제 최대값은 더 클 수 있습니다.</p>' : ''}
        ${rec.audio
          ? `<section class="card audio-card">
              <h2>저장된 소리 <small>${rec.audioSec}초</small></h2>
              <audio controls preload="metadata" id="rec-audio"></audio>
              <div class="gram-box-rec"><div class="gram-plot" id="rec-gram"></div><p class="gram-wait" id="rec-gram-wait">소리 분석 중…</p></div>
              <p class="fine">시간축 그래프: 맨 위가 저장한 순간, 아래로 갈수록 그 전 소리입니다. 재생하면 흰 선이 따라갑니다.</p>
              <button type="button" class="btn btn-wide" data-act="share-audio">소리 파일 보내기</button>
            </section>`
          : ''}
        <section class="card">
          <dl class="meta">
            <dt>피크</dt><dd>${rec.peaks?.length ? rec.peaks.map((p) => `${fmtHz(p.hz)} <small>(${fmtDb(p.db)} dB(A))</small>`).join('<br>') : '뚜렷한 피크 없음'}</dd>
            <dt>메모</dt><dd class="memo">${esc(rec.memo) || '-'}</dd>
            <dt>저장 순간</dt><dd>${fmtDb(rec.laf)} dB(A)</dd>
            <dt>분석 설정</dt><dd>FFT ${rec.fftSize} · ${rec.calibrated ? '마이크 보정됨' : '마이크 보정 안 됨 (참고값)'}</dd>
          </dl>
        </section>
      </div>
      <div class="action-bar">
        <button class="btn" data-act="note">메모 수정</button>
        <button class="btn btn-primary" data-act="share">결과 보내기</button>
      </div>
      <button class="btn btn-danger-quiet btn-wide" data-act="delete">이 기록 삭제</button>
    </div>`;

  const chart = new SpectrumView(view.querySelector('#rec-chart'), { cursor: true });
  chart.onCursor = bindCursorReadout(view.querySelector('#rec-cursor'));
  view.querySelector('#rec-cursor .cr-close').onclick = () => chart.clearCursors();
  const sp = rec.spectrum;
  chart.update(
    { freqs: Float32Array.from(sp.freqs), cur: Float32Array.from(sp.cur), max: Float32Array.from(sp.max), peaks: rec.peaks },
    { scale: 'log', style: s.style, range: sp.range },
  );
  let gram = null;
  let audioUrl = null;
  let raf = 0;
  cleanup = () => {
    chart.destroy();
    gram?.destroy();
    cancelAnimationFrame(raf);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  };

  if (rec.audio) {
    const player = view.querySelector('#rec-audio');
    audioUrl = URL.createObjectURL(rec.audio);
    player.src = audioUrl;
    gram = new SpectrogramView(view.querySelector('#rec-gram'));
    // the time-axis view is worked out from the saved sound itself
    setTimeout(async () => {
      const { samples, rate } = await decodeWav(rec.audio);
      const { frames, binHz } = stft(samples, rate, 2048, 512);
      const table = binLevelTable(1024, binHz);
      const freqs = Float32Array.from({ length: 1024 }, (_, k) => k * binHz);
      gram?.setStatic(frames.map((f) => binLevels(f, table, rec.offset)), freqs, samples.length / rate);
      view.querySelector('#rec-gram-wait')?.remove();
    }, 30);
    const follow = () => {
      gram?.setPlayhead(player.currentTime);
      if (!player.paused) raf = requestAnimationFrame(follow);
    };
    player.addEventListener('play', follow);
    player.addEventListener('seeked', follow);
    player.addEventListener('ended', () => gram?.setPlayhead(null));
    view.querySelector('[data-act=share-audio]').onclick = async () => {
      const result = await deliverFile(rec.audio, `소음분석_${(rec.vehicle || '기록').replace(/\s/g, '')}_${fileStamp(rec.ts)}.wav`, {
        title: '저장된 소리',
        text: summaryText(rec, s),
      });
      if (result === 'downloaded') toast('소리 파일(WAV)을 저장했습니다');
    };
  }

  // Render the card now so the share sheet opens straight from the tap (iOS needs that).
  const card = renderCard(rec, s);
  view.querySelector('[data-act=share]').onclick = async () => {
    const result = await deliverFile(await card, `소음분석_${(rec.vehicle || '기록').replace(/\s/g, '')}_${fileStamp(rec.ts)}.png`, {
      title: '실시간 소음 분석',
      text: summaryText(rec, s),
    });
    if (result === 'downloaded') {
      await navigator.clipboard?.writeText(summaryText(rec, s)).catch(() => {});
      toast('이미지를 저장했습니다. 내용은 복사되어 붙여넣기 할 수 있습니다.');
    }
  };
  view.querySelector('[data-act=note]').onclick = () => {
    const { dlg, close } = openSheet(`
      <form class="sheet-form">
        <h2>메모 수정</h2>
        <label class="field"><span>차량번호</span><input id="f-vehicle" value="${esc(rec.vehicle)}" autocomplete="off"></label>
        <label class="field"><span>메모</span><textarea id="f-memo" rows="4">${esc(rec.memo)}</textarea></label>
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" data-close>취소</button>
          <button class="btn btn-primary" type="submit">저장</button>
        </div>
      </form>`);
    dlg.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      await store.putRecord({ ...rec, vehicle: dlg.querySelector('#f-vehicle').value.trim(), memo: dlg.querySelector('#f-memo').value.trim() });
      close();
      route();
    };
  };
  const del = view.querySelector('[data-act=delete]');
  del.onclick = async () => {
    if (del.dataset.armed !== 'yes') {
      del.dataset.armed = 'yes';
      del.textContent = '한 번 더 누르면 삭제됩니다';
      return;
    }
    await store.deleteRecord(rec.id);
    toast('기록을 삭제했습니다');
    location.replace('#/history');
  };
}

/* ---------- admin settings ---------- */

async function renderSettings() {
  if (!adminUnlocked) {
    view.innerHTML = `
      <div class="page">
        <form class="pin-gate" id="pin-form">
          <h1 class="page-title">설정</h1>
          <p>마이크 보정과 회사 정보는 관리자만 바꿀 수 있습니다.</p>
          <label class="field"><span>관리자 비밀번호</span>
            <input id="f-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
          <p class="alert" id="pin-error" hidden>비밀번호가 맞지 않습니다.</p>
          <button class="btn btn-primary btn-wide" type="submit">확인</button>
        </form>
      </div>`;
    view.querySelector('#pin-form').onsubmit = (e) => {
      e.preventDefault();
      if (view.querySelector('#f-pin').value === getSettings().pin) {
        adminUnlocked = true;
        route();
      } else {
        view.querySelector('#pin-error').hidden = false;
      }
    };
    return;
  }

  const s = getSettings();
  const count = (await store.allRecords()).length;
  view.innerHTML = `
    <div class="page">
      <h1 class="page-title">설정</h1>
      <form id="settings-form" class="settings" novalidate>
        <section class="card">
          <h2>회사 정보</h2>
          <label class="field"><span>회사 이름 <small>(공유 이미지에 표시)</small></span><input id="f-company" value="${esc(s.company)}"></label>
        </section>

        <section class="card">
          <h2>저장할 때 남길 소리</h2>
          <label class="field"><span>저장 버튼을 누르기 직전 몇 초를 함께 남길까요?</span>
            <select id="f-audio-sec">
              ${[0, 5, 10, 20, 30].map((n) => `<option value="${n}"${s.audioSec === n ? ' selected' : ''}>${n ? `${n}초` : '남기지 않음'}</option>`).join('')}
            </select></label>
          <p class="fine">10초에 약 1MB입니다. 바꾼 값은 분석 화면을 다시 열 때부터 적용됩니다.</p>
        </section>

        <section class="card">
          <h2>게이지</h2>
          <label class="field field-num"><span>주황색 경고 구간 시작 (dB(A))</span>
            <input id="f-alert" type="number" inputmode="decimal" min="30" max="130" step="1" value="${s.alertLevel}"></label>
        </section>

        <section class="card">
          <h2>마이크 보정</h2>
          <p>현재 보정값 <strong id="cal-offset">${s.offset} dB</strong> · <span id="cal-date">${s.calibratedAt ? `${fmtShortDate(s.calibratedAt)} 보정` : '보정 안 됨'}</span></p>
          <p class="fine">휴대폰마다 마이크 감도가 달라 기기별로 한 번씩 보정해야 값이 맞습니다.</p>
          <ol class="guide">
            <li>정밀 소음계(기준기)와 휴대폰을 나란히 두세요.</li>
            <li>공회전 소리처럼 일정한 소리가 나게 하세요.</li>
            <li>아래 버튼을 누르고, 같은 5초 동안 소음계의 평균값(Leq, A특성)을 읽으세요.</li>
            <li>소음계 값을 입력하고 적용을 누르세요.</li>
          </ol>
          <button type="button" class="btn btn-wide" data-act="cal-measure">보정 측정 (5초)</button>
          <div class="cal-result" id="cal-result" hidden>
            <p>휴대폰 측정값 <strong id="cal-phone">-</strong> dB(A)</p>
            <div class="inline-form">
              <label class="field field-num"><span>소음계 값</span><input id="f-cal-ref" type="number" inputmode="decimal" step="0.1"></label>
              <button type="button" class="btn btn-primary" data-act="cal-apply">적용</button>
            </div>
          </div>
          <details>
            <summary>보정값 직접 입력</summary>
            <label class="field field-num"><span>보정값 (dB)</span><input id="f-offset" type="number" inputmode="decimal" step="0.1" value="${s.offset}"></label>
          </details>
        </section>

        <section class="card">
          <h2>관리자 비밀번호</h2>
          <label class="field"><span>새 비밀번호 <small>(바꿀 때만 입력, 숫자 4자리 이상)</small></span>
            <input id="f-newpin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
        </section>

        <section class="card">
          <h2>데이터</h2>
          <p>이 휴대폰에 저장된 기록 <strong>${count}건</strong>. 기록은 이 휴대폰 안에만 있으니 필요하면 엑셀 파일로 보내 두세요.</p>
          <button type="button" class="btn btn-danger-quiet btn-wide" data-act="clear">모든 기록 삭제</button>
        </section>

        <p class="alert" id="settings-error" hidden></p>
        <div class="action-bar"><button class="btn btn-primary btn-wide" type="submit">설정 저장</button></div>
      </form>
      <p class="fine about">실시간 소음 분석 v${APP_VERSION}. 스마트폰 측정값은 참고용이며 법정 측정을 대신하지 않습니다.</p>
    </div>`;

  const $ = (id) => view.querySelector(`#${id}`);
  let calMeter = null;
  let calPhone = null;
  cleanup = () => calMeter?.stop();

  view.querySelector('[data-act=cal-measure]').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    calMeter = new Meter(getSettings().offset);
    try {
      await calMeter.start();
      if (!calMeter.running) await calMeter.wake();
      const until = Date.now() + 12000;
      while (calMeter.elapsed < 5) {
        if (Date.now() > until) throw new Error('마이크 입력이 없습니다. 다시 시도해 주세요.');
        btn.textContent = `측정 중… ${Math.ceil(5 - calMeter.elapsed)}초`;
        await sleep(100);
      }
      calPhone = calMeter.leq;
      $('cal-phone').textContent = fmtDb(calPhone);
      $('cal-result').hidden = false;
      $('f-cal-ref').focus();
    } catch (err) {
      if (err?.code !== 'cancelled') toast(err.message);
    } finally {
      calMeter?.stop();
      calMeter = null;
      btn.disabled = false;
      btn.textContent = '보정 측정 다시 하기 (5초)';
    }
  };
  view.querySelector('[data-act=cal-apply]').onclick = () => {
    const ref = parseFloat($('f-cal-ref').value);
    if (!Number.isFinite(ref) || ref < 20 || ref > 140 || !Number.isFinite(calPhone)) return toast('소음계 값을 확인해 주세요');
    const offset = round1(getSettings().offset + (ref - calPhone));
    saveSettings({ offset, calibratedAt: Date.now() });
    $('cal-offset').textContent = `${offset} dB`;
    $('cal-date').textContent = `${fmtShortDate(Date.now())} 보정`;
    $('f-offset').value = offset;
    $('cal-result').hidden = true;
    toast(`보정했습니다 (보정값 ${offset} dB)`);
  };
  const clear = view.querySelector('[data-act=clear]');
  clear.onclick = async () => {
    if (clear.dataset.armed !== 'yes') {
      clear.dataset.armed = 'yes';
      clear.textContent = `한 번 더 누르면 ${count}건이 모두 삭제됩니다`;
      return;
    }
    await store.clearRecords();
    toast('모든 기록을 삭제했습니다');
    route();
  };

  view.querySelector('#settings-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('settings-error');
    const showError = (msg) => {
      err.textContent = msg;
      err.hidden = false;
      err.scrollIntoView({ block: 'center' });
    };
    const alertLevel = parseFloat($('f-alert').value);
    if (!(alertLevel >= 30 && alertLevel <= 130)) return showError('경고 구간은 30–130 dB(A) 사이로 입력해 주세요.');
    const offset = parseFloat($('f-offset').value);
    if (!(offset > 0 && offset < 200)) return showError('보정값을 확인해 주세요.');
    const newPin = $('f-newpin').value.trim();
    if (newPin && !/^\d{4,12}$/.test(newPin)) return showError('비밀번호는 숫자 4–12자리로 입력해 주세요.');
    const before = getSettings();
    saveSettings({
      company: $('f-company').value.trim() || before.company,
      audioSec: Number($('f-audio-sec').value),
      alertLevel: Math.round(alertLevel),
      offset: round1(offset),
      calibratedAt: round1(offset) !== before.offset ? Date.now() : before.calibratedAt,
      pin: newPin || before.pin,
    });
    err.hidden = true;
    toast('설정을 저장했습니다');
  };
}

/* ---------- boot ---------- */

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
