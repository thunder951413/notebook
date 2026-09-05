import { renderMarkdown } from '../web/js/markdown.js';
const md = [
  '# Hello',
  '',
  'This is **bold**, *italic*, ~~strike~~, `inline code`, $x^2$ and [[Other|别名]].',
  '',
  '- [ ] todo item',
  '- [x] done',
  '  - nested item',
  '  1. ordered one',
  '',
  '> quote line',
  '> second line',
  '',
  '| A | B |',
  '| :- | -: |',
  '| 1 | 2 |',
  '',
  '```js',
  'function hi() { return 42; } // note',
  'const s = "hi";',
  '```',
  '',
  '    indented code',
  '',
  '<script>alert(1)</script> should be escaped',
  '',
  '![alt](/api/assets/abc123/data)',
  '',
  '---',
  '',
  '[link](https://example.com) and <https://auto.example.com>',
  '',
  '$$\u03b1 + \u03b2$$',
  '',
  'Term',
  '====',
  '',
  'sub',
  '----',
  '',
  '1. first',
  '2. second',
].join('\n');
const out = renderMarkdown(md);
console.log(out);
const fails = [];
if (!out.includes('<h1>Hello</h1>')) fails.push('h1');
if (!out.includes('<strong>bold</strong>')) fails.push('bold');
if (!out.includes('<del>strike</del>')) fails.push('strike');
if (!out.includes('<code>inline code</code>')) fails.push('code');
if (!out.includes('class="math"')) fails.push('math');
if (!out.includes('data-wiki="Other"')) fails.push('wiki');
if (!out.includes('data-task')) fails.push('task');
if (!out.includes('<blockquote>')) fails.push('quote');
if (!out.includes('<table>')) fails.push('table');
if (!out.includes('lang-js')) fails.push('fence');
if (!out.includes('tok-cm')) fails.push('highlight');
if (!out.includes('&lt;script&gt;')) fails.push('escape');
if (!out.includes('<img src="/api/assets/abc123/data"')) fails.push('img');
if (!out.includes('<hr>')) fails.push('hr');
if (!out.includes('<ul><li>nested item')) fails.push('nested');
if (!out.includes('<ol><li>first</li><li>second</li></ol>')) fails.push('ol');
if (fails.length) { console.log('FAILS:', fails.join(', ')); process.exit(1); }
console.log('ALL MARKDOWN TESTS PASSED');
