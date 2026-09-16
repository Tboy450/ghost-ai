// Ghost's self-improvement orchestrator: lets Ghost consult a public AI provider
// (OpenAI/GPT, xAI/Grok, DeepSeek, GitHub Models/Copilot, or a Llama host such as
// Together.ai for Meta's models) to propose a codebase change toward a focus task,
// then applies, tests, and (only on green tests) commits and pushes that change to
// an isolated `ghost/self-update` branch — never the caller's live working branch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { addWorktree, removeWorktree, resetWorktree, stageIntentToAdd, commit, push, diff } from './git.mjs';

function fail(message, status = 400) { return Object.assign(new Error(message), {status}); }

// Every provider speaks the OpenAI-compatible /chat/completions shape, so one HTTP
// client covers all of them. Each is only "configured" once its API key env var is set;
// Ghost never invents or stores these keys itself.
export const PROVIDERS = {
  openai: {label: 'OpenAI (GPT)', baseUrl: 'https://api.openai.com/v1', envKey: 'GHOST_OPENAI_API_KEY', defaultModel: 'gpt-4o-mini', keysUrl: 'https://platform.openai.com/api-keys'},
  grok: {label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', envKey: 'GHOST_XAI_API_KEY', defaultModel: 'grok-2-latest', keysUrl: 'https://console.x.ai'},
  deepseek: {label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', envKey: 'GHOST_DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', keysUrl: 'https://platform.deepseek.com/api_keys'},
  meta: {label: 'Meta (Llama, via Together)', baseUrl: 'https://api.together.xyz/v1', envKey: 'GHOST_TOGETHER_API_KEY', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keysUrl: 'https://api.together.xyz/settings/api-keys'},
  copilot: {label: 'GitHub Models (Copilot)', baseUrl: 'https://models.github.ai/inference', envKey: 'GHOST_GITHUB_TOKEN', defaultModel: 'openai/gpt-4o-mini', keysUrl: 'https://github.com/settings/tokens'},
  // One OpenRouter key reaches GPT, Grok, DeepSeek, Llama and more through a single
  // endpoint, so it is the quickest way to get several public models working at once.
  openrouter: {label: 'OpenRouter (many models, one key)', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'GHOST_OPENROUTER_API_KEY', defaultModel: 'deepseek/deepseek-chat', keysUrl: 'https://openrouter.ai/keys'},
};

// Keys live in the project's gitignored .ghost/ folder so they are never committed.
// An environment variable, when present, always wins over the stored key.
function keyStorePath(dirs) { return path.join(dirs.ghost, 'providers.json'); }

function readKeyStore(dirs) {
  try { return JSON.parse(fs.readFileSync(keyStorePath(dirs), 'utf8')); } catch { return {}; }
}

export function setProviderKey(dirs, providerId, apiKey) {
  if (!PROVIDERS[providerId]) throw fail(`Unknown AI provider "${providerId}".`);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw fail('Provide an API key to save.');
  const store = readKeyStore(dirs);
  store[providerId] = apiKey.trim();
  fs.mkdirSync(dirs.ghost, {recursive: true});
  fs.writeFileSync(keyStorePath(dirs), JSON.stringify(store, null, 2), {mode: 0o600});
  return {id: providerId, configured: true};
}

export function clearProviderKey(dirs, providerId) {
  if (!PROVIDERS[providerId]) throw fail(`Unknown AI provider "${providerId}".`);
  const store = readKeyStore(dirs);
  delete store[providerId];
  fs.mkdirSync(dirs.ghost, {recursive: true});
  fs.writeFileSync(keyStorePath(dirs), JSON.stringify(store, null, 2), {mode: 0o600});
  return {id: providerId, configured: Boolean(process.env[PROVIDERS[providerId].envKey])};
}

// Resolves the key to use, preferring an explicit one, then the env var, then the store.
export function resolveKey(dirs, providerId, apiKey) {
  const info = PROVIDERS[providerId];
  if (!info) throw fail(`Unknown AI provider "${providerId}".`);
  return (apiKey && apiKey.trim()) || process.env[info.envKey] || (dirs ? readKeyStore(dirs)[providerId] : '') || '';
}

export function listProviders(dirs) {
  const store = dirs ? readKeyStore(dirs) : {};
  return Object.entries(PROVIDERS).map(([id, info]) => {
    const fromEnv = Boolean(process.env[info.envKey]);
    const fromStore = Boolean(store[id]);
    return {
      id, label: info.label, model: info.defaultModel, envKey: info.envKey, keysUrl: info.keysUrl,
      configured: fromEnv || fromStore, source: fromEnv ? 'environment' : fromStore ? 'saved in this project' : 'not set',
    };
  });
}

// Sends the smallest possible real request so a key can be verified without
// running a whole improvement cycle.
export async function testProvider(providerId, {dirs, apiKey, model, fetchImpl, baseUrl, signal} = {}) {
  const info = PROVIDERS[providerId];
  if (!info) throw fail(`Unknown AI provider "${providerId}".`);
  const key = resolveKey(dirs, providerId, apiKey);
  if (!key) throw fail(`${info.label} is not configured. Save an API key for it, or set ${info.envKey}.`, 409);
  const started = Date.now();
  const reply = await callProvider(providerId, {
    apiKey: key, model, fetchImpl, baseUrl, signal,
    systemPrompt: 'You are a connectivity check. Reply with exactly: OK',
    userPrompt: 'Reply with exactly: OK',
  });
  return {ok: true, provider: providerId, label: info.label, model: model || info.defaultModel, latencyMs: Date.now() - started, reply: reply.trim().slice(0, 200)};
}

function focusPath(dirs) { return path.join(dirs.ghost, 'self-improve-focus.json'); }
function historyDir(dirs) { const dir = path.join(dirs.ghost, 'self-improvement'); fs.mkdirSync(dir, {recursive: true}); return dir; }

const DEFAULT_QUEUE = [
  'Add Git integration (view changes, checkpoints, commits, pushes) inside Ghost.',
  'Add assisted coding and testing: propose coordinated multi-file edits and run selected checks with visible results.',
  'Strengthen framework comparisons: real baseline-versus-framework trials measuring correctness, recall, speed, and resource use.',
  'Package Ghost as a desktop application: installer, startup diagnostics, model setup, and updates that preserve user data.',
  'Learn to use a new tool or extension useful to Ghost users, and wire it in with tests.',
];

export function getFocus(dirs) {
  try { return JSON.parse(fs.readFileSync(focusPath(dirs), 'utf8')); }
  catch { return {focus: DEFAULT_QUEUE[0], queue: DEFAULT_QUEUE.slice(1), updatedAt: null}; }
}

export function setFocus(dirs, focus, queue) {
  if (typeof focus !== 'string' || !focus.trim()) throw fail('Provide a focus task to work on.');
  if (queue !== undefined && (!Array.isArray(queue) || queue.some(q => typeof q !== 'string'))) throw fail('Queue must be a list of task strings.');
  const record = {focus: focus.trim().slice(0, 2000), queue: (queue || getFocus(dirs).queue || []).map(q => q.trim().slice(0, 2000)).filter(Boolean), updatedAt: new Date().toISOString()};
  fs.mkdirSync(dirs.ghost, {recursive: true});
  fs.writeFileSync(focusPath(dirs), JSON.stringify(record, null, 2));
  return record;
}

// Advances the queue after a cycle: the just-run focus is dropped, its replacement
// comes off the front of the queue (looping back to defaults once the queue empties).
export function advanceFocus(dirs) {
  const state = getFocus(dirs);
  const [next, ...rest] = state.queue.length ? state.queue : DEFAULT_QUEUE;
  return setFocus(dirs, next, rest);
}

export async function callProvider(providerId, {apiKey, model, systemPrompt, userPrompt, baseUrl, fetchImpl = fetch, signal} = {}) {
  const info = PROVIDERS[providerId];
  if (!info) throw fail(`Unknown AI provider "${providerId}".`);
  const key = apiKey || process.env[info.envKey];
  if (!key) throw fail(`${info.label} is not configured. Save an API key for it, or set the ${info.envKey} environment variable.`, 409);
  const response = await fetchImpl(`${baseUrl || info.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
    body: JSON.stringify({model: model || info.defaultModel, temperature: 0.2, messages: [{role: 'system', content: systemPrompt}, {role: 'user', content: userPrompt}]}),
  });
  if (!response.ok) throw fail(`${info.label} returned ${response.status}: ${(await response.text()).slice(0, 400)}`, 502);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw fail(`${info.label} returned an empty response.`, 502);
  return text;
}

const SYSTEM_PROMPT = `You are one of several public AI models Ghost (a local AI coding studio) consults to improve its own codebase. You are shown the repository's file list and the full current contents of the most relevant files. Respond with ONLY a single fenced \`\`\`json code block containing an object: {"summary": short string, "files": [{"path": "relative/path.ext", "content": "full new file content"}], "notes": short string}. For every file you change you must return its COMPLETE new content, not a patch or a fragment, based on the contents you were shown. Each path must be a relative path inside the project with no ".." segments, and must not touch .git/, .ghost/, .github/workflows/ or node_modules/. The project's test suite must still pass after your change, so keep changes small, safe and self-consistent, and update or add tests when behaviour changes. Do not include explanations outside the JSON block.`;

export function buildRepoSummary(root, limit = 200) {
  const list = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (list.length < limit) list.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  try { walk(root); } catch { /* best effort */ }
  return list;
}

// Paths a self-improvement cycle may never rewrite. Without this an AI could disable
// its own safety rails, rewrite the CI that reviews its work, or clobber the key store.
export const PROTECTED_PATHS = ['.git/', '.ghost/', '.github/workflows/', 'node_modules/'];

export function isProtectedPath(relPath) {
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  return PROTECTED_PATHS.some(p => normalized === p.replace(/\/$/, '') || normalized.startsWith(p));
}

// The AI needs to read code before it can change it. Given only a file list it can
// only guess and will rewrite whole files blind, which is why proposals kept failing
// their tests. This picks the files most related to the focus task and includes their
// real contents, staying inside a byte budget so the prompt cannot grow unbounded.
export function gatherContext(root, focus, {files, budget = 60000, maxFiles = 12} = {}) {
  const candidates = (files || buildRepoSummary(root)).filter(f => !isProtectedPath(f) && /\.(mjs|js|json|md|css|html|py|ps1)$/.test(f));
  const words = String(focus || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const scored = candidates.map(file => {
    const lower = file.toLowerCase();
    let score = words.reduce((total, word) => total + (lower.includes(word) ? 3 : 0), 0);
    if (lower.startsWith('studio/')) score += 2;
    if (lower.includes('/tests/') || lower.includes('test')) score += 1;
    if (lower.endsWith('.md')) score -= 1;
    return {file, score};
  }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const included = [];
  let used = 0;
  for (const {file} of scored) {
    if (included.length >= maxFiles || used >= budget) break;
    let content;
    try { content = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (content.includes('\0')) continue;
    const remaining = budget - used;
    if (content.length > remaining) {
      if (remaining < 2000) continue;
      content = `${content.slice(0, remaining)}\n... (truncated)`;
    }
    used += content.length;
    included.push({path: file, content});
  }
  return included;
}

function renderContext(contextFiles) {
  if (!contextFiles.length) return '';
  return `\n\nCurrent contents of the most relevant files. Base your change on these, and return the COMPLETE new content for any file you modify:\n${
    contextFiles.map(f => `\n--- ${f.path} ---\n${f.content}`).join('\n')}`;
}

// Extracts the first fenced ```json block and validates the expected {summary, files, notes} shape.
export function parseProposal(text) {
  const match = /```json\s*([\s\S]*?)```/.exec(text) || [null, text];
  let proposal;
  try { proposal = JSON.parse(match[1]); } catch { throw fail('The AI response was not valid JSON.', 502); }
  if (!proposal || typeof proposal.summary !== 'string' || !Array.isArray(proposal.files)) throw fail('The AI response was missing summary/files.', 502);
  for (const file of proposal.files) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') throw fail('Each proposed file needs a path and content.', 502);
    if (file.path.includes('..') || path.isAbsolute(file.path) || file.path.includes('\0')) throw fail(`Rejected an unsafe file path: ${file.path}`, 502);
    if (isProtectedPath(file.path)) throw fail(`Rejected a change to a protected path: ${file.path}`, 502);
  }
  if (!proposal.files.length) throw fail('The AI proposed no file changes.', 502);
  if (proposal.files.length > 12) throw fail('The AI proposed too many files at once (limit 12 per cycle).', 502);
  return proposal;
}

export function applyProposal(root, proposal) {
  const written = [];
  for (const file of proposal.files) {
    if (Buffer.byteLength(file.content) > 400000) throw fail(`Proposed file ${file.path} is too large.`, 502);
    const full = path.join(root, file.path);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, file.content, 'utf8');
    written.push(file.path);
  }
  return written;
}

export function runTests(root, testGlob) {
  // Strip Node's own test-runner recursion-guard env vars so a nested `node --test`
  // run (e.g. this cycle's own tests, invoked from inside another `node --test` run)
  // actually executes instead of being silently skipped as a "recursive" run.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')));
  const result = spawnSync(process.execPath, ['--test', testGlob], {cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env});
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {passed: result.status === 0, output: output.slice(-8000)};
}

function saveReport(dirs, report) {
  const file = path.join(historyDir(dirs), `${report.time.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function listHistory(dirs, limit = 50) {
  const dir = historyDir(dirs);
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}

// Runs exactly one self-improvement cycle: propose -> apply -> test -> (commit + push) | (discard).
// `codeRoot` is the repository to improve (its own app source, or any git-backed project).
// The work happens in a disposable worktree/branch so the caller's live checkout is never touched.
export async function runCycle({codeRoot, dirs, providerId, apiKey, model, testGlob = 'studio/tests/*.test.mjs', branch = 'ghost/self-update', autoPush = true, remote = 'origin', fetchImpl, baseUrl, focusOverride, repairAttempts = 1, contextBudget = 60000}) {
  const focusState = focusOverride ? {focus: focusOverride, queue: getFocus(dirs).queue} : getFocus(dirs);
  const time = new Date().toISOString();
  const report = {time, provider: providerId, model: model || PROVIDERS[providerId]?.defaultModel, focus: focusState.focus, applied: [], contextFiles: [], attempts: 0, baselineOk: null, testResult: null, diff: null, committed: false, pushed: false, commitHash: null, branch, error: null, summary: null};
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-selfupdate-'));
  try {
    addWorktree(codeRoot, tmpDir, branch);

    // Check the tests pass BEFORE touching anything. Otherwise an already-red repo
    // gets blamed on the AI, and every cycle fails for a reason it cannot fix.
    const baseline = runTests(tmpDir, testGlob);
    report.baselineOk = baseline.passed;
    if (!baseline.passed) {
      report.error = 'The repository tests were already failing before any change was proposed, so this cycle stopped. Fix the existing failures first.';
      report.testResult = baseline;
      return report;
    }

    const files = buildRepoSummary(tmpDir);
    const contextFiles = gatherContext(tmpDir, focusState.focus, {files, budget: contextBudget});
    report.contextFiles = contextFiles.map(f => f.path);
    const basePrompt = `Focus task: ${focusState.focus}\n\nRepository files (relative paths):\n${files.join('\n')}${renderContext(contextFiles)}\n\nPropose the smallest safe change that makes progress on the focus task.`;

    let userPrompt = basePrompt;
    let lastError = null;
    for (let attempt = 0; attempt <= repairAttempts; attempt++) {
      report.attempts = attempt + 1;
      // Each retry re-applies to a clean worktree so a failed attempt cannot leak into the next.
      if (attempt > 0) resetWorktree(tmpDir);
      const raw = await callProvider(providerId, {apiKey: resolveKey(dirs, providerId, apiKey), model, systemPrompt: SYSTEM_PROMPT, userPrompt, fetchImpl, baseUrl});
      const proposal = parseProposal(raw);
      report.summary = proposal.summary;
      report.applied = applyProposal(tmpDir, proposal);
      report.testResult = runTests(tmpDir, testGlob);
      if (report.testResult.passed) { lastError = null; break; }
      lastError = 'Tests failed after applying the proposal; change was discarded.';
      // Give the AI its own failure output so it can correct the change instead of
      // the cycle silently throwing the work away.
      userPrompt = `${basePrompt}\n\nYour previous attempt was: ${proposal.summary}\nIt changed: ${report.applied.join(', ')}\nThe test suite then FAILED with this output:\n${report.testResult.output.slice(-4000)}\n\nFix the problem and return a corrected complete proposal in the same JSON format.`;
    }
    if (lastError) { report.error = lastError; return report; }

    stageIntentToAdd(tmpDir);
    report.diff = diff(tmpDir).slice(0, 20000);
    const committed = commit(tmpDir, `Self-improvement: ${proposalMessage(report.summary)}`, {authorName: 'Ghost Self-Improvement', authorEmail: 'ghost-self-improve@local'});
    report.committed = true; report.commitHash = committed.hash;
    if (autoPush) { push(tmpDir, {remote, branch}); report.pushed = true; }
    advanceFocus(dirs);
    return report;
  } catch (error) {
    report.error = error.message;
    return report;
  } finally {
    try { removeWorktree(codeRoot, tmpDir); } catch { /* best effort cleanup */ }
    fs.rmSync(tmpDir, {recursive: true, force: true});
    saveReport(dirs, report);
  }
}

function proposalMessage(summary) { return String(summary || 'update').slice(0, 300); }
