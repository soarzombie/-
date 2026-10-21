// Video of the analyzer for sharing: the readings, the graphs on screen and the camera window (camera.js)
// are drawn onto one canvas about 30 times a second and recorded together with the microphone's sound
// (MediaRecorder: MP4 where the browser can, as on iPhone and recent Chrome, else WebM).

// H.264 MP4 plays everywhere (messengers, iPhone); without it WebM, and a plain MP4 last (some browsers
// put VP9 in it, which phones may not play)
const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
export const MAX_VIDEO_SEC = 120;
const HEAD = 64; // px (before scaling) for the readings above the graphs
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

// The type to record, '' for the browser's default, or null when video cannot be recorded here.
export function videoType() {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

export const videoExt = (type) => (/mp4/.test(type) ? 'mp4' : 'webm');

// Where an element sits inside `root`, in layout pixels (right also when the page is turned sideways).
function offsetIn(el, root) {
  let x = 0;
  let y = 0;
  for (let e = el; e && e !== root; e = e.offsetParent) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return [x, y];
}

export class ScreenVideo {
  // chart: the element holding the graph canvases; readings(): { now, unit, tw, min, avg, max, time,
  // extra, foot } as text; audioTrack: the microphone track; colors: { bg, panel, ink, sub }; camera: the
  // CameraWindow (drawn where it sits while it is on).
  constructor({ chart, readings, audioTrack, colors, camera = null }) {
    this.chart = chart;
    this.camera = camera;
    this.readings = readings;
    this.colors = colors;
    this.type = videoType();
    const cw = chart.clientWidth;
    const ch = chart.clientHeight;
    this.k = Math.min(2, 1280 / cw); // up to 1280 px wide
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round((cw * this.k) / 2) * 2; // even sizes for the encoder
    this.canvas.height = Math.round(((ch + HEAD) * this.k) / 2) * 2;
    this.g = this.canvas.getContext('2d');
    this.frame();
    const stream = this.canvas.captureStream(30);
    if (audioTrack) stream.addTrack(audioTrack);
    this.recorder = new MediaRecorder(stream, { ...(this.type ? { mimeType: this.type } : {}), videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
  }

  start() {
    this.started = performance.now();
    this.recorder.start(1000);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  get seconds() {
    return this.started ? (performance.now() - this.started) / 1000 : 0;
  }

  // Resolves the recorded video as a Blob.
  stop() {
    cancelAnimationFrame(this.raf);
    return new Promise((resolve) => {
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || this.type || 'video/webm' }));
      if (this.recorder.state === 'inactive') this.recorder.onstop();
      else this.recorder.stop();
    });
  }

  frame() {
    const { g, k, colors: c } = this;
    const W = this.canvas.width;
    const r = this.readings();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, W, this.canvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    const w = W / k;
    // readings: the level large on the left, min / average / max on the right, a line of details below
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = c.ink;
    g.font = `700 30px ${FONT}`;
    g.fillText(r.now, 10, 34);
    const nw = g.measureText(r.now).width;
    g.font = `700 13px ${FONT}`;
    g.fillStyle = c.sub;
    g.fillText(`${r.unit} ${r.tw}`, 16 + nw, 34);
    g.textAlign = 'right';
    g.font = `600 13px ${FONT}`;
    g.fillStyle = c.ink;
    g.fillText(`최소 ${r.min}  평균 ${r.avg}  최대 ${r.max}`, w - 10, 22);
    g.fillStyle = c.sub;
    g.font = `500 11px ${FONT}`;
    g.fillText(r.time, w - 10, 38);
    g.textAlign = 'left';
    g.fillText(r.extra, 10, 54, w - 20);
    g.textAlign = 'right';
    g.fillText(r.foot, w - 10, 54, Math.max(80, w - 30 - g.measureText(r.extra).width));
    // the graphs as on screen
    g.fillStyle = c.panel;
    g.fillRect(0, HEAD, w, this.chart.clientHeight);
    for (const cv of this.chart.querySelectorAll('canvas')) {
      const host = cv.parentElement;
      if (!host || host.offsetParent === null || !cv.width) continue;
      const [x, y] = offsetIn(host, this.chart);
      g.drawImage(cv, x, HEAD + y, host.clientWidth, host.clientHeight);
    }
    this.camera?.draw(g, HEAD);
  }
}
