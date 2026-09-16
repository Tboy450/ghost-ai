// Measures what Ghost's memory hierarchy actually buys, so the numbers in the roadmap are
// observed rather than claimed. Two independent things are measured, because they are
// commonly conflated:
//
//   STORAGE  - how small the archive gets. Per-pocket compression versus the MCCP-style
//              shared dictionary. This saves disk, not prompt.
//   CONTEXT  - how much history a turn can reach for a fixed prompt cost, and how often
//              the chip answers without touching the archive at all. This is the number
//              that matters for a small local model.
//
// Usage: node scripts/bench_memory.mjs [conversations]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rememberConversation, archiveStats, trainArchiveDictionary, repackArchive, archiveAvailable } from '../studio/archive.mjs';
import { cycle, CHIP_PROFILES } from '../studio/ram.mjs';
import { estimateTokens } from '../studio/memory.mjs';

if (!archiveAvailable()) {
  console.error('SQLite is unavailable in this Node build, so the archive cannot be measured.');
  process.exit(1);
}

const TOPICS = [
  ['storage', 'We decided to store the history as JSONL because rewriting one large JSON file kept corrupting it after a crash.'],
  ['auth', 'The constraint is that no API key may ever be written outside the gitignored .ghost folder.'],
  ['context', 'We agreed the recall budget is fixed by the hardware profile so prompt cost cannot grow with the archive.'],
  ['editor', 'The requirement is that saving a file always writes a timestamped backup first.'],
  ['tests', 'We decided every cycle runs the suite before proposing anything so an already-red repo is not blamed on the AI.'],
  ['models', 'The constraint is that the model endpoint must resolve to localhost, never a remote host.'],
  ['git', 'We decided self-improvement commits land on ghost/self-update and never the live branch.'],
  ['ui', 'The requirement is the frontend stays dependency-free vanilla JS with no build step.'],
];

const FILLER = [
  'Let me think about that for a second.',
  'That makes sense, thanks for walking through it.',
  'Could you show me what that looks like in practice?',
  'Right, I see what you mean now.',
  'Okay, what about the edge case where it fails partway through?',
  'I was wondering about the performance side of that.',
];

const conversations = Number(process.argv[2] || 200);
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-bench-'));
const dirs = {ghost: path.join(root, '.ghost')};
fs.mkdirSync(dirs.ghost, {recursive: true});

let rawTokens = 0, turns = 0;
for (let c = 0; c < conversations; c++) {
  const [topic, decision] = TOPICS[c % TOPICS.length];
  const messages = [];
  const length = 14 + (c % 10) * 2;
  for (let i = 0; i < length; i++) {
    const content = i === Math.floor(length / 2)
      ? `${decision} (${topic} revision ${c})`
      : `${FILLER[(i + c) % FILLER.length]} We were looking at the ${topic} side of things in round ${c}, step ${i}.`;
    messages.push({role: i % 2 ? 'assistant' : 'user', content, time: new Date(Date.now() - (conversations - c) * 3600000).toISOString()});
    rawTokens += estimateTokens(content);
    turns++;
  }
  rememberConversation(dirs, `conv-${c}`, `${topic} conversation ${c}`, messages);
}

const before = archiveStats(dirs);
const trained = trainArchiveDictionary(dirs);
const repack = repackArchive(dirs);
const after = archiveStats(dirs);

const row = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
const ratio = stats => +(stats.rawBytes / stats.storedBytes).toFixed(2);

console.log(`\nCorpus: ${conversations} conversations, ${turns} messages, ${rawTokens.toLocaleString()} tokens of raw history`);
console.log(`Archive: ${after.pockets} pockets, ${after.cards} cards\n`);

console.log('STORAGE');
row('per-pocket only', `${(before.storedBytes / 1024).toFixed(1)} KB  (${ratio(before)}x)`);
row('with shared dictionary', `${(after.storedBytes / 1024).toFixed(1)} KB  (${ratio(after)}x)`);
row('dictionary size', trained ? `${(trained.bytes / 1024).toFixed(1)} KB, trained on ${trained.samples} pockets` : 'not trained');
row('pockets repacked', `${repack.repacked}`);
row('improvement from dictionary', `${(((before.storedBytes - after.storedBytes) / before.storedBytes) * 100).toFixed(1)}%`);

console.log('\nCONTEXT  (per turn, for a fixed prompt budget)');
for (const profile of Object.keys(CHIP_PROFILES)) {
  const measure = pattern => {
    // Fresh chip per measurement so a hit rate is never inherited from a previous run.
    try { fs.rmSync(path.join(dirs.ghost, 'ram.json'), {force: true}); } catch { /* none yet */ }
    let used = 0, samples = 0, last = null;
    for (const topic of pattern) {
      last = cycle(dirs, `why did we choose the ${topic} approach`, {profile});
      used += last.used; samples++;
    }
    return {avg: Math.round(used / samples), hitRate: last.stats.hitRate};
  };

  // Realistic: people stay on a subject for several turns before moving on. This is the
  // pattern the chip exists for, and the one temporal locality is a bet on.
  const focused = measure(TOPICS.flatMap(([topic]) => [topic, topic, topic, topic]));
  // Adversarial: a different subject every single turn, which is the worst case for any
  // cache. Reported so the hit rate above is not mistaken for a best-case-only number.
  const thrash = measure([...TOPICS, ...TOPICS].map(([topic]) => topic));

  row(`${profile} chip (cap ${CHIP_PROFILES[profile].capacity})`,
    `${focused.avg} tok/turn · reaches ${Math.round(rawTokens / Math.max(focused.avg, 1))}x its size`);
  row('   hit rate, staying on topic', `${(focused.hitRate * 100).toFixed(0)}%`);
  row('   hit rate, new topic each turn', `${(thrash.hitRate * 100).toFixed(0)}%`);
}

fs.rmSync(root, {recursive: true, force: true});
console.log('');
