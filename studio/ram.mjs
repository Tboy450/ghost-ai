// Ghost's working memory, built like a RAM chip.
//
// The archive in archive.mjs is storage: wide, compressed, and searchable. What sat on top
// of it was not memory, it was a fresh lookup every single turn. `renderRecall` re-ranked
// the whole archive, unpacked the top couple of pockets, spent its budget, and then threw
// all of it away. The next turn started from nothing and paid the same cost again, and a
// pocket that mattered for six turns running was re-decided six times.
//
// That is a disk with no RAM in front of it. So this module is the RAM.
//
// The pieces are the ones a real memory hierarchy has, for the same reasons:
//
//   ADDRESSES.  Every pocket gets a short stable handle (`P-3F`). The model can name one
//               in its answer to ask for it, which turns recall from something guessed on
//               its behalf into something it can request. A name you can say is the
//               difference between a cache and an addressable memory.
//
//   TIERS.      RESIDENT holds a pocket's full text in the prompt. DIGEST holds one line.
//               PACKED is on disk and costs nothing. Every pocket is in exactly one tier
//               and moves between them under a fixed budget.
//
//   CAPACITY.   The chip is sized in tokens, once, and never exceeds it. This is the whole
//               safety property: prompt cost is a constant the hardware profile sets, not
//               something that grows with the archive. A bigger archive makes Ghost
//               remember more, never cost more.
//
//   FAULTS.     Wanting a pocket that is not resident is a page fault: it is paged in and
//               something colder is evicted to make room.
//
//   LOCALITY.   Temporal: a pocket used this turn is likely wanted next turn, so residency
//               persists across turns instead of being re-decided. Spatial: conversations
//               run in sequence, so paging in a pocket prefetches its neighbours, which is
//               the same bet a cache line makes.
//
//   EVICTION.   LRU alone thrashes when one odd question pages in junk and throws out a
//               constraint that has been used all session. So eviction scores recency,
//               use count, and whether the pocket settles something — a constraint is
//               expensive to lose and cheap to keep.
//
// The payoff is a hit rate. A resident pocket costs nothing to recall and needs no search,
// no decompression, and no re-ranking, and it stays worded identically from turn to turn,
// which is what stops the model relitigating a decision it already has.
import fs from 'node:fs';
import path from 'node:path';
import { recall, expandPocket, archiveAvailable } from './archive.mjs';
import { estimateTokens } from './memory.mjs';

export const TIERS = {RESIDENT: 'resident', DIGEST: 'digest', PACKED: 'packed'};

// Chip sizes, in prompt tokens. These mirror the hardware profiles: the whole point of a
// fixed capacity is that the machine decides it, not the archive.
//
// Capacity is set relative to a pocket, not picked freely. A pocket is bounded at ~700
// tokens by archive.mjs, so a chip that cannot hold one whole pocket can only ever serve
// digests, and a chip sized at exactly one pocket thrashes the moment a second is wanted.
// Each profile therefore holds a whole number of pockets with room to spare, and
// `residentLimit` is only a secondary cap — the budget is the real limit.
export const CHIP_PROFILES = {
  small: {capacity: 900, residentLimit: 2, prefetch: 1},
  medium: {capacity: 2200, residentLimit: 4, prefetch: 2},
  large: {capacity: 4800, residentLimit: 8, prefetch: 2},
};

const STATE_VERSION = 1;

function statePath(dirs) { return path.join(dirs.ghost, 'ram.json'); }

export function readChip(dirs) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(dirs), 'utf8'));
    if (state?.version === STATE_VERSION) return state;
  } catch { /* no chip yet */ }
  return null;
}

function writeChip(dirs, state) {
  fs.mkdirSync(dirs.ghost, {recursive: true});
  fs.writeFileSync(statePath(dirs), JSON.stringify(state, null, 2));
  return state;
}

export function clearChip(dirs) {
  try { fs.rmSync(statePath(dirs), {force: true}); } catch { /* already gone */ }
  return null;
}

function emptyChip(profile) {
  const config = CHIP_PROFILES[profile] || CHIP_PROFILES.medium;
  return {
    version: STATE_VERSION, profile: profile in CHIP_PROFILES ? profile : 'medium', ...config,
    lines: {}, clock: 0,
    counters: {turns: 0, requests: 0, hits: 0, faults: 0, evictions: 0, prefetched: 0},
  };
}

// One pocket's slot in the chip. Named for a cache line because it behaves like one: it is
// the unit that is paged, aged, and evicted.
function newLine(pocket, address) {
  return {
    address, id: pocket.id, conversation: pocket.conversation, title: pocket.title || '',
    kind: pocket.kind || 'context', digest: pocket.digest || '', seq: pocket.seq ?? 0,
    tier: TIERS.DIGEST, text: null, cost: estimateTokens(pocket.digest || ''),
    uses: 0, lastUsed: 0, loadedAt: 0,
  };
}

// Addresses are short because the model has to be able to repeat one back without
// mistyping it, and stable because an address that moves is not an address.
function assignAddress(chip, id) {
  const existing = Object.values(chip.lines).find(line => line.id === id);
  if (existing) return existing.address;
  let n = Object.keys(chip.lines).length;
  let address;
  do { address = `P-${n.toString(36).toUpperCase().padStart(2, '0')}`; n++; } while (chip.lines[address]);
  return address;
}

function residentCost(chip) {
  return Object.values(chip.lines).reduce((sum, line) => sum + (line.tier === TIERS.PACKED ? 0 : line.cost), 0);
}

// What a pocket is worth keeping. Recency dominates, because the strongest signal that
// something will be needed is that it was just needed; repeated use and settling power
// break the ties that recency alone gets wrong.
function retention(chip, line) {
  const age = chip.clock - line.lastUsed;
  const kindWeight = line.kind === 'constraint' ? 3 : line.kind === 'decision' ? 1.5 : 0;
  return (1 / (1 + age)) * 10 + Math.log2(1 + line.uses) * 2 + kindWeight;
}

// Frees room by demoting the least worth keeping to its digest, then dropping digests if
// it still does not fit. Demotion before eviction matters: a pocket's digest is a tenth of
// its size, so the chip can hold the *knowledge that something exists* for far longer than
// it can hold the text, and a demoted pocket can be paged back in by address.
//
// `pinned` holds the lines already paged in during the current turn. Without it a turn that
// wants four pockets and has room for two would evict its own earlier work to make room for
// its later work, finish with nothing it started with, and fault on all four again next
// turn — a cache that evicts what it just loaded is slower than no cache at all.
function reclaim(chip, needed, pinned = new Set()) {
  const candidates = () => Object.values(chip.lines)
    .filter(line => !pinned.has(line.address))
    .sort((a, b) => retention(chip, a) - retention(chip, b));

  for (const line of candidates()) {
    if (residentCost(chip) + needed <= chip.capacity) return;
    if (line.tier === TIERS.RESIDENT) {
      line.tier = TIERS.DIGEST;
      line.text = null;
      line.cost = estimateTokens(line.digest);
      chip.counters.evictions++;
    }
  }
  for (const line of candidates()) {
    if (residentCost(chip) + needed <= chip.capacity) return;
    delete chip.lines[line.address];
    chip.counters.evictions++;
  }
}

function residentCount(chip) {
  return Object.values(chip.lines).filter(line => line.tier === TIERS.RESIDENT).length;
}

// A page fault: pull the pocket's full text in, making room first. Returns a reason rather
// than a bare false, because "there was no room left" has to stop the turn promoting
// anything more, while "this one pocket could not be opened" must not.
function pageIn(dirs, chip, line, pinned) {
  if (line.tier === TIERS.RESIDENT) { chip.counters.hits++; return 'hit'; }
  const full = expandPocket(dirs, line.id);
  if (!full?.text) return 'unreadable';
  const cost = estimateTokens(full.text);
  // A single pocket larger than the whole chip can never be resident; its digest is the
  // honest answer, and trying anyway would evict everything to fail.
  if (cost > chip.capacity) return 'toolarge';
  reclaim(chip, cost, pinned);
  if (residentCost(chip) + cost > chip.capacity) return 'full';
  line.tier = TIERS.RESIDENT;
  line.text = full.text;
  line.cost = cost;
  line.loadedAt = chip.clock;
  chip.counters.faults++;
  return 'faulted';
}

function touch(chip, line) {
  line.uses++;
  line.lastUsed = chip.clock;
}

// Spatial locality. A conversation's pockets are sequential, so the span either side of a
// useful pocket is the cheapest guess available about what is wanted next. They are brought
// in at digest tier only — a prefetch that pages in full text would be betting the whole
// budget on a guess.
function prefetchNeighbours(dirs, chip, line, pinned) {
  if (!chip.prefetch) return;
  for (let delta = -chip.prefetch; delta <= chip.prefetch; delta++) {
    if (!delta) continue;
    const id = `${line.conversation}:${line.seq + delta}`;
    if (Object.values(chip.lines).some(other => other.id === id)) continue;
    const neighbour = expandPocket(dirs, id);
    if (!neighbour) continue;
    const address = assignAddress(chip, id);
    const slot = newLine({...neighbour, seq: line.seq + delta}, address);
    // A guess never evicts something already earned. If the digest does not fit in what is
    // left over, the prefetch is simply abandoned.
    if (residentCost(chip) + slot.cost > chip.capacity) return;
    slot.lastUsed = chip.clock - 1;
    chip.lines[address] = slot;
    pinned?.add(address);
    chip.counters.prefetched++;
  }
}

// One turn of the chip. Rank the archive for this query, page in what is worth the budget,
// let everything already resident stay resident, and report what it cost.
//
// `explicit` carries addresses the model asked for by name in its last answer. Those are
// honoured before the search results, because a direct request is better evidence of what
// is needed than a keyword score.
export function cycle(dirs, query, {profile = 'medium', explicit = [], limit = 8, excludeConversation = null, extra = []} = {}) {
  if (!archiveAvailable()) return {available: false, lines: [], block: null, stats: emptyChip(profile).counters};
  const chip = readChip(dirs) || emptyChip(profile);
  if (chip.profile !== profile && CHIP_PROFILES[profile]) Object.assign(chip, CHIP_PROFILES[profile], {profile});
  chip.clock++;
  chip.counters.turns++;

  // Everything resident from previous turns ages but survives: that persistence is the
  // difference between a cache and a fresh lookup.
  const wanted = [];
  for (const address of explicit) {
    const line = chip.lines[String(address).toUpperCase()];
    if (line) wanted.push(line);
  }

  // `extra` is how a deeper layer hands the chip pockets that keyword search would never
  // have ranked — associative neighbours, for instance. They queue behind the search hits
  // because a direct term match is still the stronger signal when there is one.
  for (const pocket of [...recall(dirs, query, {limit, excludeConversation}), ...extra]) {
    const address = assignAddress(chip, pocket.id);
    if (!chip.lines[address]) chip.lines[address] = newLine(pocket, address);
    const line = chip.lines[address];
    line.digest = pocket.digest || line.digest;
    line.kind = pocket.kind || line.kind;
    if (!wanted.includes(line)) wanted.push(line);
  }

  // `requests` counts only the pockets the chip actually tried to hold resident, not every
  // pocket the search ranked. Counting the latter would make the hit rate uninterpretable:
  // a small chip that behaved perfectly would still score 2-out-of-8 and look broken.
  const pinned = new Set();
  let promoted = 0;
  for (const line of wanted) {
    touch(chip, line);
    if (promoted >= chip.residentLimit) continue;
    chip.counters.requests++;
    const outcome = pageIn(dirs, chip, line, pinned);
    if (outcome === 'hit' || outcome === 'faulted') {
      pinned.add(line.address);
      promoted++;
      if (outcome === 'faulted') prefetchNeighbours(dirs, chip, line, pinned);
    } else if (outcome === 'full') {
      // The budget is spent. Everything still wanted keeps its digest and its address, so
      // the model can ask for it by name next turn instead of it being silently dropped.
      break;
    }
  }
  // A turn that pages in nothing still has to respect the budget, because residency
  // carried over from previous turns and the profile may have shrunk since.
  reclaim(chip, 0, pinned);
  writeChip(dirs, chip);
  return {available: true, ...snapshot(chip), block: renderChip(chip)};
}

// Addresses the model named in its answer, so it can ask for a pocket it was only shown the
// digest of. Deliberately forgiving about formatting: a small model will write `P-3F`,
// `[P-3F]` or `p-3f` interchangeably, and refusing those would make the feature unusable.
export function parseRequests(text) {
  return [...new Set([...String(text || '').matchAll(/\bP-([0-9A-Z]{2,4})\b/gi)].map(m => `P-${m[1].toUpperCase()}`))];
}

// The prompt block. Resident pockets give their full text; everything else gives one line
// with its address, which is what makes a digest actionable rather than a tease.
export function renderChip(chip) {
  const lines = Object.values(chip.lines).filter(line => line.tier !== TIERS.PACKED);
  if (!lines.length) return null;
  const resident = lines.filter(line => line.tier === TIERS.RESIDENT).sort((a, b) => b.lastUsed - a.lastUsed);
  const digests = lines.filter(line => line.tier === TIERS.DIGEST).sort((a, b) => b.lastUsed - a.lastUsed);
  const out = [];
  if (resident.length) {
    out.push('From earlier conversations:');
    for (const line of resident) out.push(`[${line.address}] ${line.title || 'earlier'}:\n  ${line.text.replace(/\n/g, '\n  ')}`);
  }
  if (digests.length) {
    out.push('', 'Also on file (ask for one by its code if you need it in full):');
    for (const line of digests) out.push(`[${line.address}] ${line.digest}`);
  }
  return out.join('\n');
}

function snapshot(chip) {
  const lines = Object.values(chip.lines).map(line => ({
    address: line.address, id: line.id, title: line.title, kind: line.kind, tier: line.tier,
    cost: line.cost, uses: line.uses, digest: line.digest,
  }));
  const {requests, hits, faults, evictions, prefetched, turns} = chip.counters;
  return {
    profile: chip.profile, capacity: chip.capacity, used: residentCost(chip),
    resident: residentCount(chip), tracked: lines.length, lines,
    stats: {
      turns, requests, hits, faults, evictions, prefetched,
      hitRate: requests ? +(hits / requests).toFixed(3) : 0,
    },
  };
}

export function chipState(dirs, {profile = 'medium'} = {}) {
  const chip = readChip(dirs);
  if (!chip) return {available: archiveAvailable(), ...snapshot(emptyChip(profile)), block: null};
  return {available: archiveAvailable(), ...snapshot(chip), block: renderChip(chip)};
}
