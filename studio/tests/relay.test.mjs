import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitIntoSegments, extractSegment, planSegments, scopeFiles, startRelay, submitGuidance, implementSegments, assembleFiles, applyRelay, relayState, clearRelay, readRelay, renderBriefPrompt, BROWSER_CHATS } from '../relay.mjs';

function tempProject() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-relay-test-'));
  const dirs = {ghost: path.join(root, '.ghost')};
  fs.mkdirSync(dirs.ghost, {recursive: true});
  return {root, dirs, cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
}

function gitProject() {
  const {root, dirs, cleanup} = tempProject();
  const git = (...args) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@local'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'studio', 'tests'), {recursive: true});
  fs.writeFileSync(path.join(root, 'studio', 'widget.mjs'), 'export const size = 1;\n');
  fs.writeFileSync(path.join(root, 'studio', 'tests', 'widget.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { size } from '../widget.mjs';\ntest('size is positive', () => { assert.ok(size > 0); });\n");
  git('add', '-A'); git('commit', '-m', 'initial');
  return {root, dirs, cleanup};
}

test('the plan\'s FILES list decides what may be rewritten', () => {
  const found = [{path: 'studio/widget.mjs'}, {path: 'studio/tests/widget.test.mjs'}, {path: 'studio/other.mjs'}];
  // The scope named in the plan wins, so a test file the search happened to rank is
  // left alone unless the plan actually asked for it.
  assert.deepEqual(scopeFiles(found, 'FILES: studio/widget.mjs\nPLAN:\n- do a thing').map(f => f.path), ['studio/widget.mjs']);
  assert.deepEqual(scopeFiles(found, 'FILES: widget.mjs, other.mjs').map(f => f.path), ['studio/widget.mjs', 'studio/other.mjs']);
  // A paste with no usable scope must not leave the relay with nothing to do.
  assert.equal(scopeFiles(found, 'PLAN:\n- no files line here').length, 3);
  assert.equal(scopeFiles(found, 'FILES: nothing/that/exists.mjs').length, 3);
});

test('a named file is loaded even when relevance ranking would not reach it', () => {
  const {root, cleanup} = gitProject();
  try {
    // Fill the shortlist with files that all out-rank the target for this focus, so the
    // only way the named file gets in is by being resolved against the whole repo first.
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, 'studio', `toast${i}.mjs`), `export const toast${i} = ${i};\n`);
    fs.writeFileSync(path.join(root, 'studio', 'quiet.mjs'), 'export const quiet = true;\n');
    const ranked = planSegments(root, 'toast', {maxFiles: 6, guidance: 'PLAN:\n- do a thing'});
    assert.ok(!ranked.some(s => s.path === 'studio/quiet.mjs'), 'the unrelated file should not rank on its own');
    const scoped = planSegments(root, 'toast', {maxFiles: 6, guidance: 'FILES: studio/quiet.mjs\nPLAN:\n- do a thing'});
    assert.deepEqual([...new Set(scoped.map(s => s.path))], ['studio/quiet.mjs'],
      'naming a file in the plan must load exactly that file, not fall back to the ranked list');
  } finally { cleanup(); }
});

test('the reported scope is what the plan chose, not the candidate list', () => {
  const {root, dirs, cleanup} = gitProject();
  try {
    startRelay(dirs, {codeRoot: root, chat: 'grok', focus: 'widget'});
    const state = submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/widget.mjs\nPLAN:\n- adjust the size constant'});
    assert.deepEqual(state.files, ['studio/widget.mjs'],
      'the scope shown to the person must match the segments actually queued');
  } finally { cleanup(); }
});

test('a file is split on line boundaries, never mid-line', () => {
  const content = Array.from({length: 40}, (_, i) => `const line${i} = ${i};`).join('\n');
  const segments = splitIntoSegments(content, 200);
  assert.ok(segments.length > 1, 'a long file should become several segments');
  assert.equal(segments.join('\n'), content, 'rejoining the segments must reproduce the file exactly');
  for (const segment of segments) for (const line of segment.split('\n')) {
    assert.ok(!line.length || /^const line\d+ = \d+;$/.test(line), `a line was cut in half: ${line}`);
  }
});

test('a short file stays one segment and an empty file still produces one', () => {
  assert.equal(splitIntoSegments('a = 1;', 2400).length, 1);
  assert.deepEqual(splitIntoSegments('', 2400), ['']);
});

// The stuck-detector is the heart of this feature: these are the shapes a small local
// model produces when it has lost the thread, and each one would corrupt a file.
test('a summarised reply that dropped most of the code is rejected', () => {
  const original = Array.from({length: 30}, (_, i) => `const keep${i} = ${i};`).join('\n');
  const result = extractSegment('```\n// ...rest of the code unchanged\n```', original);
  assert.equal(result.ok, false);
  assert.match(result.reason, /dropped most/);
});

test('a reply that loops on one line is rejected', () => {
  const original = Array.from({length: 20}, (_, i) => `const x${i} = ${i};`).join('\n');
  const looped = Array.from({length: 20}, () => 'const x = 1;').join('\n');
  const result = extractSegment('```\n' + looped + '\n```', original);
  assert.equal(result.ok, false);
  assert.match(result.reason, /repeated the same line/);
});

test('an explanation with no code block is rejected rather than written to the file', () => {
  const result = extractSegment('Sure! I would update the file to add the new option and then adjust the tests.', 'const a = 1;');
  assert.equal(result.ok, false);
  assert.match(result.reason, /no code block/);
});

test('an empty reply and an empty code block are both rejected', () => {
  assert.equal(extractSegment('', 'const a = 1;').ok, false);
  assert.equal(extractSegment('```\n\n```', 'const a = 1;').ok, false);
});

test('KEEP and an unchanged rewrite both mean no change', () => {
  assert.deepEqual(extractSegment('KEEP', 'const a = 1;'), {ok: true, keep: true});
  assert.deepEqual(extractSegment('```\nconst a = 1;\n```', 'const a = 1;'), {ok: true, keep: true});
});

test('a genuine rewrite is accepted', () => {
  const result = extractSegment('```js\nconst a = 2;\n```', 'const a = 1;');
  assert.equal(result.ok, true);
  assert.equal(result.keep, false);
  assert.equal(result.content, 'const a = 2;');
});

test('the brief asks the public chat for a plan, not for code', () => {
  const brief = renderBriefPrompt('Add a status line', ['studio/server.mjs']);
  assert.match(brief, /no code/);
  assert.match(brief, /Add a status line/);
  assert.match(brief, /studio\/server\.mjs/);
  assert.ok(BROWSER_CHATS.length >= 6);
  assert.ok(BROWSER_CHATS.every(c => c.url.startsWith('https://')));
});

test('a relay opens with a brief to paste and refuses an unknown chat', () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    fs.mkdirSync(path.join(root, 'studio'), {recursive: true});
    fs.writeFileSync(path.join(root, 'studio', 'thing.mjs'), 'export const a = 1;\n');
    assert.throws(() => startRelay(dirs, {codeRoot: root, chat: 'nope', focus: 'x'}), /supported public chats/);
    const state = startRelay(dirs, {codeRoot: root, chat: 'chatgpt', focus: 'Improve the thing module'});
    assert.equal(state.open, true);
    assert.equal(state.url, 'https://chatgpt.com/');
    assert.match(state.brief, /Improve the thing module/);
    assert.equal(state.guidance, null);
    assert.equal(clearRelay(dirs).open, false);
  } finally { cleanup(); }
});

test('pasted guidance is cleaned up and turned into small segments', () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    fs.mkdirSync(path.join(root, 'studio'), {recursive: true});
    fs.writeFileSync(path.join(root, 'studio', 'thing.mjs'), Array.from({length: 200}, (_, i) => `export const v${i} = ${i};`).join('\n'));
    startRelay(dirs, {codeRoot: root, chat: 'grok', focus: 'Improve the thing module'});
    assert.throws(() => submitGuidance(dirs, {codeRoot: root, guidance: 'ok'}), /Paste the plan/);
    const state = submitGuidance(dirs, {codeRoot: root, guidance: '```\nFILES: studio/thing.mjs\nPLAN:\n- rename v0 in studio/thing.mjs\n```'});
    assert.ok(!state.guidance.includes('```'), 'code fences are stripped from a pasted plan');
    assert.ok(state.total > 1, 'a long file becomes several segments');
    assert.ok(state.segments.every(s => s.state === 'pending'));
  } finally { cleanup(); }
});

test('a model that stalls or rambles never blocks the run', async () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    fs.mkdirSync(path.join(root, 'studio'), {recursive: true});
    const lines = Array.from({length: 300}, (_, i) => `export const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'studio', 'thing.mjs'), lines);
    startRelay(dirs, {codeRoot: root, chat: 'deepseek', focus: 'Improve the thing module'});
    submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/thing.mjs\nPLAN:\n- bump every value in studio/thing.mjs'});

    // A model that times out on one segment, rambles on another, and works on the rest.
    let call = 0;
    const complete = async (endpoint, model, messages) => {
      call++;
      if (call <= 2) throw Object.assign(new Error('too slow'), {timeout: true});
      if (call <= 4) return 'I think the best approach here would be to consider the structure.';
      const piece = /```\n([\s\S]*?)\n```/.exec(messages[1].content)[1];
      return '```\n' + piece.replace(/= (\d+);/g, (_, n) => `= ${Number(n) + 1};`) + '\n```';
    };
    const state = await implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete});

    assert.equal(state.counts.pending || 0, 0, 'every segment must be resolved, never left hanging');
    assert.equal(state.counts.skipped, 2, 'the timed-out and the rambling segment are skipped, one each after two attempts');
    assert.ok(state.counts.done >= 1, 'the rest of the run still completed');
    const skipped = state.segments.filter(s => s.state === 'skipped');
    assert.match(skipped[0].note, /time limit/);
    assert.match(skipped[1].note, /no code block/);
  } finally { cleanup(); }
});

test('a skipped segment keeps its original text so the file is never truncated', async () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    fs.mkdirSync(path.join(root, 'studio'), {recursive: true});
    const original = Array.from({length: 300}, (_, i) => `export const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'studio', 'thing.mjs'), original);
    startRelay(dirs, {codeRoot: root, chat: 'gemini', focus: 'Improve the thing module'});
    submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/thing.mjs\nPLAN:\n- bump the first value only'});

    let first = true;
    const complete = async (endpoint, model, messages) => {
      const piece = /```\n([\s\S]*?)\n```/.exec(messages[1].content)[1];
      if (first) { first = false; return '```\n' + piece.replace('v0 = 0;', 'v0 = 99;') + '\n```'; }
      throw Object.assign(new Error('too slow'), {timeout: true});
    };
    await implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete});

    const [file] = assembleFiles(readRelay(dirs));
    assert.equal(file.path, 'studio/thing.mjs');
    assert.equal(file.content.split('\n').length, original.split('\n').length, 'no line may be lost');
    assert.ok(file.content.includes('v0 = 99;'), 'the one successful rewrite is kept');
    assert.ok(file.content.includes('v299 = 299;'), 'the skipped remainder keeps its original text');
  } finally { cleanup(); }
});

test('a rewrite that breaks the tests is never committed', async () => {
  const {root, dirs, cleanup} = gitProject();
  try {
    startRelay(dirs, {codeRoot: root, chat: 'chatgpt', focus: 'Change the widget size'});
    submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/widget.mjs\nPLAN:\n- change size in studio/widget.mjs'});
    const complete = async () => '```\nexport const size = -5;\n```';
    await implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete});
    const result = applyRelay(dirs, {codeRoot: root, testGlob: 'studio/tests/*.test.mjs'});
    assert.equal(result.committed, false);
    assert.equal(result.testResult.passed, false);
    assert.match(result.error, /did not pass the test suite/);
    assert.equal(fs.readFileSync(path.join(root, 'studio', 'widget.mjs'), 'utf8'), 'export const size = 1;\n', 'the real checkout is untouched');
  } finally { cleanup(); }
});

test('a rewrite that passes the tests is committed to the isolated branch', async () => {
  const {root, dirs, cleanup} = gitProject();
  try {
    startRelay(dirs, {codeRoot: root, chat: 'chatgpt', focus: 'Change the widget size'});
    submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/widget.mjs\nPLAN:\n- change size in studio/widget.mjs'});
    const complete = async () => '```\nexport const size = 7;\n```';
    await implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete});
    const result = applyRelay(dirs, {codeRoot: root, testGlob: 'studio/tests/*.test.mjs'});
    assert.equal(result.error, null);
    assert.equal(result.committed, true);
    assert.equal(result.testResult.passed, true);
    assert.deepEqual(result.applied, ['studio/widget.mjs']);
    assert.match(result.diff, /size = 7/);
    const branchLog = spawnSync('git', ['log', '--oneline', 'ghost/self-update'], {cwd: root, encoding: 'utf8'}).stdout;
    assert.match(branchLog, /browser relay/);
    assert.equal(fs.readFileSync(path.join(root, 'studio', 'widget.mjs'), 'utf8'), 'export const size = 1;\n', 'the live branch is not touched');
  } finally { cleanup(); }
});

test('applying with nothing rewritten is refused instead of committing an empty change', async () => {
  const {root, dirs, cleanup} = gitProject();
  try {
    startRelay(dirs, {codeRoot: root, chat: 'chatgpt', focus: 'Change the widget size'});
    submitGuidance(dirs, {codeRoot: root, guidance: 'FILES: studio/widget.mjs\nPLAN:\n- leave it alone'});
    await implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete: async () => 'KEEP'});
    assert.throws(() => applyRelay(dirs, {codeRoot: root, testGlob: 'studio/tests/*.test.mjs'}), /nothing to apply/);
  } finally { cleanup(); }
});

test('a protected path can never be rewritten through a relay', async () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    const run = {id: 'x', chat: 'chatgpt', focus: 'f', codeRoot: root, guidance: 'g', files: [], result: null,
      segments: [{path: '.ghost/providers.json', part: 1, parts: 1, content: '{}', state: 'done', content_new: '{"stolen":true}', note: null}]};
    fs.writeFileSync(path.join(dirs.ghost, 'relay.json'), JSON.stringify(run));
    assert.deepEqual(assembleFiles(readRelay(dirs)), [], 'the key store is filtered out before anything is applied');
  } finally { cleanup(); }
});

test('relay work cannot start before a plan has been pasted', async () => {
  const {root, dirs, cleanup} = tempProject();
  try {
    fs.mkdirSync(path.join(root, 'studio'), {recursive: true});
    fs.writeFileSync(path.join(root, 'studio', 'thing.mjs'), 'export const a = 1;\n');
    assert.equal(relayState(dirs).open, false);
    startRelay(dirs, {codeRoot: root, chat: 'chatgpt', focus: 'Improve the thing module'});
    await assert.rejects(implementSegments(dirs, {endpoint: 'http://unused', model: 'test-local', complete: async () => 'KEEP'}), /Paste the plan/);
  } finally { cleanup(); }
});
