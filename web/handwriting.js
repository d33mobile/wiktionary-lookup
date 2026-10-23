// Handwriting pad for Chinese and Japanese: strokes drawn on a canvas are
// matched by HanziLookupJS (web/vendor/hanzilookup, GPL, with the Make Me a
// Hanzi stroke data under the Arphic Public License) after every stroke,
// and the best candidates are offered as buttons that append the character
// to the query. The library (classic scripts) and its 0.8 MB data are
// loaded only when the pad is first opened.

const BASE = 'vendor/hanzilookup/';
// In dependency order; each file adds to the global HanziLookup object.
const SCRIPTS = ['decodeCompact', 'init', 'subStroke', 'analyzedStroke', 'cubicCurve2D', 'analyzedCharacter',
  'characterMatch', 'matchCollector', 'matcher'];
const DATA = 'mmah';
export const CANDIDATES = 8;
// Strokes are kept in a square of this many units, whatever the canvas size.
const UNITS = 280;

let loading = null;
let matcher = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`cannot load ${src}`));
    document.head.appendChild(s);
  });
}

export function loadRecognizer() {
  if (!loading) {
    loading = (async () => {
      for (const name of SCRIPTS) await loadScript(`${BASE}src/${name}.js`);
      await new Promise((resolve, reject) => {
        window.HanziLookup.init(DATA, `${BASE}${DATA}.json`, (ok) => (ok ? resolve() : reject(new Error('cannot load the stroke data'))));
      });
      matcher = new window.HanziLookup.Matcher(DATA);
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

// strokes: [[[x, y], ...], ...] in pixels -> best characters first.
export function recognize(strokes, limit) {
  return new Promise((resolve) => {
    const analyzed = new window.HanziLookup.AnalyzedCharacter(strokes);
    matcher.match(analyzed, limit || CANDIDATES, (matches) => resolve(matches.map((m) => m.character)));
  });
}

// The pad: canvas drawing with pointer events, undo, clear, candidates.
export class Pad {
  constructor({ canvas, candidates, status, onPick }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.candidates = candidates;
    this.status = status;
    this.onPick = onPick;
    this.strokes = [];
    this.current = null;
    this.generation = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (ev) => this.down(ev));
    canvas.addEventListener('pointermove', (ev) => this.move(ev));
    canvas.addEventListener('pointerup', (ev) => this.up(ev));
    canvas.addEventListener('pointercancel', (ev) => this.up(ev));
    candidates.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-char]');
      if (b) {
        this.onPick(b.dataset.char);
        this.clear();
      }
    });
  }

  // Gives the canvas one backing pixel per device pixel. A canvas scaled by
  // CSS stays blank on the Android 9 WebView (Chromium 66) in the emulator,
  // and matching sizes is sharper anyway. Call when the pad is shown.
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw();
  }

  point(ev) {
    const r = this.canvas.getBoundingClientRect();
    return [Math.round((ev.clientX - r.left) * UNITS / r.width), Math.round((ev.clientY - r.top) * UNITS / r.height)];
  }

  down(ev) {
    ev.preventDefault();
    if (this.canvas.setPointerCapture) this.canvas.setPointerCapture(ev.pointerId);
    this.current = [this.point(ev)];
    this.draw();
  }

  move(ev) {
    if (!this.current) return;
    ev.preventDefault();
    const p = this.point(ev);
    const last = this.current[this.current.length - 1];
    if (p[0] !== last[0] || p[1] !== last[1]) {
      this.current.push(p);
      this.draw();
    }
  }

  up(ev) {
    if (!this.current) return;
    ev.preventDefault();
    if (this.current.length > 1) this.strokes.push(this.current);
    this.current = null;
    this.draw();
    this.update();
  }

  undo() {
    this.strokes.pop();
    this.draw();
    this.update();
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.draw();
    this.update();
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(canvas.width / UNITS, 0, 0, canvas.height / UNITS, 0, 0);
    ctx.clearRect(0, 0, UNITS, UNITS);
    // The theme's text color, with a literal fallback should the computed
    // value be empty or rejected.
    ctx.strokeStyle = '#1c1c1a';
    ctx.strokeStyle = getComputedStyle(canvas).color || '#1c1c1a';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const all = this.current ? this.strokes.concat([this.current]) : this.strokes;
    for (const s of all) {
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    }
  }

  async update() {
    const mine = ++this.generation;
    if (!this.strokes.length) {
      this.show([], '');
      return;
    }
    const t0 = performance.now();
    const chars = await recognize(this.strokes, CANDIDATES);
    if (mine !== this.generation) return;
    this.show(chars, `${chars.length} candidates in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  show(chars, text) {
    while (this.candidates.firstChild) this.candidates.removeChild(this.candidates.firstChild);
    for (const ch of chars) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad-candidate';
      b.dataset.char = ch;
      b.textContent = ch;
      this.candidates.appendChild(b);
    }
    this.status.textContent = text;
  }
}
