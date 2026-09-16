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

// Picks the algorithm that is actually smallest for this span rather than assuming one.
// Short pockets are common and compression framing can make them larger, so `raw` wins there.
export function packBody(text) {
  let best = null;
  for (const name of CODEC_ORDER) {
    let packed;
    try { packed = CODECS[name].pack(text); } catch { continue; }
    if (!best || packed.length < best.body.length) best = {codec: name, body: packed};
  }
  return best || {codec: 'raw', body: Buffer.from(text, 'utf8')};
}

// Unpacks using whatever algorithm the pocket recorded. An unknown or damaged pocket
// returns null so the caller can fall back to its digest.
export function unpackBody(codec, body) {
  const algorithm = CODECS[codec];
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
    pockets.forEach((pocket, seq) => {
      const id = `${conversationId}:${seq}`;
      const text = pocket.cards.map(card => card.text).join('\n');
      const {codec, body} = packBody(text);
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

// Unpacks one pocket with the algorithm it recorded. This is the only path that pays the
// full cost of a span, and the only path that decompresses anything.
export function expandPocket(dirs, pocketId) {
  if (!pocketId) return null;
  return withArchive(dirs, db => {
    const row = db.prepare('SELECT id, conversation, title, time, kind, digest, codec, body FROM pockets WHERE id = ?').get(pocketId);
    if (!row) return null;
    const text = unpackBody(row.codec, row.body);
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
