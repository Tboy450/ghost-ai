// Small line-based diff (Myers-style shortest edit script via classic O(ND) LCS backtrace).
// Pure and dependency-free so it can run in the browser or under `node --test` unmodified.
export function diffLines(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  const n = a.length, m = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({type: 'equal', line: a[i]}); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({type: 'remove', line: a[i]}); i++; }
    else { ops.push({type: 'add', line: b[j]}); j++; }
  }
  while (i < n) { ops.push({type: 'remove', line: a[i]}); i++; }
  while (j < m) { ops.push({type: 'add', line: b[j]}); j++; }
  return ops;
}

// Collapses long unchanged runs into a single placeholder so a preview of a big file
// only shows the changed lines plus a little surrounding context.
export function contextualize(ops, context = 3) {
  const out = [];
  let run = [];
  const flushRun = (atStart, atEnd) => {
    if (!run.length) return;
    if (run.length <= context * (atStart || atEnd ? 1 : 2)) { out.push(...run); run = []; return; }
    if (atStart) out.push({type: 'gap', count: run.length - context}, ...run.slice(-context));
    else if (atEnd) out.push(...run.slice(0, context), {type: 'gap', count: run.length - context});
    else out.push(...run.slice(0, context), {type: 'gap', count: run.length - context * 2}, ...run.slice(-context));
    run = [];
  };
  for (const op of ops) {
    if (op.type === 'equal') { run.push(op); continue; }
    flushRun(out.length === 0, false);
    out.push(op);
  }
  flushRun(false, true);
  return out;
}
