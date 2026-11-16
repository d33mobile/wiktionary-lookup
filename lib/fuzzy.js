// Edit distance for the fuzzy fallback of the search (lib/engine.js
// Session.collectFuzzy). Browser-safe: no Node APIs.

// Damerau-Levenshtein distance in its restricted form (optimal string
// alignment): insertion, deletion, substitution and the transposition of two
// adjacent characters each cost 1, and no substring is edited twice. Counts
// code points, not UTF-16 units. Stops as soon as the distance must exceed
// `max` and returns max + 1 then, so a scan over many keys rejects most of
// them after a row or two.
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  const s = Array.from(a);
  const t = Array.from(b);
  const n = s.length;
  const m = t.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (n === 0 || m === 0) return Math.max(n, m);
  let before = new Array(m + 1);
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    const si = s[i - 1];
    for (let j = 1; j <= m; j++) {
      const tj = t[j - 1];
      let v = prev[j - 1] + (si === tj ? 0 : 1);
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (i > 1 && j > 1 && si === t[j - 2] && s[i - 2] === tj && before[j - 2] + 1 < v) v = before[j - 2] + 1;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every later cell descends from a cell of this row or the one before
    // (transposition), and neither row can drop below its minimum.
    if (rowMin > max && (i === 1 || Math.min(...prev) > max)) return max + 1;
    const spare = before;
    before = prev;
    prev = cur;
    cur = spare;
  }
  return prev[m] > max ? max + 1 : prev[m];
}

// The strings left after deleting one of the first `count` code points of s
// (a typo among the first letters hides a word behind the wrong prefix),
// without duplicates and without s itself.
export function leadingDeletions(s, count) {
  const cps = Array.from(s);
  const out = [];
  for (let i = 0; i < Math.min(count, cps.length); i++) {
    const v = cps.slice(0, i).concat(cps.slice(i + 1)).join('');
    if (v !== s && !out.includes(v)) out.push(v);
  }
  return out;
}
