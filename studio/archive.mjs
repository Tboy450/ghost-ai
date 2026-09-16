// Ghost's long-term recall archive — a separate integration level that sits on top of the
// extractive planner in memory.mjs, and is never required by it.
//
// memory.mjs re-reads the *current* conversation every turn and selects from it. That is
// fast and deterministic, but it can only recall what is in the transcript in front of it,
// and its cost grows with the transcript.
//
// This layer stores conversations as *algorithm pockets* instead of flat rows. A pocket is
// a self-contained span of a conversation that carries three things:
//
//   - a digest: a short compressed form, the statements in the span that settle something.
//     This is what search matches and what is normally loaded, so scanning the whole
//     archive costs a few tokens per pocket no matter how long the conversation was.
//   - a body: the full text of the span, packed and only unpacked when that pocket is
//     actually chosen.
//   - the name of the algorithm that packed it.
//
// Carrying the algorithm inside the pocket is the point. The archive picks whichever codec
// is actually smallest for that particular span, so a one-line pocket is not paying gzip
// framing while a long one still gets real compression. Unpacking dispatches on the stored
// name, so a pocket written today stays readable when new codecs are added later, and a
// pocket written by a codec this build does not know degrades to its digest instead of
// corrupting a prompt.
//
// So recall reads compressed and unpacks selectively: prompt cost is bounded by the
// budget, not by the size of the archive.
//
// The dependency runs one way: archive -> memory. Nothing here is required for a turn to
// work. If SQLite is unavailable every function degrades to "no long-term recall" rather
// than failing, and callers carry on with the existing in-transcript behaviour.
//
// The database is opened per operation and closed again. Recall is an indexed lookup and
// costs milliseconds, and holding the file open for the life of the server would lock the
// project folder on Windows and stop the user moving, deleting, or switching a project.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { itemize, terms, estimateTokens } from './memory.mjs';

const require = createRequire(import.meta.url);

// Pocket size. Small enough that unpacking one is affordable, large enough that a pocket
// holds an exchange's worth of context rather than an isolated sentence.
const POCKET_CARDS = 6;
const POCKET_TOKENS = 700;
const DIGEST_TOKENS = 90;

// The algorithms a pocket may be packed with. Each is self-contained, so adding one here
// is enough for new pockets to use it while old pockets keep opening with their own.
export const CODECS = {
  raw: {
    pack: text => Buffer.from(text, 'utf8'),
    unpack: body => Buffer.from(body).toString('utf8'),
  },
  gzip: {
    pack: text => zlib.gzipSync(Buffer.from(text, 'utf8'), {level: 9}),
    unpack: body => zlib.gunzipSync(Buffer.from(body)).toString('utf8'),
  },
  brotli: {
    pack: text => zlib.brotliCompressSync(Buffer.from(text, 'utf8')),
    unpack: body => zlib.brotliDecompressSync(Buffer.from(body)).toString('utf8'),
  },
};

// Order matters only for tie-breaking: the cheapest to unpack wins an exact tie.
const CODEC_ORDER = ['raw', 'gzip', 'brotli'];

// A shared dictionary, the way a MUD client does it.
//
// MCCP does not compress each line on its own — it holds one zlib stream open for the
// whole session, so the dictionary keeps accumulating and a short line late in the
// session compresses against every line before it. That is why a MUD can push tiny,
// endlessly repetitive packets and still get large compression ratios.
//
// Pockets cannot hold one stream open: each one must be independently openable, in any
// order, years later, or random access to the archive is lost. So the accumulated
// dictionary is made explicit instead. A dictionary is trained over the whole corpus,
// stored once, and handed to zlib when packing and unpacking. A 300-byte pocket can then
// match phrases that exist only in *other* pockets, which is exactly what per-pocket
// compression can never do — it is where the flat ~3.5x ratio comes from.
//
// The dictionary is versioned and its id is recorded in the pocket's codec name
// (`zdict:7`). Retraining therefore never invalidates existing pockets: they keep opening
// with the dictionary they were written against, and a pocket whose dictionary is missing
// degrades to its digest like any other unreadable codec.
const DICTIONARY_BYTES = 32768;
const MIN_PHRASE = 12;

// zlib can only match against the dictionary's *last* 32KB, and matches nearer the end are
// encoded in fewer bits, so the most valuable material is placed last.
export function trainDictionary(texts, {max = DICTIONARY_BYTES} = {}) {
  const counts = new Map();
  const add = phrase => {
    const key = phrase.trim();
    if (key.length < MIN_PHRASE) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const text of texts) {
    const lines = String(text || '').split('\n');
    for (const line of lines) {
      add(line);
      // Word runs as well as whole lines: conversations repeat phrases inside sentences
      // far more often than they repeat a sentence exactly.
      const words = line.split(/\s+/).filter(Boolean);
      for (let n = 4; n <= 8; n += 2) {
        for (let i = 0; i + n <= words.length; i++) add(words.slice(i, i + n).join(' '));
      }
    }
  }
  // Value a phrase by the bytes it can actually save: it has to appear more than once,
  // and a long repeated phrase is worth more than a short one.
  const ranked = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([phrase, count]) => ({phrase, gain: (count - 1) * phrase.length}))
    .sort((a, b) => a.gain - b.gain);

  const parts = [];
  let size = 0;
  for (const {phrase} of ranked) {
    const piece = phrase + '\n';
    if (size + piece.length > max) continue;
    parts.push(piece);
    size += piece.length;
  }
  return Buffer.from(parts.join(''), 'utf8');
}

// Packing against a dictionary is only worth it when it actually wins, so it competes with
// the plain codecs rather than replacing them.
//
// Brotli with a custom dictionary is dramatically better than deflate with one (on a
// repetitive span, 82 bytes plain brotli versus 17 with the dictionary), but custom
// dictionaries are a newer addition to Node's brotli bindings. Support is therefore probed
// once at load, and deflate is kept as the fallback so an older runtime still gets most of
// the benefit. Both record distinct codec names, so an archive written on one runtime
// stays readable on the other.
const DICTIONARY_CODECS = {
  bdict: {
    pack: (text, dictionary) => zlib.brotliCompressSync(Buffer.from(text, 'utf8'), {dictionary}),
    unpack: (body, dictionary) => zlib.brotliDecompressSync(Buffer.from(body), {dictionary}).toString('utf8'),
  },
  zdict: {
    pack: (text, dictionary) => zlib.deflateSync(Buffer.from(text, 'utf8'), {dictionary, level: 9}),
    unpack: (body, dictionary) => zlib.inflateSync(Buffer.from(body), {dictionary}).toString('utf8'),
  },
};

// Probed rather than assumed: a runtime that accepts the option but ignores it would
// silently produce pockets that cannot be reopened, so the round trip is what is tested.
const PREFERRED_DICT_CODEC = (() => {
  const probe = 'probe text for dictionary support '.repeat(4);
  const dictionary = Buffer.from(probe, 'utf8');
  try {
    const packed = DICTIONARY_CODECS.bdict.pack(probe, dictionary);
    if (DICTIONARY_CODECS.bdict.unpack(packed, dictionary) === probe) return 'bdict';
  } catch { /* fall through to deflate */ }
  return 'zdict';
})();

export function parseCodec(codec) {
  const match = /^(bdict|zdict):(\d+)$/.exec(String(codec || ''));
  return match ? {name: match[1], dictionary: Number(match[2])} : {name: String(codec || ''), dictionary: null};
}

// Picks the algorithm that is actually smallest for this span rather than assuming one.
// Short pockets are common and compression framing can make them larger, so `raw` wins there.
export function packBody(text, dict = null) {
  let best = null;
  for (const name of CODEC_ORDER) {
    let packed;
    try { packed = CODECS[name].pack(text); } catch { continue; }
    if (!best || packed.length < best.body.length) best = {codec: name, body: packed};
  }
  if (dict?.body?.length) {
    try {
      const packed = DICTIONARY_CODECS[PREFERRED_DICT_CODEC].pack(text, dict.body);
      if (!best || packed.length < best.body.length) best = {codec: `${PREFERRED_DICT_CODEC}:${dict.id}`, body: packed};
    } catch { /* fall back to whichever plain codec won */ }
  }
  return best || {codec: 'raw', body: Buffer.from(text, 'utf8')};
}

// Unpacks using whatever algorithm the pocket recorded. An unknown or damaged pocket
// returns null so the caller can fall back to its digest. `getDictionary` is only consulted
// for dictionary-packed pockets, so plain pockets never touch the database.
export function unpackBody(codec, body, getDictionary = null) {
  const {name, dictionary} = parseCodec(codec);
  if (DICTIONARY_CODECS[name] && dictionary !== null) {
    const dict = getDictionary?.(dictionary);
    if (!dict?.length) return null;
    try { return DICTIONARY_CODECS[name].unpack(body, dict); } catch { return null; }
  }
  const algorithm = CODECS[name];
  if (!algorithm) return null;
  try { return algorithm.unpack(body); } catch { return null; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pockets (
  id TEXT PRIMARY KEY,
  conversation TEXT NOT NULL,
  title TEXT,
  seq INTEGER,
  time TEXT,
  kind TEXT,
  digest TEXT NOT NULL,
  codec TEXT NOT NULL,
  body BLOB NOT NULL,
  cards INTEGER,
  tokens INTEGER,
  raw_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS pockets_conversation ON pockets(conversation);
CREATE VIRTUAL TABLE IF NOT EXISTS pockets_fts USING fts5(pocket_id UNINDEXED, body);
CREATE TABLE IF NOT EXISTS dictionaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created TEXT NOT NULL,
  body BLOB NOT NULL,
  samples INTEGER,
  bytes INTEGER
);
CREATE TABLE IF NOT EXISTS pocket_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS pocket_links_a ON pocket_links(a);
`;

function sqlite() {
  try { return require('node:sqlite').DatabaseSync; } catch { return null; }
}

export function archiveAvailable() { return Boolean(sqlite()); }

// Opens the archive, runs one unit of work, and always closes again. Returns `fallback`
// when SQLite is unavailable or the file cannot be opened, so recall stays optional.
export function withArchive(dirs, work, fallback = null) {
  const DatabaseSync = dirs?.ghost ? sqlite() : null;
  if (!DatabaseSync) return fallback;
  let db;
  try {
    fs.mkdirSync(dirs.ghost, {recursive: true});
    db = new DatabaseSync(path.join(dirs.ghost, 'archive.db'));
    db.exec(SCHEMA);
    return work(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// Splits a conversation's cards into pockets, closing a pocket when it is full so each one
// stays affordable to unpack on its own.
export function packPockets(cards) {
  const pockets = [];
  let current = null;
  for (const card of cards) {
    const cost = estimateTokens(card.text);
    if (!current || current.cards.length >= POCKET_CARDS || current.tokens + cost > POCKET_TOKENS) {
      current = {cards: [], tokens: 0};
      pockets.push(current);
    }
    current.cards.push(card);
    current.tokens += cost;
  }
  return pockets.filter(pocket => pocket.cards.length);
}

const weight = card => (card.kind === 'constraint' ? 2 : card.kind === 'decision' ? 1.5 : card.kind === 'question' ? 0.5 : 1);

// The compressed form of a pocket: the statements that constrain future work first, then
// whatever else fits. This is what the archive is searched on and what is read by default.
export function digestOf(cards) {
  const ranked = [...cards].sort((a, b) => weight(b) - weight(a));
  const lines = [];
  let used = 0;
  for (const card of ranked) {
    const line = card.text.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const cost = estimateTokens(line);
    if (used + cost > DIGEST_TOKENS) { if (!lines.length) lines.push(line.slice(0, 260)); break; }
    used += cost;
    lines.push(line);
  }
  return lines.join(' · ');
}

// Replaces everything stored for one conversation. Re-packing a whole conversation is
// cheap and keeps the archive consistent with an edited or truncated transcript, rather
// than accumulating pockets for messages that no longer exist.
export function rememberConversation(dirs, conversationId, title, history) {
  if (!conversationId) return 0;
  return withArchive(dirs, db => {
    const cards = itemize(history || []);
    dropConversation(db, conversationId);
    const pockets = packPockets(cards);
    const insert = db.prepare('INSERT OR REPLACE INTO pockets (id, conversation, title, seq, time, kind, digest, codec, body, cards, tokens, raw_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const index = db.prepare('INSERT INTO pockets_fts (pocket_id, body) VALUES (?, ?)');
    const dict = latestDictionary(db);
    pockets.forEach((pocket, seq) => {
      const id = `${conversationId}:${seq}`;
      const text = pocket.cards.map(card => card.text).join('\n');
      const {codec, body} = packBody(text, dict);
      const digest = digestOf(pocket.cards);
      const kind = pocket.cards.some(card => card.kind === 'constraint') ? 'constraint'
        : pocket.cards.some(card => card.kind === 'decision') ? 'decision' : 'context';
      const time = pocket.cards.map(card => card.time).filter(Boolean).sort().at(-1) || '';
      insert.run(id, conversationId, title || '', seq, time, kind, digest, codec, body, pocket.cards.length, pocket.tokens, Buffer.byteLength(text, 'utf8'));
      // Index the digest plus every stemmed term in the span, so a pocket is findable by
      // any wording it contains even though only its digest is normally read.
      const expanded = [...new Set(pocket.cards.flatMap(card => card.terms || []))].join(' ');
      index.run(id, `${digest}\n${expanded}`);
    });
    return pockets.length;
  }, 0);
}

function dropConversation(db, conversationId) {
  db.prepare('DELETE FROM pockets_fts WHERE pocket_id IN (SELECT id FROM pockets WHERE conversation = ?)').run(conversationId);
  db.prepare('DELETE FROM pockets WHERE conversation = ?').run(conversationId);
}

export function forgetConversation(dirs, conversationId) {
  if (!conversationId) return false;
  return withArchive(dirs, db => { dropConversation(db, conversationId); return true; }, false);
}

// --- dictionary lifecycle -------------------------------------------------------------

function loadDictionary(db, id) {
  if (!id) return null;
  const row = db.prepare('SELECT body FROM dictionaries WHERE id = ?').get(id);
  return row ? Buffer.from(row.body) : null;
}

function latestDictionary(db) {
  const row = db.prepare('SELECT id, body FROM dictionaries ORDER BY id DESC LIMIT 1').get();
  return row ? {id: row.id, body: Buffer.from(row.body)} : null;
}

// A dictionary is only useful once there is a corpus to learn from, and it only pays for
// itself if it is trained on what the archive actually holds. Retraining writes a NEW
// dictionary rather than replacing the old one, so every pocket already written stays
// readable; `repackArchive` then moves pockets onto it at leisure.
export function trainArchiveDictionary(dirs, {minPockets = 8} = {}) {
  return withArchive(dirs, db => {
    const rows = db.prepare('SELECT codec, body FROM pockets').all();
    if (rows.length < minPockets) return null;
    const texts = [];
    for (const row of rows) {
      const text = unpackBody(row.codec, row.body, id => loadDictionary(db, id));
      if (text) texts.push(text);
    }
    if (!texts.length) return null;
    const body = trainDictionary(texts);
    if (!body.length) return null;
    const info = db.prepare('INSERT INTO dictionaries (created, body, samples, bytes) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), body, texts.length, body.length);
    return {id: Number(info.lastInsertRowid), bytes: body.length, samples: texts.length};
  }, null);
}

// Re-packs pockets against the newest dictionary. Each pocket is opened with its own
// recorded codec and only rewritten when the new packing is genuinely smaller, so this is
// always safe to run and can never make the archive larger.
export function repackArchive(dirs, {limit = 5000} = {}) {
  return withArchive(dirs, db => {
    const dict = latestDictionary(db);
    if (!dict) return {repacked: 0, before: 0, after: 0};
    const rows = db.prepare('SELECT id, codec, body FROM pockets LIMIT ?').all(limit);
    const update = db.prepare('UPDATE pockets SET codec = ?, body = ? WHERE id = ?');
    let repacked = 0, before = 0, after = 0;
    for (const row of rows) {
      const current = Buffer.from(row.body);
      before += current.length;
      if (parseCodec(row.codec).dictionary === dict.id) { after += current.length; continue; }
      const text = unpackBody(row.codec, current, id => loadDictionary(db, id));
      if (text === null) { after += current.length; continue; }
      const packed = packBody(text, dict);
      if (packed.body.length < current.length) {
        update.run(packed.codec, packed.body, row.id);
        after += packed.body.length;
        repacked++;
      } else { after += current.length; }
    }
    // Dictionaries no pocket references any more are dead weight in the project folder.
    db.prepare(`DELETE FROM dictionaries WHERE id != ? AND id NOT IN (
      SELECT CAST(substr(codec, instr(codec, ':') + 1) AS INTEGER) FROM pockets
      WHERE codec LIKE 'zdict:%' OR codec LIKE 'bdict:%')`).run(dict.id);
    return {repacked, before, after, dictionary: dict.id};
  }, {repacked: 0, before: 0, after: 0});
}

// FTS5 treats a bare word list as a phrase and chokes on its own operators, so the query is
// rebuilt from the same stemmed terms memory.mjs uses. Those are [a-z0-9_] only, which is
// safe to interpolate and keeps recall consistent between the two layers.
export function buildMatchQuery(query) {
  const words = terms(String(query || '')).filter(word => /^[a-z0-9_]+$/.test(word));
  if (!words.length) return null;
  return words.map(word => `"${word}"*`).join(' OR ');
}

function recencyBoost(time) {
  const when = Date.parse(time || '');
  if (Number.isNaN(when)) return 0;
  const days = (Date.now() - when) / 86400000;
  return days <= 1 ? 1 : days <= 7 ? 0.5 : days <= 30 ? 0.2 : 0;
}

// Finds pockets across the project's conversations, most relevant first. Only digests are
// returned; no body is unpacked until a caller asks for one.
// `excludeConversation` skips the conversation already in the prompt, so long-term recall
// adds what the live transcript cannot supply instead of duplicating it.
export function recall(dirs, query, {limit = 6, excludeConversation = null} = {}) {
  const match = buildMatchQuery(query);
  if (!match) return [];
  return withArchive(dirs, db => {
    const rows = db.prepare(`
      SELECT p.id, p.conversation, p.title, p.seq, p.time, p.kind, p.digest, p.codec, p.cards, p.tokens, bm25(pockets_fts) AS rank
      FROM pockets_fts JOIN pockets p ON p.id = pockets_fts.pocket_id
      WHERE pockets_fts MATCH ? ${excludeConversation ? 'AND p.conversation != ?' : ''}
      ORDER BY rank LIMIT ?
    `).all(...(excludeConversation ? [match, excludeConversation, limit * 4] : [match, limit * 4]));
    // bm25 returns lower-is-better. Prefer pockets that settle something over pockets of
    // passing remarks, and newer statements over older ones, matching how the planner ranks.
    return rows
      .map(row => ({...row, expanded: false, score: -row.rank + (row.kind === 'constraint' ? 1.5 : row.kind === 'decision' ? 0.75 : 0) + recencyBoost(row.time)}))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }, []);
}

// ---------------------------------------------------------------------------------------
// The associative index — the "mapper" layer.
//
// Keyword search answers "which pocket contains these words". It cannot answer "what else
// turned out to matter whenever this came up", and that second question is the one that
// carries a conversation which has moved onto new ground. A MUD client has the same split:
// the scrollback is searchable text, but the mapper is a *derived* graph built from the
// stream, and you navigate it rather than grep it.
//
// Two pockets are linked when they share terms that are rare across the archive. Rarity is
// what makes the link mean something: every pocket shares "the" and "file", so matching on
// those links everything to everything and the graph carries no information at all.
const LINK_RARITY = 0.18;   // a term in more than this share of pockets is too common to link on
const LINK_CEILING_MIN = 4; // ...but never so strict that a small archive can link nothing
const LINKS_PER_POCKET = 6; // keeping only the strongest few stops the graph becoming dense

export function buildLinks(dirs, {minShared = 2} = {}) {
  return withArchive(dirs, db => {
    const rows = db.prepare('SELECT id, digest, title, kind FROM pockets').all();
    if (rows.length < 2) return {pockets: rows.length, links: 0};

    // One inverted index, built once. Comparing every pocket against every other would be
    // quadratic; walking each term's posting list only compares pockets that can possibly
    // be linked, and the rarity cap keeps those lists short by construction.
    const postings = new Map();
    for (const row of rows) {
      for (const term of new Set(terms(`${row.title || ''} ${row.digest}`))) {
        if (!postings.has(term)) postings.set(term, []);
        postings.get(term).push(row.id);
      }
    }

    // The rarity ceiling is a share of the archive, but a share of a *small* archive is
    // smaller than a cluster: with a dozen pockets, `n * 0.18` is two, so the terms that
    // actually define a topic get excluded for appearing in three of its pockets and the
    // graph comes out empty. The floor keeps a young archive navigable; the fraction takes
    // over once there is enough material for it to mean something.
    const ceiling = Math.max(LINK_CEILING_MIN, Math.floor(rows.length * LINK_RARITY));
    const pairs = new Map();
    for (const [, ids] of postings) {
      if (ids.length < 2 || ids.length > ceiling) continue;
      // Rarer terms say more, so a term shared by two pockets counts for more than one
      // shared by twenty.
      const value = 1 / Math.log2(1 + ids.length);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = ids[i] < ids[j] ? `${ids[i]}\u0000${ids[j]}` : `${ids[j]}\u0000${ids[i]}`;
          const seen = pairs.get(key) || {weight: 0, shared: 0};
          seen.weight += value;
          seen.shared++;
          pairs.set(key, seen);
        }
      }
    }

    // Keep only each pocket's strongest neighbours. A pocket linked to two hundred others
    // is linked to nothing useful, and traversing it would flood the budget.
    const best = new Map();
    for (const [key, {weight, shared}] of pairs) {
      if (shared < minShared) continue;
      const [a, b] = key.split('\u0000');
      for (const [from, to] of [[a, b], [b, a]]) {
        if (!best.has(from)) best.set(from, []);
        best.get(from).push({to, weight});
      }
    }

    db.exec('DELETE FROM pocket_links');
    const insert = db.prepare('INSERT OR REPLACE INTO pocket_links (a, b, weight) VALUES (?, ?, ?)');
    let written = 0;
    for (const [from, edges] of best) {
      edges.sort((x, y) => y.weight - x.weight);
      for (const edge of edges.slice(0, LINKS_PER_POCKET)) { insert.run(from, edge.to, edge.weight); written++; }
    }
    return {pockets: rows.length, links: written};
  }, {pockets: 0, links: 0});
}

// Walks outward from pockets already in hand. `seeds` are usually whatever the chip is
// holding, so this asks "given where we already are, what neighbours on the map?" — which
// is exactly the question a fresh topic cannot ask of a keyword index.
export function linkedPockets(dirs, seeds, {limit = 4} = {}) {
  const ids = [...new Set((seeds || []).filter(Boolean))];
  if (!ids.length) return [];
  return withArchive(dirs, db => {
    const holes = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT p.id, p.conversation, p.title, p.seq, p.time, p.kind, p.digest, p.codec, p.cards, p.tokens,
             SUM(l.weight) AS weight
      FROM pocket_links l JOIN pockets p ON p.id = l.b
      WHERE l.a IN (${holes}) AND l.b NOT IN (${holes})
      GROUP BY l.b ORDER BY weight DESC LIMIT ?
    `).all(...ids, ...ids, limit);
    return rows.map(row => ({
      ...row,
      expanded: false,
      via: 'links',
      score: row.weight + (row.kind === 'constraint' ? 1.5 : row.kind === 'decision' ? 0.75 : 0),
    }));
  }, []);
}

// Unpacks one pocket with the algorithm it recorded. This is the only path that pays the
// full cost of a span, and the only path that decompresses anything.
export function expandPocket(dirs, pocketId) {
  if (!pocketId) return null;
  return withArchive(dirs, db => {
    const row = db.prepare('SELECT id, conversation, title, time, kind, digest, codec, body FROM pockets WHERE id = ?').get(pocketId);
    if (!row) return null;
    const text = unpackBody(row.codec, row.body, id => loadDictionary(db, id));
    if (text === null) return null;
    return {id: row.id, conversation: row.conversation, title: row.title, time: row.time, kind: row.kind, digest: row.digest, codec: row.codec, expanded: true, text};
  });
}

export function archiveStats(dirs) {
  return withArchive(dirs, db => {
    const row = db.prepare('SELECT COUNT(*) AS pockets, COUNT(DISTINCT conversation) AS conversations, SUM(cards) AS cards, SUM(LENGTH(body)) AS stored, SUM(raw_bytes) AS raw FROM pockets').get();
    const codecs = db.prepare('SELECT codec, COUNT(*) AS pockets FROM pockets GROUP BY codec').all();
    return {
      available: true,
      pockets: row.pockets || 0,
      conversations: row.conversations || 0,
      cards: row.cards || 0,
      storedBytes: row.stored || 0,
      rawBytes: row.raw || 0,
      codecs: Object.fromEntries(codecs.map(entry => [entry.codec, entry.pockets])),
    };
  }, {available: false, pockets: 0, conversations: 0, cards: 0, storedBytes: 0, rawBytes: 0, codecs: {}});
}

// Renders recalled pockets as a prompt block inside a token budget, unpacking the strongest
// matches and leaving the rest in their compressed digest form. That is the point of the
// pocket: the archive can be wide while the prompt stays small.
// Kept here rather than in memory.mjs so the planner has no knowledge of this layer.
export function renderRecall(dirs, pockets, {budget = 700, expandLimit = 2} = {}) {
  if (!pockets?.length) return null;
  const lines = [];
  let used = 0;
  let unpacked = 0;
  for (const pocket of pockets) {
    const label = pocket.title || 'an earlier conversation';
    const digestLine = `- From ${label}: ${pocket.digest}`;
    const digestCost = estimateTokens(digestLine);
    if (used + digestCost > budget) break;
    let line = digestLine, cost = digestCost;
    // Try the full span first; fall back to the digest when it will not fit in the budget
    // or when the pocket was packed by an algorithm this build cannot open.
    if (unpacked < expandLimit) {
      const full = expandPocket(dirs, pocket.id);
      if (full?.text) {
        const fullLine = `- From ${label}:\n  ${full.text.replace(/\n/g, '\n  ')}`;
        const fullCost = estimateTokens(fullLine);
        if (used + fullCost <= budget) { line = fullLine; cost = fullCost; unpacked++; }
      }
    }
    used += cost;
    lines.push(line);
  }
  if (!lines.length) return null;
  return `Relevant notes recalled from earlier conversations in this project. They may be out of date; the user's latest message takes priority.\n${lines.join('\n')}`;
}
