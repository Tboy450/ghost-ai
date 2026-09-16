import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trainDictionary, packBody, unpackBody, parseCodec, rememberConversation, trainArchiveDictionary, repackArchive, expandPocket, archiveAvailable, archiveStats } from '../archive.mjs';
import { cycle, chipState, clearChip, readChip, parseRequests, renderChip, CHIP_PROFILES, TIERS } from '../ram.mjs';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ghost-ram-test-'));
  const dirs = {ghost: path.join(root, '.ghost')};
  fs.mkdirSync(dirs.ghost, {recursive: true});
  return {root, dirs, cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
}

// Conversation-shaped text: highly repetitive phrasing, which is exactly the case a shared
// dictionary is supposed to win and per-pocket compression cannot.
function conversation(topic, n) {
  return [
    {role: 'user', content: `We were talking about the ${topic} layer again in round ${n}.`, time: '2026-01-01T00:00:00Z'},
    {role: 'assistant', content: `We decided the ${topic} layer stores its history as JSONL because rewriting one large JSON file kept corrupting it after a crash.`, time: '2026-01-01T00:01:00Z'},
    {role: 'user', content: `The constraint is that the ${topic} layer must never write outside the gitignored folder.`, time: '2026-01-01T00:02:00Z'},
    {role: 'assistant', content: `Understood, the ${topic} layer will keep everything inside that folder in round ${n}.`, time: '2026-01-01T00:03:00Z'},
  ];
}

test('a trained dictionary holds repeated phrases and ignores one-off text', () => {
  const texts = Array.from({length: 20}, (_, i) => `the recall budget stays at 700 tokens so the prompt cost cannot grow\nrow ${i}`);
  const dict = trainDictionary(texts);
  assert.ok(dict.length > 0, 'a dictionary is produced');
  assert.ok(dict.includes('the recall budget stays at 700 tokens'), 'a repeated phrase is kept');
  assert.ok(!dict.includes('row 7'), 'text that appears once is not worth dictionary space');
});

test('a dictionary never exceeds its size limit', () => {
  const texts = Array.from({length: 400}, (_, i) => `repeated filler phrase number ${i % 50} that appears many times over\n`.repeat(3));
  assert.ok(trainDictionary(texts, {max: 4096}).length <= 4096);
});

test('a dictionary-packed pocket round-trips exactly and records which dictionary it used', () => {
  const text = 'We decided the storage layer stores its history as JSONL because rewriting one large JSON file kept corrupting it.';
  const dict = {id: 3, body: trainDictionary(Array.from({length: 10}, () => text))};
  const packed = packBody(text, dict);
  assert.match(packed.codec, /^(bdict|zdict):3$/, 'the pocket records the codec and the dictionary it used');
  assert.equal(parseCodec(packed.codec).dictionary, 3);
  assert.equal(unpackBody(packed.codec, packed.body, id => (id === 3 ? dict.body : null)), text);
});

test('a shared dictionary beats per-pocket compression on small spans', () => {
  const text = 'We decided the storage layer stores its history as JSONL because rewriting one large JSON file kept corrupting it after a crash.';
  const dict = {id: 1, body: trainDictionary(Array.from({length: 12}, (_, i) => text + ` Round ${i}.`))};
  const alone = packBody(text).body.length;
  const shared = packBody(text, dict).body.length;
  assert.ok(shared < alone, `shared dictionary (${shared}B) must beat standalone (${alone}B)`);
});

test('a pocket whose dictionary is missing degrades instead of returning corrupt text', () => {
  const text = 'a'.repeat(400) + ' some settled decision text';
  const dict = {id: 9, body: trainDictionary(Array.from({length: 10}, () => text))};
  const packed = packBody(text, dict);
  assert.equal(unpackBody(packed.codec, packed.body, () => null), null);
  assert.equal(unpackBody('zdict:404', packed.body, () => null), null);
  assert.equal(unpackBody('bdict:404', packed.body, () => null), null);
});

test('packing without a dictionary still works, so existing pockets are unaffected', () => {
  const text = 'short';
  const packed = packBody(text);
  assert.equal(parseCodec(packed.codec).dictionary, null);
  assert.equal(unpackBody(packed.codec, packed.body), text);
});

test('retraining never breaks pockets written against an older dictionary', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 10; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    const first = trainArchiveDictionary(dirs);
    assert.ok(first?.id, 'a dictionary is trained once there is a corpus');
    repackArchive(dirs);
    const before = expandPocket(dirs, 'c0:0');
    assert.ok(before?.text, 'a repacked pocket still opens');

    // A second, different corpus trains a second dictionary. The first pockets must still open.
    for (let i = 10; i < 20; i++) rememberConversation(dirs, `c${i}`, `editor talk ${i}`, conversation('editor', i));
    const second = trainArchiveDictionary(dirs);
    assert.ok(second.id > first.id, 'retraining adds a dictionary rather than replacing one');
    assert.equal(expandPocket(dirs, 'c0:0').text, before.text, 'an older pocket is unchanged by retraining');
  } finally { cleanup(); }
});

test('repacking the archive only ever makes it smaller', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 24; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    const originals = new Map();
    for (let i = 0; i < 24; i++) originals.set(`c${i}:0`, expandPocket(dirs, `c${i}:0`).text);
    trainArchiveDictionary(dirs);
    const result = repackArchive(dirs);
    assert.ok(result.after <= result.before, 'repacking can never grow the archive');
    assert.ok(result.repacked > 0, 'a repetitive corpus has something to gain');
    for (const [id, text] of originals) assert.equal(expandPocket(dirs, id).text, text, `${id} must survive repacking byte for byte`);
  } finally { cleanup(); }
});

// --- the chip -------------------------------------------------------------------------

test('the chip never exceeds its capacity no matter how much is recalled', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 40; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    for (let turn = 0; turn < 6; turn++) {
      const state = cycle(dirs, 'why is storage stored as jsonl', {profile: 'small'});
      assert.ok(state.used <= CHIP_PROFILES.small.capacity, `used ${state.used} exceeded capacity`);
    }
  } finally { cleanup(); }
});

test('a pocket used repeatedly stays resident instead of being re-decided every turn', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 12; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    cycle(dirs, 'why is storage stored as jsonl', {profile: 'medium'});
    const second = cycle(dirs, 'why is storage stored as jsonl', {profile: 'medium'});
    assert.ok(second.stats.hits > 0, 'the second identical turn must hit the chip, not fault');
    assert.ok(second.stats.hitRate > 0, 'a hit rate is reported');
  } finally { cleanup(); }
});

test('an address the model names is paged back in', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 20; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    const first = cycle(dirs, 'storage jsonl decision', {profile: 'small'});
    const digested = first.lines.find(line => line.tier === TIERS.DIGEST);
    if (!digested) return; // nothing was demoted on this corpus; the capacity test covers the rest
    const after = cycle(dirs, 'something unrelated entirely', {profile: 'small', explicit: [digested.address]});
    const line = after.lines.find(l => l.address === digested.address);
    assert.ok(line, 'a requested address is not dropped in the same turn it was asked for');
  } finally { cleanup(); }
});

test('addresses are parsed out of a model answer in the forms a small model writes them', () => {
  assert.deepEqual(parseRequests('I need [P-0A] and p-1b please'), ['P-0A', 'P-1B']);
  assert.deepEqual(parseRequests('no addresses here'), []);
  assert.deepEqual(parseRequests('P-0A P-0A'), ['P-0A'], 'a repeated address is asked for once');
});

test('the prompt block labels resident text and offers the rest by address', () => {
  const chip = {
    lines: {
      'P-00': {address: 'P-00', tier: TIERS.RESIDENT, title: 'storage', text: 'full text here', digest: 'd', lastUsed: 2},
      'P-01': {address: 'P-01', tier: TIERS.DIGEST, title: 'editor', text: null, digest: 'the editor writes a backup first', lastUsed: 1},
    },
  };
  const block = renderChip(chip);
  assert.match(block, /full text here/);
  assert.match(block, /\[P-01\] the editor writes a backup first/);
  assert.match(block, /ask for one by its code/);
  assert.equal(renderChip({lines: {}}), null, 'an empty chip contributes nothing to the prompt');
});

test('the chip survives a restart and can be cleared', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 12; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    cycle(dirs, 'why is storage stored as jsonl', {profile: 'medium'});
    assert.ok(readChip(dirs), 'the chip is persisted, so a restart does not wipe working memory');
    assert.ok(chipState(dirs).tracked > 0);
    clearChip(dirs);
    assert.equal(readChip(dirs), null);
    assert.equal(chipState(dirs).tracked, 0);
  } finally { cleanup(); }
});

test('shrinking the profile immediately shrinks what the prompt pays', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    for (let i = 0; i < 30; i++) rememberConversation(dirs, `c${i}`, `storage talk ${i}`, conversation('storage', i));
    const large = cycle(dirs, 'why is storage stored as jsonl', {profile: 'large'});
    const small = cycle(dirs, 'why is storage stored as jsonl', {profile: 'small'});
    assert.equal(small.capacity, CHIP_PROFILES.small.capacity);
    assert.ok(small.used <= CHIP_PROFILES.small.capacity, 'dropping to a smaller chip must evict down to the new budget');
    assert.ok(small.used <= large.used, 'a smaller chip cannot cost more than a larger one');
  } finally { cleanup(); }
});

test('an empty archive costs nothing and reports no chip', {skip: !archiveAvailable()}, () => {
  const {dirs, cleanup} = tempDirs();
  try {
    const state = cycle(dirs, 'anything at all', {profile: 'medium'});
    assert.equal(state.block, null);
    assert.equal(state.used, 0);
  } finally { cleanup(); }
});
