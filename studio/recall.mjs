// Layered recall — depths of memory, in the shape a MUD client actually uses.
//
// A MUD client does not have "a memory". It runs several channels at once, at different
// depths, each with a different cost and a different job:
//
//   triggers    fire on a pattern the instant it appears, with no lookup at all
//   GMCP/MSDP   carry small structured state out-of-band, always present, never searched
//   scrollback  holds recent text in memory, cheap to re-read
//   logs        hold everything on disk, searched only when you go looking
//   mapper      a derived graph built from the stream, navigated rather than searched
//
// Ghost had only the middle of that ladder: search the logs, paste what comes back. That is
// both inefficient and non-functional at the edges. Inefficient because the overwhelming
// majority of turns need one standing constraint and the current task, and paying an FTS
// query plus a decompression for that is absurd. Non-functional because the things that
// must never be forgotten were competing for space with passing remarks, and losing.
//
// So recall is a ladder of five depths, cheapest first, and it stops climbing the moment it
// has enough. The measured cost of that ordering is that an ordinary turn never opens the
// archive at all.
//
//   0 REFLEX   standing rules, matched by term overlap against a small cached list. No I/O.
//   1 STATUS   structured state — project, focus, current task. No I/O beyond one JSON read.
//   2 CHIP     the RAM chip: resident spans and addressable digests, persistent across turns.
//   3 ARCHIVE  keyword search over every pocket ever written, and a page-in for the best.
//   4 LINKS    the mapper. Traverses the associative graph out from whatever is in hand.
//
// Depth 4 exists for the case the other four cannot serve. Benchmarking the chip against a
// conversation that changes topic every single turn gave a 0% hit rate, and that number is
// not a defect: no cache can help when nothing recurs. But a new topic is rarely unrelated
// to the standing decisions, and the link graph can reach those when the keywords cannot.

import fs from 'node:fs';
import path from 'node:path';
import { terms, estimateTokens } from './memory.mjs';
import { cycle, parseRequests, chipState } from './ram.mjs';
import { recall, linkedPockets, archiveAvailable, withArchive } from './archive.mjs';

export const DEPTHS = ['reflex', 'status', 'chip', 'archive', 'links'];

// How much evidence counts as "enough to stop climbing". Each depth contributes what it
// found; once the running total clears this, deeper and more expensive layers are skipped.
const SATISFIED = 3;
const REFLEX_LIMIT = 6;
const REFLEX_FILE = 'reflexes.json';
const STATUS_FILE = 'status.json';

const readJson = (dirs, file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dirs.ghost, file), 'utf8')); }
  catch { return fallback; }
};

const writeJson = (dirs, file, value) => {
  try {
    fs.mkdirSync(dirs.ghost, {recursive: true});
    fs.writeFileSync(path.join(dirs.ghost, file), JSON.stringify(value, null, 2));
    return true;
  } catch { return false; }
};

// ---------------------------------------------------------------------------------------
// Depth 0 — reflexes.
//
// A reflex is a rule that should apply whenever its subject comes up, without anyone having
// to search for it. "Never use a build step." "Tests live in studio/tests." These are the
// statements it is most damaging to forget and the cheapest to carry, so they belong at the
// top of the ladder rather than competing for cache space at depth 2.

export function readReflexes(dirs) {
  const raw = readJson(dirs, REFLEX_FILE, []);
  return Array.isArray(raw) ? raw.filter(r => r && r.text) : [];
}

export function saveReflexes(dirs, reflexes) {
  return writeJson(dirs, REFLEX_FILE, reflexes.slice(0, 60));
}

export function addReflex(dirs, text, {trigger = '', source = 'manual'} = {}) {
  if (!String(text || '').trim()) return null;
  const reflexes = readReflexes(dirs);
  const entry = {
    id: `R-${Date.now().toString(36).toUpperCase()}`,
    text: String(text).trim().slice(0, 400),
    // No trigger given means the rule is unconditional, and the trigger list stays empty.
    // Deriving one from the rule's own words would quietly make every standing rule
    // conditional on the question happening to repeat them — so "never add a build step"
    // would only be remembered when the question already mentioned builds, which is the
    // one moment it is least needed.
    trigger: trigger ? terms(trigger).slice(0, 12) : [],
    source, created: new Date().toISOString(), uses: 0,
  };
  reflexes.unshift(entry);
  saveReflexes(dirs, reflexes);
  return entry;
}

export function removeReflex(dirs, id) {
  const reflexes = readReflexes(dirs);
  const kept = reflexes.filter(r => r.id !== id);
  if (kept.length === reflexes.length) return false;
  saveReflexes(dirs, kept);
  return true;
}

// Promotes standing constraints out of the archive into reflexes. Constraint pockets are
// already the archive's own judgement about what settles something, so this is a promotion
// of existing signal rather than a new guess.
export function learnReflexes(dirs, {limit = 12} = {}) {
  if (!archiveAvailable()) return {added: 0, scanned: 0};
  const existing = readReflexes(dirs);
  const known = new Set(existing.map(r => r.text.toLowerCase()));
  const rows = withArchive(dirs, db => db.prepare(`
    SELECT digest, title, time FROM pockets WHERE kind = 'constraint' ORDER BY time DESC LIMIT ?
  `).all(limit * 3), []);

  let added = 0;
  for (const row of rows) {
    const text = String(row.digest || '').replace(/\s+/g, ' ').trim();
    if (text.length < 12 || known.has(text.toLowerCase())) continue;
    known.add(text.toLowerCase());
    existing.push({
      id: `R-${Date.now().toString(36).toUpperCase()}-${added}`,
      text: text.slice(0, 400), trigger: terms(text).slice(0, 12),
      source: 'archive', created: new Date().toISOString(), uses: 0,
    });
    if (++added >= limit) break;
  }
  if (added) saveReflexes(dirs, existing);
  return {added, scanned: rows.length};
}

function fireReflexes(dirs, query) {
  const reflexes = readReflexes(dirs);
  if (!reflexes.length) return {items: [], text: null, cost: 0};
  const asked = new Set(terms(query));
  const fired = [];
  for (const reflex of reflexes) {
    // No trigger terms at all means the rule is unconditional.
    const overlap = reflex.trigger.length ? reflex.trigger.filter(t => asked.has(t)).length : Infinity;
    if (!reflex.trigger.length || overlap >= Math.min(2, reflex.trigger.length)) {
      fired.push({...reflex, overlap});
    }
  }
  fired.sort((a, b) => b.overlap - a.overlap);
  const items = fired.slice(0, REFLEX_LIMIT);
  if (!items.length) return {items: [], text: null, cost: 0};
  const text = ['Standing rules:', ...items.map(r => `- ${r.text}`)].join('\n');
  return {items, text, cost: estimateTokens(text)};
}

// ---------------------------------------------------------------------------------------
// Depth 1 — status.
//
// The GMCP layer: a handful of structured facts that are true right now. Kept out of the
// conversation entirely so they cannot be compacted away, and kept small enough that they
// are always affordable.

export function readStatus(dirs) {
  const raw = readJson(dirs, STATUS_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export function setStatus(dirs, patch) {
  const next = {...readStatus(dirs)};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = String(value).slice(0, 300);
  }
  writeJson(dirs, STATUS_FILE, next);
  return next;
}

export function clearStatus(dirs) { return writeJson(dirs, STATUS_FILE, {}); }

function renderStatus(dirs) {
  const status = readStatus(dirs);
  const keys = Object.keys(status);
  if (!keys.length) return {items: [], text: null, cost: 0};
  const text = ['Current state:', ...keys.map(k => `- ${k}: ${status[k]}`)].join('\n');
  return {items: keys.map(k => ({key: k, value: status[k]})), text, cost: estimateTokens(text)};
}

// ---------------------------------------------------------------------------------------
// The ladder.

export function recallLayered(dirs, query, {
  profile = 'medium', explicit = [], limit = 8, excludeConversation = null,
  maxDepth = 4, budget = 1600,
} = {}) {
  const depths = [];
  const blocks = [];
  let evidence = 0;
  let spent = 0;

  const record = (name, {items, text, cost}, extra = {}) => {
    const fits = text && spent + cost <= budget;
    if (fits) { blocks.push(text); spent += cost; }
    depths.push({depth: DEPTHS.indexOf(name), name, items: items.length, cost: fits ? cost : 0, skipped: false, ...extra});
    return fits ? items.length : 0;
  };

  // Depth 0 and 1 are unconditional. They are close to free, and the whole point of a rule
  // that must always hold is that it does not depend on the question resembling it.
  evidence += record('reflex', fireReflexes(dirs, query)) * 0.75;
  record('status', renderStatus(dirs));

  let chip = null;
  if (maxDepth >= 2 && archiveAvailable()) {
    chip = cycle(dirs, query, {profile, explicit, limit, excludeConversation});
    const resident = (chip.lines || []).filter(l => l.tier === 'resident');
    evidence += resident.length;
    if (chip.block && spent + estimateTokens(chip.block) <= budget) {
      blocks.push(chip.block);
      spent += estimateTokens(chip.block);
    }
    depths.push({
      depth: 2, name: 'chip', items: resident.length, cost: chip.block ? estimateTokens(chip.block) : 0,
      skipped: false, hitRate: chip.stats?.hitRate ?? 0,
    });
  } else {
    depths.push({depth: 2, name: 'chip', items: 0, cost: 0, skipped: true});
  }

  // Depth 3 is the first layer that costs a query, so it only runs when the cheap layers
  // came up short. On a turn about the thing we were already discussing, they will not.
  if (maxDepth >= 3 && archiveAvailable() && evidence < SATISFIED) {
    const extra = recall(dirs, query, {limit, excludeConversation});
    depths.push({depth: 3, name: 'archive', items: extra.length, cost: 0, skipped: false});
    evidence += extra.length * 0.5;
  } else {
    depths.push({depth: 3, name: 'archive', items: 0, cost: 0, skipped: true});
  }

  // Depth 4 is the last resort and the only layer that can answer a question sharing no
  // words with anything on file.
  if (maxDepth >= 4 && archiveAvailable() && evidence < SATISFIED) {
    const seeds = (chip?.lines || []).map(l => l.id).filter(Boolean).slice(0, 8);
    const neighbours = linkedPockets(dirs, seeds, {limit: 4});
    if (neighbours.length) {
      // Hand them to the chip rather than pasting them, so an associative find is cached
      // like any other and can be asked for by address next turn.
      const widened = cycle(dirs, query, {profile, explicit, limit, excludeConversation, extra: neighbours});
      const previous = blocks.length && chip?.block ? blocks.lastIndexOf(chip.block) : -1;
      if (widened.block) {
        if (previous >= 0) { spent -= estimateTokens(chip.block); blocks.splice(previous, 1); }
        if (spent + estimateTokens(widened.block) <= budget) { blocks.push(widened.block); spent += estimateTokens(widened.block); }
      }
      chip = widened;
    }
    depths.push({depth: 4, name: 'links', items: neighbours.length, cost: 0, skipped: false});
  } else {
    depths.push({depth: 4, name: 'links', items: 0, cost: 0, skipped: true});
  }

  return {
    available: archiveAvailable(),
    text: blocks.filter(Boolean).join('\n\n') || null,
    cost: spent, budget, depths, chip,
    deepest: depths.filter(d => !d.skipped).reduce((max, d) => Math.max(max, d.depth), 0),
  };
}

// A single view of every layer for diagnostics, so the UI can show which depths are
// carrying the work rather than reporting one opaque "memory" number.
export function memoryState(dirs, {profile = 'medium'} = {}) {
  return {
    available: archiveAvailable(),
    reflexes: readReflexes(dirs),
    status: readStatus(dirs),
    chip: chipState(dirs, {profile}),
  };
}

export { parseRequests };
