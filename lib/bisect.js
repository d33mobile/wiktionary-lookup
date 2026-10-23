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
