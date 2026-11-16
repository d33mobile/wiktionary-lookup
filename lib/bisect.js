// Binary searches over a sorted key sequence addressed by index. The sequence
// is abstract: keyAt(i) returns the key at position i, so the same code serves
// the entry order arrays (key derived from the entry) and the definition word
// table (key is the word itself). Keys compare in UTF-16 code unit order, which
// is what JS `<` does, and the builder sorts with the same comparison.

// First position in [lo, hi) whose key is >= q.
export function lowerBound(lo, hi, keyAt, q) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyAt(mid) < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Given lo = lowerBound(q), first position in [lo, hi) whose key does not
// start with q. All keys with prefix q are contiguous from lo in sorted order.
export function prefixEnd(lo, hi, keyAt, q) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyAt(mid).startsWith(q)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Given lo = lowerBound(q), first position in [lo, hi) whose key is not q.
export function exactEnd(lo, hi, keyAt, q) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyAt(mid) === q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Returns {lo, exactHi, hi}: [lo, exactHi) are keys equal to q, [lo, hi) are
// keys with prefix q. Searching inside a previous [lo, hi) is what makes
// incremental narrowing work.
export function prefixRange(lo, hi, keyAt, q) {
  const start = lowerBound(lo, hi, keyAt, q);
  const end = prefixEnd(start, hi, keyAt, q);
  const exactHi = exactEnd(start, end, keyAt, q);
  return { lo: start, exactHi, hi: end };
}

// First position in [lo, hi) whose key fails `below`, for a predicate that
// holds on a leading run of the positions and fails on the rest (hi when it
// holds everywhere). Probes `fanout - 1` evenly spaced positions per step,
// so fanout 2 is a bisect and a larger fanout takes fewer steps. keyAt may
// return null for a key it cannot read yet (an index read lazily): the step
// still probes all its positions, so the caller learns every key that step
// needs at once, and the result is -1 (load them and call again).
export function partitionPoint(lo, hi, keyAt, below, fanout = 2) {
  while (lo < hi) {
    const n = hi - lo;
    const probes = Math.min(fanout - 1, n);
    let from = lo;
    let to = hi;
    let unknown = false;
    for (let j = 1; j <= probes; j++) {
      const i = lo + Math.floor((n * j) / (probes + 1));
      const k = keyAt(i);
      if (k === null) unknown = true;
      else if (below(k)) from = Math.max(from, i + 1);
      else to = Math.min(to, i);
    }
    if (unknown) return -1;
    lo = from;
    hi = to;
  }
  return lo;
}
