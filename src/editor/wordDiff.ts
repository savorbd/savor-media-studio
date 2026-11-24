/** Word-level difference between two texts, for showing what a version changed. */
export type DiffPart = { t: 'eq' | 'add' | 'del'; s: string };

// Words, runs of spaces and single punctuation marks.
const tokens = (s: string) => s.match(/\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu) || [];

export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ t: 'eq', s: before }] : [];
  if (!before) return [{ t: 'add', s: after }];
  if (!after) return [{ t: 'del', s: before }];
  const a = tokens(before);
  const b = tokens(after);
  // Trim the common start and end, then LCS on what is left.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const out: DiffPart[] = [];
  const push = (t: DiffPart['t'], s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s; else if (s) out.push({ t, s });
  };
  push('eq', a.slice(0, pre).join(''));
  if (A.length * B.length > 250000) {
    push('del', A.join(''));
    push('add', B.join(''));
  } else {
    const n = A.length, m = B.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { push('eq', A[i]); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { push('del', A[i]); i++; }
      else { push('add', B[j]); j++; }
    }
  }
  push('eq', a.slice(a.length - suf).join(''));
  return out;
}
