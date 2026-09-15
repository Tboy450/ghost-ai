import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, contextualize } from '../public/diff.js';
import { highlightToHTML } from '../public/highlight.js';

test('diffLines finds no changes for identical text', () => {
  const ops = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(ops.every(op => op.type === 'equal'), true);
});

test('diffLines marks additions and removals', () => {
  const ops = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(ops.map(op => op.type), ['equal', 'remove', 'add', 'equal']);
  assert.equal(ops.find(op => op.type === 'remove').line, 'b');
  assert.equal(ops.find(op => op.type === 'add').line, 'x');
});

test('diffLines handles pure insertion', () => {
  const ops = diffLines('a\nb', 'a\nnew\nb');
  assert.deepEqual(ops.map(op => op.type), ['equal', 'add', 'equal']);
});

test('contextualize collapses long unchanged runs and keeps changes', () => {
  const oldText = Array.from({length: 20}, (_, i) => `line${i}`).join('\n');
  const newText = oldText.replace('line10', 'CHANGED');
  const ops = contextualize(diffLines(oldText, newText), 2);
  assert.equal(ops.some(op => op.type === 'gap'), true);
  assert.equal(ops.some(op => op.type === 'remove' && op.line === 'line10'), true);
  assert.equal(ops.some(op => op.type === 'add' && op.line === 'CHANGED'), true);
});

test('contextualize leaves short diffs untouched', () => {
  const ops = contextualize(diffLines('a\nb\nc', 'a\nx\nc'), 3);
  assert.equal(ops.some(op => op.type === 'gap'), false);
});

test('highlightToHTML tags comments, strings, numbers, and keywords for js', () => {
  const html = highlightToHTML('const x = 1; // hi\nconst s = "text";', 'js');
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-number">1<\/span>/);
  assert.match(html, /<span class="tok-comment">\/\/ hi<\/span>/);
  assert.match(html, /<span class="tok-string">"text"<\/span>/);
});

test('highlightToHTML escapes HTML-sensitive characters', () => {
  const html = highlightToHTML('if (a < b) {}', 'js');
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;/);
});

test('highlightToHTML falls back to escaped plain text for unknown languages', () => {
  const html = highlightToHTML('<tag>&value</tag>', 'csv');
  assert.equal(html, '&lt;tag&gt;&amp;value&lt;/tag&gt;');
});

test('highlightToHTML tokenizes python keywords and comments', () => {
  const html = highlightToHTML('def foo():\n    # note\n    return 1', 'py');
  assert.match(html, /<span class="tok-keyword">def<\/span>/);
  assert.match(html, /<span class="tok-comment"># note<\/span>/);
  assert.match(html, /<span class="tok-keyword">return<\/span>/);
});
