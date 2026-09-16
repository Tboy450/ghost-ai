import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  PROVIDERS, listProviders, getFocus, setFocus, advanceFocus,
  callProvider, parseProposal, applyProposal, runCycle, listHistory,
  setProviderKey, clearProviderKey, resolveKey, testProvider,
} from '../selfimprove.mjs';

function run(dir, args) { return spawnSync('git', args, {cwd: dir, encoding: 'utf8'}); }

function makeRepoWithTests(passing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-selfimprove-repo-'));
  run(dir, ['init', '-q']);
  run(dir, ['config', 'user.email', 'test@local']);
  run(dir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'studio', 'tests'), {recursive: true});
  const assertion = passing ? 'assert.equal(1, 1)' : 'assert.equal(1, 2)';
  fs.writeFileSync(path.join(dir, 'studio', 'tests', 'sample.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sample', () => { ${assertion}; });\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function makeBareRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-selfimprove-remote-'));
  spawnSync('git', ['init', '-q', '--bare'], {cwd: dir});
  return dir;
}

function startFakeProvider(responder) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => responder(req, res, body));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function proposalReply(summary, files) {
  return JSON.stringify({choices: [{message: {content: '```json\n' + JSON.stringify({summary, files, notes: 'n/a'}) + '\n```'}}]});
}

const dirsFor = ghost => ({ghost});

test('listProviders reports configured state from env vars without leaking keys', () => {
  const before = process.env.GHOST_OPENAI_API_KEY;
  try {
    delete process.env.GHOST_OPENAI_API_KEY;
    assert.equal(listProviders().find(p => p.id === 'openai').configured, false);
    process.env.GHOST_OPENAI_API_KEY = 'sk-test';
    assert.equal(listProviders().find(p => p.id === 'openai').configured, true);
    assert.ok(Object.keys(PROVIDERS).length >= 5);
  } finally {
    if (before === undefined) delete process.env.GHOST_OPENAI_API_KEY; else process.env.GHOST_OPENAI_API_KEY = before;
  }
});

test('a saved key configures a provider, is preferred over nothing, and can be removed', () => {
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-keys-'));
  const before = process.env.GHOST_DEEPSEEK_API_KEY;
  try {
    delete process.env.GHOST_DEEPSEEK_API_KEY;
    const dirs = dirsFor(ghost);
    assert.equal(listProviders(dirs).find(p => p.id === 'deepseek').configured, false);
    setProviderKey(dirs, 'deepseek', 'sk-saved');
    const saved = listProviders(dirs).find(p => p.id === 'deepseek');
    assert.equal(saved.configured, true);
    assert.equal(saved.source, 'saved in this project');
    assert.equal(resolveKey(dirs, 'deepseek'), 'sk-saved');
    // The stored key must never be returned to the browser.
    assert.ok(!JSON.stringify(listProviders(dirs)).includes('sk-saved'));
    // An environment variable outranks the stored key.
    process.env.GHOST_DEEPSEEK_API_KEY = 'sk-env';
    assert.equal(resolveKey(dirs, 'deepseek'), 'sk-env');
    assert.equal(listProviders(dirs).find(p => p.id === 'deepseek').source, 'environment');
    delete process.env.GHOST_DEEPSEEK_API_KEY;
    clearProviderKey(dirs, 'deepseek');
    assert.equal(listProviders(dirs).find(p => p.id === 'deepseek').configured, false);
    assert.throws(() => setProviderKey(dirs, 'nope', 'k'), /Unknown AI provider/);
    assert.throws(() => setProviderKey(dirs, 'deepseek', '  '), /Provide an API key/);
  } finally {
    if (before === undefined) delete process.env.GHOST_DEEPSEEK_API_KEY; else process.env.GHOST_DEEPSEEK_API_KEY = before;
    fs.rmSync(ghost, {recursive: true, force: true});
  }
});

test('testProvider verifies a saved key against the real endpoint shape', async (t) => {
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-provider-'));
  const seen = [];
  const server = await startFakeProvider((req, res, body) => {
    seen.push({auth: req.headers.authorization, body: JSON.parse(body)});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: 'OK'}}]}));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(() => { server.close(); fs.rmSync(ghost, {recursive: true, force: true}); });
  const dirs = dirsFor(ghost);
  await assert.rejects(testProvider('openrouter', {dirs, baseUrl}), /not configured/);
  setProviderKey(dirs, 'openrouter', 'sk-or-test');
  const result = await testProvider('openrouter', {dirs, baseUrl});
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'OK');
  assert.equal(result.model, PROVIDERS.openrouter.defaultModel);
  assert.ok(result.latencyMs >= 0);
  assert.equal(seen[0].auth, 'Bearer sk-or-test');
  assert.equal(seen[0].body.model, PROVIDERS.openrouter.defaultModel);
});

test('testProvider surfaces a provider rejection instead of reporting success', async (t) => {
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-provider-bad-'));
  const server = await startFakeProvider((req, res) => {
    res.writeHead(401, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: {message: 'Invalid API key'}}));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(() => { server.close(); fs.rmSync(ghost, {recursive: true, force: true}); });
  const dirs = dirsFor(ghost);
  setProviderKey(dirs, 'grok', 'sk-wrong');
  await assert.rejects(testProvider('grok', {dirs, baseUrl}), /returned 401/);
});

test('focus persists, updates, and advances through the queue', () => {
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-focus-'));
  try {
    const dirs = dirsFor(ghost);
    const initial = getFocus(dirs);
    assert.ok(initial.focus);
    const set = setFocus(dirs, 'Custom focus', ['task a', 'task b']);
    assert.equal(set.focus, 'Custom focus');
    assert.deepEqual(set.queue, ['task a', 'task b']);
    const advanced = advanceFocus(dirs);
    assert.equal(advanced.focus, 'task a');
    assert.deepEqual(advanced.queue, ['task b']);
    assert.throws(() => setFocus(dirs, ''), /focus task/);
  } finally {
    fs.rmSync(ghost, {recursive: true, force: true});
  }
});

test('parseProposal rejects unsafe paths and applyProposal writes safe files', () => {
  assert.throws(() => parseProposal('```json\n' + JSON.stringify({summary: 's', files: [{path: '../escape.txt', content: 'x'}]}) + '\n```'), /unsafe file path/);
  assert.throws(() => parseProposal('not json at all'), /valid JSON/);
  assert.throws(() => parseProposal('```json\n' + JSON.stringify({summary: 's', files: []}) + '\n```'), /no file changes/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-apply-'));
  try {
    const proposal = parseProposal('```json\n' + JSON.stringify({summary: 's', files: [{path: 'notes/a.txt', content: 'hi'}]}) + '\n```');
    const written = applyProposal(root, proposal);
    assert.deepEqual(written, ['notes/a.txt']);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hi');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('callProvider requires a configured API key', async () => {
  const before = process.env.GHOST_OPENAI_API_KEY;
  delete process.env.GHOST_OPENAI_API_KEY;
  try {
    await assert.rejects(() => callProvider('openai', {systemPrompt: 's', userPrompt: 'u'}), /not configured/);
  } finally {
    if (before === undefined) delete process.env.GHOST_OPENAI_API_KEY; else process.env.GHOST_OPENAI_API_KEY = before;
  }
});

test('runCycle end-to-end: passing tests lead to a commit and push on an isolated branch', async (t) => {
  const repo = makeRepoWithTests(true);
  const remote = makeBareRemote();
  run(repo, ['remote', 'add', 'origin', remote]);
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cycle-ghost-'));
  const server = await startFakeProvider((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(proposalReply('Add a note', [{path: 'NOTES.md', content: 'ghost was here\n'}]));
  });
  t.after(() => server.close());
  try {
    const dirs = dirsFor(ghost);
    const report = await runCycle({
      codeRoot: repo, dirs, providerId: 'openai', apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      testGlob: 'studio/tests/*.test.mjs', branch: 'ghost/self-update',
    });
    assert.equal(report.error, null);
    assert.equal(report.testResult.passed, true);
    assert.equal(report.committed, true);
    assert.equal(report.pushed, true);
    assert.deepEqual(report.applied, ['NOTES.md']);
    assert.match(report.commitHash, /^[0-9a-f]{40}$/);
    // The remote now has the isolated branch, and the caller's checkout was never touched.
    const branches = spawnSync('git', ['ls-remote', '--heads', remote], {encoding: 'utf8'}).stdout;
    assert.match(branches, /refs\/heads\/ghost\/self-update/);
    assert.equal(fs.existsSync(path.join(repo, 'NOTES.md')), false);
    const history = listHistory(dirs);
    assert.equal(history.length, 1);
    assert.equal(history[0].commitHash, report.commitHash);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(remote, {recursive: true, force: true});
    fs.rmSync(ghost, {recursive: true, force: true});
  }
});

test('runCycle discards the change without committing when tests fail', async (t) => {
  const repo = makeRepoWithTests(false);
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cycle-fail-ghost-'));
  const server = await startFakeProvider((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(proposalReply('Attempt fix', [{path: 'NOTES.md', content: 'attempted\n'}]));
  });
  t.after(() => server.close());
  try {
    const dirs = dirsFor(ghost);
    const report = await runCycle({
      codeRoot: repo, dirs, providerId: 'openai', apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      testGlob: 'studio/tests/*.test.mjs', branch: 'ghost/self-update',
    });
    assert.equal(report.testResult.passed, false);
    assert.equal(report.committed, false);
    assert.equal(report.pushed, false);
    assert.match(report.error, /Tests failed/);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(ghost, {recursive: true, force: true});
  }
});

test('runCycle records a clear error when the AI response is malformed, without touching the repo', async (t) => {
  const repo = makeRepoWithTests(true);
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cycle-bad-ghost-'));
  const server = await startFakeProvider((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: 'no json here'}}]}));
  });
  t.after(() => server.close());
  try {
    const dirs = dirsFor(ghost);
    const report = await runCycle({
      codeRoot: repo, dirs, providerId: 'openai', apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      testGlob: 'studio/tests/*.test.mjs', branch: 'ghost/self-update',
    });
    assert.equal(report.committed, false);
    assert.match(report.error, /valid JSON/);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(ghost, {recursive: true, force: true});
  }
});
