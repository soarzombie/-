// The camera window for 영상: what the phone's camera sees, in a small window over the graph that can be
// dragged anywhere on it. ScreenVideo draws it into the video where it sits on screen.
//
// Turned sideways in CSS (iPhone, data-rotate), the screen stays portrait and so does the camera image,
// while the page is rotated a quarter turn clockwise: the image is turned a quarter back (on screen and in
// the video) so it shows the scene upright.

import { sideways } from './spectrum.js';

export const cameraSupported = () => !!navigator.mediaDevices?.getUserMedia;

const SIZE = 0.42; // window height as a share of the graph's, at most half its width

export class CameraWindow {
  // el: the window (a <video> and the flip button inside), placed in the graph box; pos: [x, y] as
  // shares of the room left around the window; onMove(pos) after a drag.
  constructor(el, { pos, onMove } = {}) {
    this.el = el;
    this.host = el.parentElement;
    this.video = el.querySelector('video');
    this.flip = el.querySelector('.cam-flip');
    this.pos = Array.isArray(pos) && pos.every((p) => p >= 0 && p <= 1) ? pos : [0.08, 0.08];
    this.onMove = onMove;
    this.facing = 'environment';
    this.gen = 0; // counts closes, so a camera that opens after its window was closed is let go
    this.box = { x: 0, y: 0, w: 0, h: 0 };
    this.video.addEventListener('resize', () => this.layout());
    this.resizer = new ResizeObserver(() => this.layout());
    this.resizer.observe(this.host);
    this.flip.addEventListener('click', () => this.switchCamera());
    this.bindDrag();
  }

  get on() {
    return !!this.stream;
  }

  // Resolves once the camera shows; rejects when it cannot be used (no camera, not allowed) or the window
  // was closed while the camera was asked for.
  async open(facing = this.facing) {
    const gen = this.gen;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    if (gen !== this.gen) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('closed');
    }
    this.stopTracks();
    this.stream = stream;
    this.facing = facing;
    this.video.srcObject = stream;
    // shown once its size is known (kept invisible meanwhile: it has to be laid out to play everywhere)
    if (this.el.hidden) this.el.style.visibility = 'hidden';
    this.el.hidden = false;
    await this.video.play().catch(() => {});
    for (let t = 0; t < 30 && !this.video.videoWidth; t++) await new Promise((r) => setTimeout(r, 100));
    this.layout();
    this.el.style.visibility = '';
    const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
    this.flip.hidden = cams.length < 2;
  }

  // Front and back: the camera in use is let go first (many phones cannot open two at once); if the
  // other one does not open, the first comes back.
  async switchCamera() {
    if (!this.stream || this.switching) return;
    this.switching = true;
    const was = this.facing;
    const gen = this.gen;
    this.stopTracks();
    try {
      await this.open(was === 'environment' ? 'user' : 'environment');
    } catch {
      if (gen === this.gen) await this.open(was).catch(() => {});
    } finally {
      this.switching = false;
    }
  }

  close() {
    this.gen++;
    this.stopTracks();
    this.stream = null;
    this.video.srcObject = null;
    this.el.hidden = true;
  }

  destroy() {
    this.close();
    this.resizer.disconnect();
  }

  stopTracks() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
  }

  // the image is portrait while the page is turned sideways: shown a quarter turn back
  get turned() {
    return sideways() && this.video.videoHeight > this.video.videoWidth;
  }

  layout() {
    if (this.el.hidden) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const turned = this.turned;
    const aspect = turned ? vh / vw : vw / vh;
    const h = Math.round(Math.min(H * SIZE, (W * 0.5) / aspect));
    const w = Math.round(h * aspect);
    const x = Math.round(this.pos[0] * Math.max(0, W - w));
    const y = Math.round(this.pos[1] * Math.max(0, H - h));
    this.box = { x, y, w, h };
    this.edge = getComputedStyle(this.el).borderTopColor; // the video's frame line, as on screen
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    Object.assign(this.video.style, turned ? { width: `${h}px`, height: `${w}px`, transform: 'translate(-50%, -50%) rotate(-90deg)' } : { width: '100%', height: '100%', transform: 'translate(-50%, -50%)' });
  }

  // Dragging moves the window, kept inside the graph. Turned sideways, a finger moving down the screen
  // moves right on the page and one moving right moves up.
  bindDrag() {
    let start = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      start = { id: e.pointerId, cx: e.clientX, cy: e.clientY, x: this.box.x, y: this.box.y };
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        // capture is a convenience: the moves still arrive while the finger stays on the window
      }
      this.el.classList.add('dragging');
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const [dx, dy] = sideways() ? [e.clientY - start.cy, start.cx - e.clientX] : [e.clientX - start.cx, e.clientY - start.cy];
      const roomX = Math.max(0, this.host.clientWidth - this.box.w);
      const roomY = Math.max(0, this.host.clientHeight - this.box.h);
      const x = Math.min(roomX, Math.max(0, start.x + dx));
      const y = Math.min(roomY, Math.max(0, start.y + dy));
      this.pos = [roomX ? x / roomX : 0, roomY ? y / roomY : 0];
      this.layout();
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      this.el.classList.remove('dragging');
      this.onMove?.(this.pos.map((p) => Math.round(p * 1000) / 1000));
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  // Draws the window into a video frame whose graph area starts `top` px down (layout pixels).
  draw(g, top) {
    const v = this.video;
    if (!this.stream || this.el.hidden || v.readyState < 2 || !v.videoWidth) return;
    const { x, y, w, h } = this.box;
    const turned = this.turned;
    const [bw, bh] = turned ? [h, w] : [w, h];
    const s = Math.max(bw / v.videoWidth, bh / v.videoHeight); // cover, as object-fit on screen
    const sw = bw / s;
    const sh = bh / s;
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(x, top + y, w, h, 10);
    else g.rect(x, top + y, w, h);
    g.clip();
    g.translate(x + w / 2, top + y + h / 2);
    if (turned) g.rotate(-Math.PI / 2);
    g.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, -bw / 2, -bh / 2, bw, bh);
    g.restore();
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(x + 1, top + y + 1, w - 2, h - 2, 9);
    else g.rect(x + 1, top + y + 1, w - 2, h - 2);
    g.lineWidth = 2;
    g.strokeStyle = this.edge;
    g.stroke();
    g.restore();
  }
}
