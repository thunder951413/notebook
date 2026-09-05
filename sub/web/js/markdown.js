// GFM-ish markdown renderer: headings, bold/italic/strike, code, tables,
// task lists, nested lists, blockquotes, links, images, wikilinks [[...]],
// math $...$ / $$...$$, hr, autolinks. Raw HTML is escaped (XSS-safe).

const esc = (s) => String(s)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function safeUrl(u) {
  const s = String(u || '').trim();
  if (s.startsWith('/api/assets/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('#')) return s;
  return null;
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
const BLOCK_MATH_RE = /^\s*\$\$\s*$/;

// ---------------- inline ----------------

const TOKEN_SOURCE = [
  '(\\*\\*[^*]+\\*\\*)',
  '(__[^_]+__)',
  '(\\*[^*\n]+\\*)',
  '(_[^_\n]+_)',
  '(~~[^~\n]+~~)',
  '(`[^`]+`)',
  '(!\\[[^\\]]*\\]\\([^)\\s]+(?:\\s+\\"[^\\"]*\\")?\\))',
  '(\\[[^\\]]*\\]\\([^)\\s]+(?:\\s+\\"[^\\"]*\\")?\\))',
  '(<https?:\\/\\/[^>\\s]+>)',
  '(\\[\\[[^\\]]+\\]\\])',
  '(\\$[^$\n]+\\$)',
].join('|');
const TOKEN_RE = new RegExp(TOKEN_SOURCE, 'g');

const IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;

function renderInline(text) {
  if (!text) return '';
  let html = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const next = m.index + m[0].length;
    html += esc(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) {
      html += '<strong>' + renderInline(tok.slice(2, -2)) + '</strong>';
    } else if (tok.startsWith('~~')) {
      html += '<del>' + renderInline(tok.slice(2, -2)) + '</del>';
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      html += '<em>' + renderInline(tok.slice(1, -1)) + '</em>';
    } else if (tok.startsWith('`')) {
      html += '<code>' + esc(tok.slice(1, -1)) + '</code>';
    } else if (tok.startsWith('![')) {
      const inner = IMG_RE.exec(tok);
      if (inner) {
        const url = safeUrl(inner[2]);
        if (url) html += '<img src="' + esc(url) + '" alt="' + esc(inner[1]) + '" loading="lazy" class="md-img" data-lightbox>';
        else html += esc(tok);
      } else html += esc(tok);
    } else if (tok.startsWith('[') && tok.includes('](')) {
      const inner = LINK_RE.exec(tok);
      if (inner) {
        const url = safeUrl(inner[2]);
        if (url) {
          html += '<a href="' + esc(url) + '"' + (url.startsWith('http') ? ' target="_blank" rel="noopener"' : '') + '>' + renderInline(inner[1]) + '</a>';
        } else html += esc(tok);
      } else html += esc(tok);
    } else if (tok.startsWith('<http')) {
      const u = tok.slice(1, -1);
      html += '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>';
    } else if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const parts = inner.split('|');
      const target = (parts[0] || '').trim();
      const alias = (parts[1] || parts[0] || '').trim();
      html += '<a class="wiki" href="#" data-wiki="' + esc(target) + '">' + esc(alias) + '</a>';
    } else if (tok.startsWith('$')) {
      html += '<span class="math" title="' + esc(tok) + '">' + esc(tok) + '</span>';
    } else {
      html += esc(tok);
    }
    last = next;
    TOKEN_RE.lastIndex = next; // recursion inside the branches clobbers lastIndex; restore it
  }
  html += esc(text.slice(last));
  return html;
}

// ---------------- code highlighting ----------------

const LANG_KEYWORDS = {
  js: ['function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'async', 'await', 'yield', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw', 'null', 'undefined', 'true', 'false', 'static', 'get', 'set'],
  ts: ['function', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'typeof', 'in', 'of', 'class', 'extends', 'implements', 'super', 'this', 'async', 'await', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw', 'null', 'undefined', 'true', 'false', 'static', 'interface', 'type', 'enum', 'namespace', 'declare', 'readonly', 'public', 'private', 'protected', 'keyof', 'never', 'unknown', 'as'],
  py: ['def', 'return', 'import', 'from', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'class', 'lambda', 'pass', 'break', 'continue', 'yield', 'global', 'nonlocal', 'raise', 'assert', 'del', 'not', 'and', 'or', 'in', 'is', 'None', 'True', 'False', 'async', 'await', 'self'],
  json: ['true', 'false', 'null'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit', 'export', 'local', 'source', 'echo', 'cd', 'sudo', 'grep', 'sed', 'awk', 'cat', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'curl', 'wget', 'git', 'npm', 'pnpm', 'node'],
  css: ['@media', '@import', '@keyframes', '@font-face', 'hover', 'active', 'focus', 'first-child', 'last-child'],
  html: ['div', 'span', 'a', 'img', 'input', 'button', 'form', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'nav', 'main', 'aside', 'script', 'style', 'link', 'meta', 'title', 'body', 'html', 'head'],
  java: ['public', 'private', 'protected', 'class', 'interface', 'enum', 'extends', 'implements', 'static', 'final', 'void', 'int', 'long', 'float', 'double', 'boolean', 'char', 'byte', 'short', 'String', 'return', 'new', 'this', 'super', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'null', 'true', 'false', 'abstract', 'synchronized'],
  c: ['int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'static', 'const', 'volatile', 'register', 'extern', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'goto', 'sizeof', 'NULL', 'true', 'false', 'include', 'define', 'main'],
  go: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'break', 'continue', 'defer', 'go', 'chan', 'struct', 'interface', 'map', 'type', 'var', 'const', 'nil', 'true', 'false', 'select', 'fallthrough', 'default'],
  rust: ['fn', 'let', 'mut', 'const', 'static', 'return', 'if', 'else', 'match', 'loop', 'while', 'for', 'in', 'impl', 'trait', 'struct', 'enum', 'mod', 'use', 'pub', 'crate', 'self', 'super', 'where', 'async', 'await', 'move', 'ref', 'dyn', 'true', 'false', 'None', 'Some', 'Ok', 'Err'],
  sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'NULL', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'INDEX', 'UNIQUE', 'DEFAULT', 'DISTINCT', 'AS'],
};

// comment / string / number rules as raw regexes
const R_COMMENT = /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//;
const R_STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\n]*`/;
const R_NUMBER = /\b\d+(?:\.\d+)?\b/;
const R_FUNC = /[A-Za-z_$][\w$]*(?=\s*\()/;

function highlight(code, lang) {
  const l = (lang || '').toLowerCase().replace(/^language-/, '');
  const kws = LANG_KEYWORDS[l] || [];
  const rules = [[R_COMMENT, 'cm'], [R_STRING, 'st'], [R_NUMBER, 'nu']];
  if (kws.length) {
    const kwRe = new RegExp('\\b(?:' + kws.join('|') + ')\\b', 'g');
    rules.push([kwRe, 'kw']);
  }
  rules.push([R_FUNC, 'fn']);
  const master = new RegExp(rules.map(r => '(' + r[0].source + ')').join('|'), 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = master.exec(code)) !== null) {
    out += esc(code.slice(last, m.index));
    let cls = null;
    for (let i = 0; i < rules.length; i++) {
      if (m[i + 1] !== undefined) { cls = rules[i][1]; break; }
    }
    out += '<span class="tok-' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

// ---------------- blocks ----------------

function renderBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let i = 0;

  function collectFence(marker) {
    const body = [];
    let j = i + 1;
    while (j < lines.length) {
      const fm = FENCE_RE.exec(lines[j]);
      if (fm && fm[1] === marker) { j++; break; }
      body.push(lines[j]);
      j++;
    }
    i = j;
    return body.join('\n');
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // math block $$ ... $$
    if (BLOCK_MATH_RE.test(line) && i + 1 < lines.length) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && !BLOCK_MATH_RE.test(lines[j])) { body.push(lines[j]); j++; }
      i = j + 1;
      const math = body.join('\n');
      out.push('<div class="math-block" title="' + esc(math) + '">' + esc(math) + '</div>');
      continue;
    }

    // code fence
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const code = collectFence(fm[1]);
      const lang = fm[2] || '';
      out.push('<pre class="code-block"><code class="lang-' + esc(lang) + '">' + highlight(code, lang) + '</code></pre>');
      continue;
    }

    // indented code block (4+ spaces, not a list item)
    if (/^( {4,}|\t+)\S/.test(line) && !LIST_ITEM_RE.test(line)) {
      const body = [];
      let j = i;
      while (j < lines.length && (/^( {4,}|\t+)\S/.test(lines[j]) || /^\s*$/.test(lines[j]))) {
        if (!/^\s*$/.test(lines[j])) body.push(lines[j].replace(/^( {4}|\t)/, ''));
        j++;
      }
      i = j;
      out.push('<pre class="code-block"><code>' + highlight(body.join('\n'), '') + '</code></pre>');
      continue;
    }

    // heading
    const hm = HEADING_RE.exec(line);
    if (hm) {
      const level = Math.min(hm[1].length, 6);
      out.push('<h' + level + '>' + renderInline(hm[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    // setext headings
    if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1])) {
      out.push('<h1>' + renderInline(line) + '</h1>');
      i += 2;
      continue;
    }
    if (i + 1 < lines.length && /^-+\s*$/.test(lines[i + 1]) && !LIST_ITEM_RE.test(line)) {
      out.push('<h2>' + renderInline(line) + '</h2>');
      i += 2;
      continue;
    }

    // hr
    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

    // blockquote
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (!q) {
          if (/^\s*$/.test(lines[i])) { i++; continue; }
          break;
        }
        body.push(q[1]);
        i++;
      }
      out.push('<blockquote>' + renderBlocks(body.join('\n')) + '</blockquote>');
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const rows = [line];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j]) && !HEADING_RE.test(lines[j]) && !FENCE_RE.test(lines[j])) {
        rows.push(lines[j]);
        j++;
      }
      i = j;
      const header = rows[0].replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map(c => c.trim());
      const delimCells = lines[i - 1].replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|');
      const aligns = delimCells.map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        return 'left';
      });
      let html = '<div class="table-wrap"><table><thead><tr>';
      header.forEach((h, idx) => { html += '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(h) + '</th>'; });
      html += '</tr></thead><tbody>';
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|');
        html += '<tr>';
        cells.forEach((c, idx) => { html += '<td' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c.trim()) + '</td>'; });
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      out.push(html);
      continue;
    }

    // list
    if (LIST_ITEM_RE.test(line)) {
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !HEADING_RE.test(lines[i]) && !FENCE_RE.test(lines[i]) && !LIST_ITEM_RE.test(lines[i]) && !/^\s*>/.test(lines[i]) && !HR_RE.test(lines[i]) && !BLOCK_MATH_RE.test(lines[i]) && !(i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1])) && !(i + 1 < lines.length && /^-+\s*$/.test(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      out.push('<p>' + renderInline(para.join(' ')) + '</p>');
    } else i++;
  }
  return out.join('\n');
}

function renderList(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM_RE.exec(lines[i]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '    ').length;
    const ordered = /^\d/.test(m[2]);
    const item = { indent, ordered, content: m[3], nestedHtml: null };
    let j = i + 1;
    const bodyLines = [];
    while (j < lines.length) {
      const l2 = lines[j];
      if (/^\s*$/.test(l2)) break;
      const m2 = LIST_ITEM_RE.exec(l2);
      const indent2 = l2.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      if (m2 && (indent2 < indent || indent2 === indent)) break;
      if (indent2 <= indent) break;
      bodyLines.push(l2);
      j++;
    }
    if (bodyLines.length) {
      item.nestedHtml = renderList(bodyLines, 0).html;
      i = j;
    } else {
      i = j;
    }
    items.push(item);
    // allow blank lines between same-level items (tight lists)
    if (i < lines.length && /^\s*$/.test(lines[i])) {
      let k = i;
      while (k < lines.length && /^\s*$/.test(lines[k])) k++;
      if (k < lines.length && LIST_ITEM_RE.test(lines[k])) {
        const m2 = LIST_ITEM_RE.exec(lines[k]);
        if (m2[1].replace(/\t/g, '    ').length === indent) i = k;
      }
    }
  }

  let html = '';
  let currentUl = null;
  let currentOl = null;
  for (const item of items) {
    const tag = item.ordered ? 'ol' : 'ul';
    if (tag === 'ul' && currentUl !== true) { if (currentUl !== null) html += '</ol>'; html += '<ul>'; currentUl = true; currentOl = false; }
    if (tag === 'ol' && currentOl !== true) { if (currentOl !== null) html += '</ul>'; html += '<ol>'; currentOl = true; currentUl = false; }

    const task = /^\[([ xX])\]\s+(.*)$/.exec(item.content);
    let inner;
    if (task) {
      const checked = task[1].toLowerCase() === 'x';
      inner = '<label class="task-item"><input type="checkbox" data-task data-checked="' + (checked ? '1' : '0') + '"' + (checked ? ' checked' : '') + '><span>' + renderInline(task[2]) + '</span></label>';
    } else {
      inner = renderInline(item.content);
    }
    html += '<li>' + inner + (item.nestedHtml || '') + '</li>';
  }
  if (currentUl !== null && currentUl) html += '</ul>';
  if (currentOl !== null && currentOl) html += '</ol>';

  return { html, next: i };
}

export function renderMarkdown(text) {
  return renderBlocks(text);
}

if (typeof window !== 'undefined') {
  window.renderMarkdown = renderMarkdown;
  window.markdownEscape = esc;
}
