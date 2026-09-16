import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rememberConversation, buildLinks, linkedPockets, recall, archiveAvailable } from '../archive.mjs';
import {
  DEPTHS, readReflexes, addReflex, removeReflex, learnReflexes,
  readStatus, setStatus, clearStatus, recallLayered, memoryState,
} from '../recall.mjs';

const workspace = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-recall-')));
  const ghost = path.join(root, '.ghost');
  fs.mkdirSync(ghost, {recursive: true});
  return {root, ghost};
};

const exchange = (user, assistant) => ([
  {role: 'user', content: user},
  {role: 'assistant', content: assistant},
]);

// Two clusters that share no vocabulary with each other, so a link between clusters would
// be a false positive and a link inside one is the thing worth finding. Each cluster needs
// several *conversations*, not just several messages: pockets are per-conversation spans,
// so one long conversation is one pocket and one pocket cannot be linked to anything.
function seedArchive(dirs) {
  const ledger = [
    'chargeback for an invoice', 'a partial refund', 'a duplicate settlement', 'a disputed invoice line',
  ];
  ledger.forEach((topic, n) => {
    const history = [];
    for (let i = 0; i < 4; i++) {
      history.push(...exchange(
        `How should the payment reconciliation ledger handle ${topic} number ${i}?`,
        `Chargebacks and refunds on the reconciliation ledger reverse the invoice and post a contra entry. Never delete the original ledger row for invoice ${i}; the audit trail depends on it.`,
      ));
    }
    rememberConversation(dirs, `ledger-${n}`, `Reconciliation ledger: ${topic}`, history);
  });

  const firmware = ['thermal throttling', 'duty cycle stepping', 'sensor calibration', 'stall detection'];
  firmware.forEach((topic, n) => {
    const history = [];
    for (let i = 0; i < 4; i++) {
      history.push(...exchange(
        `What ${topic} curve should the compressor firmware use at stage ${i}?`,
        `Compressor firmware handles ${topic} above eighty degrees at stage ${i}, stepping the duty cycle down through the thermal envelope.`,
      ));
    }
    rememberConversation(dirs, `firmware-${n}`, `Compressor firmware: ${topic}`, history);
  });
}

test('reflexes persist, fire on their trigger terms, and can be removed', () => {
  const dirs = workspace();
  assert.deepEqual(readReflexes(dirs), []);

  const scoped = addReflex(dirs, 'Tests live in studio/tests and run with node --test.', {trigger: 'tests testing'});
  const global = addReflex(dirs, 'Never add a build step.');

  assert.equal(readReflexes(dirs).length, 2);
  // A rule given no trigger is unconditional; one given a trigger stays scoped to it.
  assert.deepEqual(global.trigger, [], 'no trigger means always');
  assert.equal(scoped.trigger.length > 0, true, 'explicit trigger is kept');

  const onTopic = recallLayered(dirs, 'where do the tests go?', {maxDepth: 0});
  assert.match(onTopic.text, /Standing rules/);
  assert.match(onTopic.text, /Never add a build step/, 'unconditional rule always fires');

  assert.equal(removeReflex(dirs, scoped.id), true);
  assert.equal(removeReflex(dirs, scoped.id), false, 'removing twice is not an error');
  assert.equal(readReflexes(dirs).length, 1);
});

test('status is structured, patchable, and cleared by empty values', () => {
  const dirs = workspace();
  assert.deepEqual(readStatus(dirs), {});

  setStatus(dirs, {project: 'ghost', focus: 'memory layers'});
  assert.equal(readStatus(dirs).project, 'ghost');

  setStatus(dirs, {focus: 'packaging'});
  const after = readStatus(dirs);
  assert.equal(after.focus, 'packaging', 'patch overwrites one key');
  assert.equal(after.project, 'ghost', 'patch leaves other keys alone');

  setStatus(dirs, {project: ''});
  assert.equal('project' in readStatus(dirs), false, 'empty value removes the key');

  clearStatus(dirs);
  assert.deepEqual(readStatus(dirs), {});
});

test('depth 0 and 1 answer without touching the archive at all', () => {
  const dirs = workspace();
  addReflex(dirs, 'Never delete a ledger row.');
  setStatus(dirs, {task: 'reconciliation'});

  const result = recallLayered(dirs, 'ledger question', {maxDepth: 1});
  const byName = Object.fromEntries(result.depths.map(d => [d.name, d]));

  assert.equal(byName.reflex.skipped, false);
  assert.equal(byName.status.skipped, false);
  assert.equal(byName.chip.skipped, true, 'chip not consulted below its depth');
  assert.equal(byName.archive.skipped, true);
  assert.equal(byName.links.skipped, true);
  assert.match(result.text, /Never delete a ledger row/);
  assert.match(result.text, /task: reconciliation/);
  assert.equal(result.deepest, 1);
});

test('the ladder stops climbing once the cheap layers have answered', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);

  // Enough standing rules to clear the satisfaction threshold on their own.
  for (const rule of ['Reverse the invoice.', 'Post a contra entry.', 'Keep the audit trail.', 'Never delete a row.']) {
    addReflex(dirs, rule);
  }

  const result = recallLayered(dirs, 'chargeback on the reconciliation ledger', {profile: 'small'});
  const byName = Object.fromEntries(result.depths.map(d => [d.name, d]));
  assert.equal(byName.reflex.items > 0, true);
  assert.equal(byName.archive.skipped, true, 'archive search skipped when already satisfied');
  assert.equal(byName.links.skipped, true, 'mapper skipped when already satisfied');
});

test('the ladder escalates to the archive when the cheap layers are empty', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);

  const result = recallLayered(dirs, 'chargeback on the reconciliation ledger', {profile: 'small'});
  const byName = Object.fromEntries(result.depths.map(d => [d.name, d]));
  assert.equal(byName.reflex.items, 0, 'no reflexes stored');
  assert.equal(byName.chip.skipped, false, 'chip consulted');
  assert.equal(result.deepest >= 2, true, 'climbed past the free layers');
  assert.match(result.text || '', /ledger|invoice/i);
});

test('the layered budget is never exceeded', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);
  for (let i = 0; i < 20; i++) addReflex(dirs, `Standing rule number ${i} about the reconciliation ledger and its invoices.`);

  const result = recallLayered(dirs, 'reconciliation ledger invoice chargeback', {profile: 'large', budget: 300});
  assert.equal(result.cost <= 300, true, `cost ${result.cost} within budget`);
});

test('links connect pockets sharing rare terms and refuse to connect unrelated ones', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);

  const built = buildLinks(dirs);
  assert.equal(built.pockets > 0, true, 'pockets present to link');
  assert.equal(built.links > 0, true, 'links were written');

  // Seed from a ledger pocket; neighbours should stay inside the ledger cluster.
  const seed = recall(dirs, 'reconciliation ledger chargeback invoice', {limit: 1});
  assert.equal(seed.length, 1);

  const neighbours = linkedPockets(dirs, [seed[0].id], {limit: 4});
  assert.equal(neighbours.length > 0, true, 'found associative neighbours');
  assert.equal(neighbours.some(n => n.id === seed[0].id), false, 'never returns the seed itself');
  for (const neighbour of neighbours) {
    assert.match(neighbour.conversation, /^ledger-/, `neighbour ${neighbour.id} stayed in the right cluster`);
  }
});

test('links return nothing for empty seeds rather than everything', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);
  buildLinks(dirs);
  assert.deepEqual(linkedPockets(dirs, [], {limit: 4}), []);
  assert.deepEqual(linkedPockets(dirs, [null, undefined], {limit: 4}), []);
});

test('rebuilding links is idempotent rather than cumulative', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);
  const first = buildLinks(dirs);
  const second = buildLinks(dirs);
  assert.equal(second.links, first.links, 'rebuild does not duplicate edges');
});

test('memoryState reports every layer for diagnostics', () => {
  const dirs = workspace();
  addReflex(dirs, 'Never add a build step.');
  setStatus(dirs, {project: 'ghost'});

  const state = memoryState(dirs, {profile: 'small'});
  assert.equal(state.reflexes.length, 1);
  assert.equal(state.status.project, 'ghost');
  assert.equal(typeof state.chip, 'object');
  assert.equal(DEPTHS.length, 5);
});

test('learning reflexes promotes archived constraints without duplicating them', {skip: !archiveAvailable()}, () => {
  const dirs = workspace();
  seedArchive(dirs);

  const first = learnReflexes(dirs, {limit: 5});
  const second = learnReflexes(dirs, {limit: 5});
  assert.equal(second.added, 0, 'a second pass adds nothing new');
  assert.equal(readReflexes(dirs).length, first.added, 'stored exactly what was learned');
});

test('a corrupt reflex file degrades to no reflexes instead of throwing', () => {
  const dirs = workspace();
  fs.writeFileSync(path.join(dirs.ghost, 'reflexes.json'), '{not json');
  assert.deepEqual(readReflexes(dirs), []);
  assert.doesNotThrow(() => recallLayered(dirs, 'anything', {maxDepth: 1}));
});
