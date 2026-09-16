// Ghost's browser relay: borrow a public AI's thinking through its ordinary chat
// window, then let Ghost's own local model do the work.
//
// Why this shape. The API path in selfimprove.mjs needs a billed key. Most people
// already have free access to the same models — they are signed into chatgpt.com,
// grok.com or gemini.google.com in a tab. So the browser chat is used for the one
// thing it is good at through a paste box: giving direction. It is asked for a short
// plan, not for code. Ghost's local model then implements that plan against the real
// files, one small segment at a time. The human pastes twice, not thirty times.
//
// Why segments. A local 4B model is not going to rewrite a large module correctly in
// one shot, and asking it to will produce truncated files and invented code. Work is
// therefore cut into SEGMENTS: one bounded piece of one file, with the plan restated
// every time. Small pieces are what a small model is reliably good at.
//
// Why the procedure matters more than the speed. A local model's real failure mode is
// not slowness, it is getting stuck — looping on a phrase, re-explaining instead of
// answering, or grinding on one hard file forever. Every rule below exists to stop
// that from stalling the run:
//   - each segment gets a hard deadline and is abandoned when it expires;
//   - each segment gets one attempt and at most one retry, never an open loop;
//   - a segment that fails is SKIPPED and recorded, never retried into a corner;
//   - output is checked for the known stuck-shapes (empty, no code block, collapsed
//     to a fraction of the original, or the model repeating one line) and rejected;
//   - an unanswered segment falls back to its original text, so the file still
//     assembles correctly and partial progress is still usable;
//   - nothing reaches the repository until the whole result passes the test suite.
// The run always terminates, and the worst case is "no change", never a hang or a
// corrupted file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { addWorktree, removeWorktree, stageIntentToAdd, commit, push, diff } from './git.mjs';
import { gatherContext, applyProposal, isProtectedPath, runTests, getFocus, advanceFocus, buildRepoSummary } from './selfimprove.mjs';
import { modelComplete } from './core.mjs';

function fail(message, status = 400) { return Object.assign(new Error(message), {status}); }

// Public chats that take a pasted prompt and give back a pasted answer. These are
// URLs, not integrations: Ghost never drives a browser or touches an account, so
// nothing here breaks when a site changes and no credential is ever involved.
export const BROWSER_CHATS = [
  {id: 'chatgpt', label: 'ChatGPT (OpenAI)', url: 'https://chatgpt.com/'},
  {id: 'grok', label: 'Grok (xAI)', url: 'https://grok.com/'},
  {id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/'},
  {id: 'gemini', label: 'Gemini (Google)', url: 'https://gemini.google.com/app'},
  {id: 'claude', label: 'Claude (Anthropic)', url: 'https://claude.ai/new'},
  {id: 'copilot', label: 'Copilot (Microsoft)', url: 'https://copilot.microsoft.com/'},
  {id: 'meta', label: 'Meta AI (Llama)', url: 'https://www.meta.ai/'},
  {id: 'lmarena', label: 'LMArena (many models, no sign-in)', url: 'https://lmarena.ai/'},
];
const CHAT_IDS = new Set(BROWSER_CHATS.map(c => c.id));

// One segment of one file. Small enough that a local 4B model can hold all of it,
// the plan, and its own answer in context at once without truncating.
export const SEGMENT_BUDGET = 2400;
export const SEGMENT_TIMEOUT_MS = 120000;
export const MAX_SEGMENTS = 40;

function relayPath(dirs) { return path.join(dirs.ghost, 'relay.json'); }
export function readRelay(dirs) { try { return JSON.parse(fs.readFileSync(relayPath(dirs), 'utf8')); } catch { return null; } }
function writeRelay(dirs, run) { fs.mkdirSync(dirs.ghost, {recursive: true}); fs.writeFileSync(relayPath(dirs), JSON.stringify(run, null, 2)); return run; }
export function clearRelay(dirs) { try { fs.rmSync(relayPath(dirs), {force: true}); } catch { /* already gone */ } return {open: false, chats: BROWSER_CHATS}; }

// Splits a file into paste-sized pieces on line boundaries. Cutting mid-line would
// hand the model a broken statement and guarantee a broken answer.
export function splitIntoSegments(content, budget = SEGMENT_BUDGET) {
  const lines = content.split('\n');
  const segments = [];
  let current = [], size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > budget && current.length) { segments.push(current.join('\n')); current = []; size = 0; }
    current.push(line); size += line.length + 1;
  }
  if (current.length) segments.push(current.join('\n'));
  return segments.length ? segments : [''];
}

// Reads the FILES: line out of the pasted plan. The public chat was asked to name the
// files it means, and that scope is honoured: without it Ghost would hand the local
// model every file the context search happened to rank, including test files it was
// never asked to touch, and a rewrite of a test is how a red suite gets made green
// dishonestly. Unparseable or unmatched names fall back to the search result, since a
// person's paste should never leave the relay with nothing to do.
export function wantedFiles(guidance) {
  const line = /^\s*FILES\s*:\s*(.+)$/im.exec(guidance || '');
  if (!line) return [];
  return line[1].split(/[,\s]+/).map(s => s.trim().replace(/^['"`]|['"`.]$/g, '')).filter(Boolean);
}

const matchesName = (filePath, name) => filePath === name || filePath.endsWith(`/${name}`) || name.endsWith(`/${filePath}`);

export function scopeFiles(files, guidance) {
  const wanted = wantedFiles(guidance);
  if (!wanted.length) return files;
  const picked = files.filter(f => wanted.some(w => matchesName(f.path, w)));
  return picked.length ? picked : files;
}

export function planSegments(root, focus, {budget = SEGMENT_BUDGET, maxFiles = 6, maxSegments = MAX_SEGMENTS, guidance = null} = {}) {
  // A file the plan names has to be loaded even when relevance ranking would not have
  // reached it. Scoping only the ranked shortlist dropped the named file and then fell
  // back to every other file instead, so the plan said "edit app.js" and the relay
  // queued up the test suite.
  const wanted = wantedFiles(guidance);
  const named = wanted.length ? buildRepoSummary(root).filter(f => wanted.some(w => matchesName(f, w))) : [];
  const options = named.length
    ? {budget: 40000, maxFiles: Math.max(maxFiles, named.length), files: named}
    : {budget: 40000, maxFiles};
  const files = scopeFiles(gatherContext(root, focus, options), guidance);
  const segments = [];
  for (const file of files) {
    const pieces = splitIntoSegments(file.content, budget);
    pieces.forEach((content, index) => segments.push({path: file.path, part: index + 1, parts: pieces.length, content}));
  }
  return segments.slice(0, maxSegments);
}

// The one prompt a person pastes into the public chat. It asks for a plan in plain
// words, deliberately not for code: the public model is being used for judgement,
// and a short plan survives a browser chat's limits where a large diff does not.
export function renderBriefPrompt(focus, files) {
  return [
    'You are advising Ghost, a local AI coding studio written in dependency-free Node.js ESM (backend) and vanilla JS (frontend).',
    '',
    `Goal: ${focus}`,
    '',
    'Project files:',
    ...files.slice(0, 120).map(f => `  ${f}`),
    '',
    'Reply with a short implementation plan in plain language — no code. Use this shape:',
    '',
    'FILES: comma-separated list of the files that must change',
    'PLAN:',
    '- one concrete instruction per line, each naming the file it applies to',
    '',
    'Keep it under 30 lines. Assume a small local model will carry it out one small piece of a file at a time, so every instruction must be unambiguous on its own.',
  ].join('\n');
}

export function startRelay(dirs, {codeRoot, chat, focus} = {}) {
  if (!CHAT_IDS.has(chat)) throw fail('Choose one of the supported public chats.');
  const task = (focus && focus.trim()) || getFocus(dirs).focus;
  if (!task) throw fail('Set a focus task before starting a relay.');
  const files = gatherContext(codeRoot, task, {budget: 40000, maxFiles: 6}).map(f => f.path);
  if (!files.length) throw fail('Found no project files to work on for that focus task.');
  return relayState(dirs, writeRelay(dirs, {
    id: randomUUID(), chat, focus: task, codeRoot,
    startedAt: new Date().toISOString(),
    brief: renderBriefPrompt(task, files),
    guidance: null, files, segments: [], result: null,
  }));
}

// Accepts the public chat's plan. Anything readable is accepted: a person pasting out
// of a browser will bring along stray formatting, and rejecting that would make the
// feature useless. Only the code fences are stripped, since the plan is meant to be prose.
export function submitGuidance(dirs, {codeRoot, guidance} = {}) {
  const run = readRelay(dirs);
  if (!run) throw fail('No relay is open. Start one first.', 409);
  const text = String(guidance || '').replace(/```[a-z]*\n?/gi, '').trim();
  if (text.length < 20) throw fail('Paste the plan the public chat gave you.');
  run.guidance = text.slice(0, 8000);
  run.segments = planSegments(codeRoot || run.codeRoot, run.focus, {guidance: run.guidance}).map(s => ({...s, state: 'pending', note: null, content_new: null}));
  if (!run.segments.length) throw fail('That plan did not match any project files.');
  return relayState(dirs, writeRelay(dirs, run));
}

const SEGMENT_SYSTEM = 'You rewrite one small piece of one source file. You output only the rewritten piece, inside a single fenced code block, with no explanation before or after it. You never summarise, never describe what you would do, and never output a diff. If the piece needs no change, you output exactly: KEEP';

function renderSegmentPrompt(run, segment) {
  return [
    `Goal: ${run.focus}`,
    '',
    'Plan from the reviewing AI:',
    run.guidance,
    '',
    `This is piece ${segment.part} of ${segment.parts} of the file ${segment.path}.`,
    'Rewrite ONLY this piece, applying any part of the plan that affects it. Keep everything else byte-for-byte identical, including indentation. Do not add or remove surrounding code that is not shown.',
    '',
    '```',
    segment.content,
    '```',
    '',
    'Output the rewritten piece in one fenced code block, or exactly KEEP if it should not change.',
  ].join('\n');
}

// The stuck-detector. A local model that has lost the thread produces a recognisable
// shape, and accepting any of these would corrupt the file, so each is a rejection
// and the segment keeps its original text instead.
export function extractSegment(reply, original) {
  const text = String(reply || '').trim();
  if (!text) return {ok: false, reason: 'empty reply'};
  if (/^keep\b/i.test(text)) return {ok: true, keep: true};
  const fence = /```[a-z]*\n([\s\S]*?)```/.exec(text);
  if (!fence) return {ok: false, reason: 'no code block in the reply'};
  const body = fence[1].replace(/\s+$/, '');
  if (!body.trim()) return {ok: false, reason: 'empty code block'};
  // A piece that collapsed to a fraction of its original has been summarised, not
  // rewritten — the classic small-model failure on a long span.
  if (body.length < original.length * 0.4 && original.length > 200) return {ok: false, reason: 'the reply dropped most of the code'};
  if (body.length > original.length * 3 + 500) return {ok: false, reason: 'the reply ballooned well past the original'};
  // Looping on one line is the other classic: the model repeats itself until the
  // output limit rather than finishing.
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 8) {
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
    const worst = Math.max(...counts.values());
    if (worst > Math.max(4, lines.length * 0.5)) return {ok: false, reason: 'the reply repeated the same line over and over'};
  }
  if (body === original) return {ok: true, keep: true};
  return {ok: true, keep: false, content: body};
}

// Walks the segments with Ghost's local model. Bounded everywhere: one retry per
// segment, a deadline per attempt, and a skip on failure — so the walk always ends.
export async function implementSegments(dirs, {endpoint, model, onProgress, timeoutMs = SEGMENT_TIMEOUT_MS, complete = modelComplete, signal} = {}) {
  const run = readRelay(dirs);
  if (!run) throw fail('No relay is open.', 409);
  if (!run.guidance) throw fail('Paste the plan from the public chat first.', 409);
  if (!model) throw fail('Choose a local model first.', 409);

  for (const segment of run.segments) {
    if (signal?.aborted) break;
    if (segment.state === 'done' || segment.state === 'kept') continue;
    let failure = 'not attempted';
    // One attempt, then one retry with a blunter instruction. Never more: a third
    // try on a model that has already lost the thread twice only wastes minutes.
    for (let attempt = 0; attempt < 2; attempt++) {
      let reply;
      try {
        const prompt = renderSegmentPrompt(run, segment) + (attempt ? '\n\nYour previous reply was rejected: it must be the rewritten code only, inside one fenced code block, of roughly the same length as the piece above.' : '');
        reply = await complete(endpoint, model, [{role: 'system', content: SEGMENT_SYSTEM}, {role: 'user', content: prompt}], {timeoutMs, signal});
      } catch (error) {
        failure = error.timeout ? 'the model ran past its time limit' : error.message;
        continue;
      }
      const parsed = extractSegment(reply, segment.content);
      if (!parsed.ok) { failure = parsed.reason; continue; }
      if (parsed.keep) { segment.state = 'kept'; segment.note = 'No change needed.'; }
      else { segment.state = 'done'; segment.note = null; segment.content_new = parsed.content; }
      failure = null;
      break;
    }
    // Skipping is a real outcome, not an error. The original text is kept, the run
    // continues, and the person can see exactly which pieces the model could not do.
    if (failure) { segment.state = 'skipped'; segment.note = failure; }
    writeRelay(dirs, run);
    onProgress?.(relayState(dirs, run));
  }
  return relayState(dirs, writeRelay(dirs, run));
}

// Rebuilds whole files from their pieces. A skipped or pending piece contributes its
// ORIGINAL text, which is what makes a partial run safe: the file is always complete.
export function assembleFiles(run) {
  const byPath = new Map();
  for (const segment of run.segments) {
    if (!byPath.has(segment.path)) byPath.set(segment.path, {path: segment.path, parts: [], changed: false});
    const entry = byPath.get(segment.path);
    entry.parts[segment.part - 1] = segment.state === 'done' && segment.content_new !== null ? segment.content_new : segment.content;
    if (segment.state === 'done') entry.changed = true;
  }
  return [...byPath.values()].filter(e => e.changed && !isProtectedPath(e.path)).map(e => ({path: e.path, content: e.parts.join('\n')}));
}

export function relayState(dirs, loaded) {
  const run = loaded || readRelay(dirs);
  if (!run) return {open: false, chats: BROWSER_CHATS};
  const counts = {done: 0, kept: 0, skipped: 0, pending: 0};
  for (const s of run.segments) counts[s.state] = (counts[s.state] || 0) + 1;
  return {
    open: true, id: run.id, chat: run.chat, focus: run.focus, chats: BROWSER_CHATS,
    url: BROWSER_CHATS.find(c => c.id === run.chat)?.url || null,
    // Before a plan arrives this is the candidate list the brief showed. Afterwards the
    // honest answer is what the plan actually scoped, which can be a file the candidate
    // list never contained.
    brief: run.brief, guidance: run.guidance,
    files: run.segments.length ? [...new Set(run.segments.map(s => s.path))] : run.files,
    total: run.segments.length, counts,
    segments: run.segments.map((s, index) => ({index, path: s.path, part: s.part, parts: s.parts, state: s.state, note: s.note})),
    changedFiles: assembleFiles(run).map(f => f.path),
    result: run.result,
  };
}

// Applies the assembled files the same way an API cycle does: in a disposable
// worktree, tests first, committed only on green. Nothing that came out of a browser
// or a small local model is trusted enough to touch the real checkout untested.
export function applyRelay(dirs, {codeRoot, testGlob = 'studio/tests/*.test.mjs', branch = 'ghost/self-update', autoPush = false, remote = 'origin'} = {}) {
  const run = readRelay(dirs);
  if (!run) throw fail('No relay is open.', 409);
  const files = assembleFiles(run);
  if (!files.length) throw fail('Nothing has been rewritten yet, so there is nothing to apply.', 409);
  const root = codeRoot || run.codeRoot;
  const result = {time: new Date().toISOString(), source: 'browser-relay', chat: run.chat, focus: run.focus, summary: run.guidance.split('\n')[0].slice(0, 200), applied: files.map(f => f.path), skipped: run.segments.filter(s => s.state === 'skipped').length, testResult: null, diff: null, committed: false, pushed: false, commitHash: null, branch, error: null};
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-relay-'));
  try {
    addWorktree(root, tmpDir, branch);
    applyProposal(tmpDir, {files});
    result.testResult = runTests(tmpDir, testGlob);
    if (!result.testResult.passed) {
      result.error = 'The rewritten files did not pass the test suite, so nothing was committed. Nothing in your project changed.';
      return finish(dirs, run, result);
    }
    stageIntentToAdd(tmpDir);
    result.diff = diff(tmpDir).slice(0, 20000);
    const committed = commit(tmpDir, `Self-improvement (browser relay): ${result.summary}`, {authorName: 'Ghost Browser Relay', authorEmail: 'ghost-relay@local'});
    result.committed = true; result.commitHash = committed.hash;
    if (autoPush) { push(tmpDir, {remote, branch}); result.pushed = true; }
    advanceFocus(dirs);
    return finish(dirs, run, result);
  } catch (error) {
    result.error = error.message;
    return finish(dirs, run, result);
  } finally {
    try { removeWorktree(root, tmpDir); } catch { /* best effort cleanup */ }
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
}

function finish(dirs, run, result) {
  run.result = result;
  writeRelay(dirs, run);
  const dir = path.join(dirs.ghost, 'self-improvement');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, `${result.time.replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 2));
  return result;
}
