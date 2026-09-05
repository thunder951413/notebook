// Simple LCS-based line diff. Returns {added, removed} line arrays for rendering.
export function diffLines(aText, bText) {
  const a = String(aText || '').split('\n');
  const b = String(bText || '').split('\n');
  const n = a.length, m = b.length;
  // DP table (may be big; cap to avoid pathological memory)
  const maxLen = 4000;
  if (n * m > maxLen * maxLen) {
    return { rows: naiveRows(a, b) };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      rows.push({ type: 'del', text: a[i] }); i++;
    } else {
      rows.push({ type: 'add', text: b[j] }); j++;
    }
  }
  while (i < n) { rows.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { rows.push({ type: 'add', text: b[j] }); j++; }
  return { rows };
}

function naiveRows(a, b) {
  const rows = [];
  for (const l of a) rows.push({ type: 'del', text: l });
  for (const l of b) rows.push({ type: 'add', text: l });
  return rows;
}

export function renderDiffRows(rows) {
  return rows.map(r => {
    const cls = r.type === 'del' ? 'diff-del' : r.type === 'add' ? 'diff-add' : 'diff-same';
    const sign = r.type === 'del' ? '-' : r.type === 'add' ? '+' : ' ';
    return '<div class="diff-row ' + cls + '"><span class="diff-sign">' + sign + '</span><span class="diff-text">' + window.markdownEscape(r.text) + '</span></div>';
  }).join('');
}

window.diffLines = diffLines;
window.renderDiffRows = renderDiffRows;
