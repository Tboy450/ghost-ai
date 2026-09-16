import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rememberConversation, forgetConversation, recall, expandPocket, archiveStats,
  renderRecall, buildMatchQuery, packBody, unpackBody, packPockets, digestOf, withArchive,
} from '../archive.mjs';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-archive-'));
  return {root, dirs: {ghost: path.join(root, '.ghost')}};
}
const msg = (content, time) => ({role: 'user', content, time: time || new Date().toISOString()});

test('the archive is optional: callers degrade instead of failing', () => {
  // No archive must never cost the user a turn, because recall is an enhancement.
  assert.deepEqual(recall(null, 'anything'), []);
  assert.equal(rememberConversation(null, 'c1', 't', [msg('hi')]), 0);
  assert.equal(expandPocket(null, 'c1:0'), null);
  assert.equal(renderRecall(null, []), null);
  assert.equal(forgetConversation(null, 'c1'), false);
  assert.equal(archiveStats(null).available, false);
});

test('a pocket is packed by whichever algorithm is actually smallest for it', () => {
  // A short span pays gzip framing for nothing, so raw must win there.
  const short = packBody('use postgres');
  assert.equal(short.codec, 'raw');
  assert.equal(unpackBody(short.codec, short.body), 'use postgres');

  // A long repetitive span must actually compress, not just be stored.
  const long = 'The billing service must use PostgreSQL. '.repeat(200);
  const packed = packBody(long);
  assert.notEqual(packed.codec, 'raw');
  assert.ok(packed.body.length < Buffer.byteLength(long, 'utf8') / 4, `expected real compression, got ${packed.body.length} from ${long.length}`);
  assert.equal(unpackBody(packed.codec, packed.body), long, 'unpacking must round-trip exactly');
});

test('a pocket packed by an unknown algorithm falls back instead of corrupting a prompt', () => {
  assert.equal(unpackBody('some-future-codec', Buffer.from('x')), null);
  assert.equal(unpackBody('gzip', Buffer.from('not actually gzip')), null);
});

test('a long conversation is split into pockets that each stay affordable to open', () => {
  const cards = Array.from({length: 30}, (_, i) => ({id: `c${i}`, turn: i, time: '', kind: 'context', text: `statement number ${i}`, terms: []}));
  const pockets = packPockets(cards);
  assert.ok(pockets.length >= 5, `expected several pockets, got ${pockets.length}`);
  assert.ok(pockets.every(pocket => pocket.cards.length <= 6));
  assert.equal(pockets.reduce((sum, pocket) => sum + pocket.cards.length, 0), 30, 'no card may be dropped');
  assert.equal(packPockets([]).length, 0);
});

test('a digest keeps what settles something and drops the chatter', () => {
  const digest = digestOf([
    {kind: 'context', text: 'I was reading about databases today.', terms: []},
    {kind: 'constraint', text: 'The billing service must use PostgreSQL.', terms: []},
  ]);
  assert.match(digest, /must use PostgreSQL/);
  assert.ok(digest.indexOf('must use PostgreSQL') < digest.indexOf('reading about'), 'the constraint must come first');
});

test('a decision from another conversation is recalled without loading that transcript', () => {
  const {root, dirs} = tempDirs();
  try {
    assert.ok(rememberConversation(dirs, 'conv-a', 'Database choice', [
      msg('We must use PostgreSQL for the billing service, never MySQL.'),
      msg('Unrelated chatter about lunch.'),
    ]) > 0);
    rememberConversation(dirs, 'conv-b', 'Styling', [msg('The buttons should be rounded.')]);

    // Asked in a brand new conversation, with the old transcript nowhere in the prompt.
    const hits = recall(dirs, 'which db did we pick for billing?', {excludeConversation: 'conv-new'});
    assert.ok(hits.length > 0);
    assert.equal(hits[0].conversation, 'conv-a');
    assert.equal(hits[0].title, 'Database choice');
    assert.match(hits[0].digest, /PostgreSQL/);
    // Search must return compressed pockets only — nothing is unpacked to find them.
    assert.equal(hits[0].expanded, false);
    assert.equal(hits[0].body, undefined);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a chosen pocket unpacks to the full span, not just its digest', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'Retention', [
      msg('We must keep records for ninety days.'),
      msg('The exact wording came from the compliance review in March.'),
    ]);
    const [hit] = recall(dirs, 'retention records');
    const full = expandPocket(dirs, hit.id);
    assert.equal(full.expanded, true);
    assert.match(full.text, /ninety days/);
    assert.match(full.text, /compliance review/, 'detail absent from the digest must come back on expansion');
    assert.equal(expandPocket(dirs, 'conv-a:999'), null);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('recall skips the conversation already in the prompt so it adds new information', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'A', [msg('We must use PostgreSQL for billing.')]);
    rememberConversation(dirs, 'conv-b', 'B', [msg('We must use PostgreSQL for reporting.')]);
    const hits = recall(dirs, 'postgresql', {excludeConversation: 'conv-a'});
    assert.ok(hits.length > 0);
    assert.ok(hits.every(hit => hit.conversation !== 'conv-a'));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('re-indexing a conversation replaces its pockets instead of accumulating stale ones', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'A', [msg('We must deploy on Fridays.')]);
    assert.equal(archiveStats(dirs).pockets, 1);
    // The user edits the transcript; the old statement must not survive.
    rememberConversation(dirs, 'conv-a', 'A', [msg('We must never deploy on Fridays.')]);
    assert.equal(archiveStats(dirs).pockets, 1);
    const hits = recall(dirs, 'deploy fridays');
    assert.equal(hits.length, 1);
    assert.match(expandPocket(dirs, hits[0].id).text, /never deploy/);

    forgetConversation(dirs, 'conv-a');
    assert.equal(archiveStats(dirs).pockets, 0);
    assert.deepEqual(recall(dirs, 'deploy fridays'), []);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('explicit instructions outrank passing remarks on the same topic', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'A', [msg('I was reading about timezone handling today.')]);
    rememberConversation(dirs, 'conv-b', 'B', [msg('Timezone handling must always use UTC internally.')]);
    const hits = recall(dirs, 'timezone handling');
    assert.equal(hits[0].kind, 'constraint');
    assert.match(hits[0].digest, /UTC/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a hostile query cannot break the search, and renderRecall respects its budget', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'A', [msg('We must use PostgreSQL.')]);
    // FTS5 operators and quotes in user text must not throw or inject.
    for (const hostile of ['"; DROP TABLE pockets; --', 'NEAR(', '*', 'AND OR NOT', '']) {
      assert.doesNotThrow(() => recall(dirs, hostile));
    }
    assert.equal(archiveStats(dirs).pockets, 1, 'the table must still exist');
    assert.equal(buildMatchQuery('   '), null);

    const many = Array.from({length: 40}, (_, i) => ({id: `x:${i}`, title: 'T', digest: `note number ${i} with a fair amount of words in it to spend budget`}));
    const rendered = renderRecall(dirs, many, {budget: 120});
    assert.ok(rendered);
    // The block must obey the budget even when far more was recalled than fits.
    assert.ok(rendered.split('\n').length < 12, `budget ignored: ${rendered.split('\n').length} lines`);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('rendering unpacks the strongest matches and leaves the rest compressed', () => {
  const {root, dirs} = tempDirs();
  try {
    rememberConversation(dirs, 'conv-a', 'Retention', [
      msg('We must keep records for ninety days.'),
      msg('That came from the compliance review in March.'),
    ]);
    const hits = recall(dirs, 'retention records ninety');
    const rendered = renderRecall(dirs, hits, {budget: 700});
    assert.match(rendered, /ninety days/);
    assert.match(rendered, /compliance review/, 'the top pocket should be unpacked in full');

    // With almost no budget, nothing is unpacked but the digest still gets through.
    const tight = renderRecall(dirs, hits, {budget: 40});
    assert.ok(!tight || !/compliance review/.test(tight), 'a tight budget must not unpack the full span');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('the archive never holds the project folder open between operations', () => {
  const {root, dirs} = tempDirs();
  rememberConversation(dirs, 'conv-a', 'A', [msg('We must use PostgreSQL.')]);
  recall(dirs, 'postgresql');
  archiveStats(dirs);
  // Windows refuses to delete a folder while a file in it is open, so this asserts the
  // user can still move, delete, or switch away from a project Ghost has indexed.
  assert.doesNotThrow(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(fs.existsSync(root), false);
});

test('the archive persists across restarts and stays fast as it grows', () => {
  const {root, dirs} = tempDirs();
  try {
    for (let c = 0; c < 20; c++) {
      rememberConversation(dirs, `conv-${c}`, `Conversation ${c}`, Array.from({length: 25}, (_, i) =>
        msg(`Conversation ${c} message ${i} about routine project work.`)));
    }
    rememberConversation(dirs, 'conv-key', 'Key decision', [msg('The retention period must be ninety days.')]);

    // Every call above already closed the file, so this is genuinely a cold read.
    const stats = archiveStats(dirs);
    assert.ok(stats.pockets >= 100, `expected a large archive, got ${stats.pockets} pockets`);
    assert.equal(stats.conversations, 21);
    assert.ok(stats.rawBytes > 0);

    const started = Date.now();
    const hits = recall(dirs, 'what is the retention period?');
    const elapsed = Date.now() - started;
    assert.match(hits[0].digest, /ninety days/);
    // Indexed lookup on digests, so recall stays fast as the archive grows.
    assert.ok(elapsed < 400, `recall took ${elapsed}ms`);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a damaged archive file is reported as unavailable rather than thrown', () => {
  const {root, dirs} = tempDirs();
  try {
    fs.mkdirSync(dirs.ghost, {recursive: true});
    fs.writeFileSync(path.join(dirs.ghost, 'archive.db'), 'this is not a database');
    assert.equal(archiveStats(dirs).available, false);
    assert.deepEqual(recall(dirs, 'anything'), []);
    assert.equal(rememberConversation(dirs, 'conv-a', 'A', [msg('hi')]), 0);
    assert.equal(withArchive(dirs, () => 'worked', 'fallback'), 'fallback');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
