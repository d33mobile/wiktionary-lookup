// The character section of a Chinese entry page: stroke order animated
// from the Make Me a Hanzi medians (each stroke drawn along its median and
// clipped to its outline), stroke count, radical, etymology, the
// decomposition tree with tappable components, and the words that contain
// the character. Data from lib/hanzi-pack.js.
import { components } from '../lib/hanzi-pack.js';

const SVG = 'http://www.w3.org/2000/svg';
// Make Me a Hanzi coordinates: 1024 units, y up, baseline at 900.
const FLIP = 'scale(1, -1) translate(0, -900)';
const BRUSH = 128;
const UNITS_PER_MS = 1.6;
const STROKE_PAUSE_MS = 180;

const ETYMOLOGY = { ideographic: 'Ideographic', pictographic: 'Pictographic', pictophonetic: 'Phonetic-semantic' };
const OPERATORS = {
  '⿰': 'left and right', '⿱': 'top and bottom', '⿲': 'left, middle and right', '⿳': 'top, middle and bottom',
  '⿴': 'surrounded', '⿵': 'open at the bottom', '⿶': 'open at the top', '⿷': 'open at the right',
  '⿸': 'open at the bottom right', '⿹': 'open at the bottom left', '⿺': 'open at the top right', '⿻': 'overlaid',
};

let clipCounter = 0;

function strokeCount(n) {
  return n === 1 ? '1 stroke' : `${n} strokes`;
}

function opLabel(op) {
  // Words only: the description characters (U+2FF0...) are missing from many fonts.
  return OPERATORS[op] || 'combined';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function medianLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

// A static glyph (all strokes filled), for the tree and small previews.
export function glyph(record, size) {
  const svg = svgEl('svg', { viewBox: '0 0 1024 1024', width: size, height: size, class: 'hz-glyph', 'aria-hidden': 'true' });
  const g = svgEl('g', { transform: FLIP });
  for (const d of record.strokes) g.appendChild(svgEl('path', { d, class: 'hz-fill' }));
  svg.appendChild(g);
  return svg;
}

// The stroke order player: {node, play(), pause(), step(), restart(), state()}.
// state(): {stroke (strokes completed), total, playing}.
export function strokePlayer(record) {
  const total = record.strokes.length;
  const node = el('div', 'hz-player');
  const svg = svgEl('svg', { viewBox: '0 0 1024 1024', class: 'hz-anim', role: 'img', 'aria-label': `Stroke order of ${record.character}` });
  const grid = svgEl('g', { class: 'hz-grid' });
  grid.append(svgEl('line', { x1: 0, y1: 0, x2: 1024, y2: 1024 }), svgEl('line', { x1: 1024, y1: 0, x2: 0, y2: 1024 }),
    svgEl('line', { x1: 512, y1: 0, x2: 512, y2: 1024 }), svgEl('line', { x1: 0, y1: 512, x2: 1024, y2: 512 }));
  svg.appendChild(grid);
  const shadow = svgEl('g', { transform: FLIP });
  const ink = svgEl('g', { transform: FLIP });
  const defs = svgEl('defs');
  const strokes = record.strokes.map((d, i) => {
    shadow.appendChild(svgEl('path', { d, class: 'hz-shadow' }));
    const id = `hz-clip-${++clipCounter}`;
    const clip = svgEl('clipPath', { id });
    clip.appendChild(svgEl('path', { d }));
    defs.appendChild(clip);
    const points = record.medians[i] || [];
    const length = medianLength(points) + BRUSH;
    const path = svgEl('path', {
      d: points.map((p, k) => `${k ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' '),
      class: 'hz-ink',
      'clip-path': `url(#${id})`,
      'stroke-width': BRUSH,
      'stroke-dasharray': `${length} ${length}`,
    });
    ink.appendChild(path);
    return { path, length };
  });
  svg.append(defs, shadow, ink);

  const controls = el('div', 'hz-controls');
  const playButton = el('button', 'hz-play', 'Play');
  const stepButton = el('button', 'hz-step', 'Step');
  const restartButton = el('button', 'hz-restart', 'Restart');
  for (const b of [playButton, stepButton, restartButton]) b.type = 'button';
  const counter = el('span', 'hz-counter');
  controls.append(playButton, stepButton, restartButton, counter);
  node.append(svg, controls);

  // done: strokes completed; progress: 0..1 of stroke `done`.
  let done = 0;
  let progress = 0;
  let playing = false;
  let timer = 0;
  let last = 0;

  function draw() {
    strokes.forEach((s, i) => {
      const p = i < done ? 1 : i === done ? progress : 0;
      s.path.style.visibility = p > 0 ? 'visible' : 'hidden';
      s.path.setAttribute('stroke-dashoffset', String(s.length * (1 - p)));
    });
    counter.textContent = `Stroke ${Math.min(done + (progress > 0 ? 1 : 0), total)} of ${total}`;
    playButton.textContent = playing ? 'Pause' : 'Play';
    node.dataset.stroke = String(done);
    node.dataset.playing = playing ? 'true' : 'false';
  }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min(now - last, 100);
    last = now;
    if (done >= total) {
      playing = false;
      draw();
      return;
    }
    progress += (dt * UNITS_PER_MS) / strokes[done].length;
    if (progress >= 1) {
      done += 1;
      progress = 0;
      draw();
      if (done >= total) {
        playing = false;
        draw();
        return;
      }
      timer = setTimeout(() => { last = performance.now(); requestAnimationFrame(frame); }, STROKE_PAUSE_MS);
      return;
    }
    draw();
    requestAnimationFrame(frame);
  }

  const api = {
    node,
    play() {
      if (playing) return;
      if (done >= total) { done = 0; progress = 0; }
      playing = true;
      last = performance.now();
      draw();
      requestAnimationFrame(frame);
    },
    pause() {
      playing = false;
      clearTimeout(timer);
      draw();
    },
    // Completes the current stroke, or draws the next one whole.
    step() {
      api.pause();
      if (done >= total) { done = 0; progress = 0; }
      done += 1;
      progress = 0;
      draw();
    },
    restart() {
      api.pause();
      done = 0;
      progress = 0;
      draw();
    },
    state: () => ({ stroke: done, total, playing }),
  };
  playButton.addEventListener('click', () => (playing ? api.pause() : api.play()));
  stepButton.addEventListener('click', api.step);
  restartButton.addEventListener('click', api.restart);
  // The whole character to start with; Play draws it stroke by stroke.
  done = total;
  draw();
  return api;
}

function etymologyText(e) {
  if (!e) return '';
  const kind = ETYMOLOGY[e.type] || e.type;
  if (e.type === 'pictophonetic') {
    const parts = [];
    if (e.semantic) parts.push(`${e.semantic} gives the meaning`);
    if (e.phonetic) parts.push(`${e.phonetic} the sound`);
    return `${kind}: ${parts.join(', ')}${e.hint ? ` (${e.hint})` : ''}.`;
  }
  return e.hint ? `${kind}: ${e.hint}.` : `${kind}.`;
}

// One level of the tree: a component chip (tappable) and its own parts.
function treeNode(n, onTap) {
  const li = el('li', 'hz-node');
  if (n.character) {
    const chip = el('button', 'hz-component');
    chip.type = 'button';
    chip.dataset.char = n.character;
    if (n.record && n.record.strokes) chip.appendChild(glyph(n.record, 28));
    chip.appendChild(el('span', 'hz-component-char', n.character));
    const facts = [];
    if (n.record && n.record.strokes) facts.push(strokeCount(n.record.strokes.length));
    if (n.record && n.record.definition) facts.push(n.record.definition);
    if (facts.length) chip.appendChild(el('span', 'hz-component-def', facts.join(' · ')));
    if (n.character === '？') chip.disabled = true;
    else chip.addEventListener('click', () => onTap(n.character));
    li.appendChild(chip);
  } else if (n.op) {
    li.appendChild(el('span', 'hz-op', opLabel(n.op)));
  }
  if (n.children && n.children.length) {
    const ul = el('ul', 'hz-tree');
    if (n.character && n.op) ul.appendChild(el('li', 'hz-op', opLabel(n.op)));
    for (const c of n.children) ul.appendChild(treeNode(c, onTap));
    li.appendChild(ul);
  }
  return li;
}

// The section for `character`: tree from pack.tree(), words from
// dict.containing(). onTap(text) opens a character's or word's entry.
export function characterSection({ character, tree, words, onTap }) {
  const section = el('section', 'hz-section');
  section.dataset.char = character;
  section.appendChild(el('h3', 'detail-h', 'Character'));
  const record = tree && tree.record;
  if (record && record.strokes) {
    const player = strokePlayer(record);
    section.appendChild(player.node);
    section.player = player;
    const facts = el('p', 'hz-facts');
    const parts = [strokeCount(record.strokes.length)];
    if (record.radical) parts.push(`radical ${record.radical}`);
    facts.textContent = parts.join(' · ');
    facts.dataset.strokes = String(record.strokes.length);
    section.appendChild(facts);
    const ety = etymologyText(record.etymology);
    if (ety) section.appendChild(el('p', 'hz-etymology', ety));
    if (tree.children.length) {
      section.appendChild(el('h4', 'hz-h', 'Components'));
      const ul = el('ul', 'hz-tree hz-root');
      ul.appendChild(el('li', 'hz-op', opLabel(tree.op)));
      for (const c of tree.children) ul.appendChild(treeNode(c, onTap));
      section.appendChild(ul);
      section.dataset.components = components(record.decomposition).join('');
    }
  }
  if (words && words.length) {
    section.appendChild(el('h4', 'hz-h', `Words with ${character}`));
    const list = el('ul', 'hz-words');
    for (const w of words) {
      const li = el('li');
      const b = el('button', 'hz-word');
      b.type = 'button';
      b.dataset.word = w.simp;
      b.append(el('span', 'hz-word-head', w.simp), el('span', 'hz-word-pinyin', w.pinyin || ''),
        el('span', 'hz-word-def', (w.definition || '').split('\n')[0]));
      b.addEventListener('click', () => onTap(w.simp));
      li.appendChild(b);
      list.appendChild(li);
    }
    section.appendChild(list);
  }
  return section;
}
