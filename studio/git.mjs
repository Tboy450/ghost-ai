// Thin, guarded wrapper around the `git` CLI, scoped to a single project folder.
// Every function takes `root` (the project's folder) and shells out with cwd=root;
// no shell interpolation is used (spawnSync argv arrays only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(root, args, env) {
  const options = {cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024};
  if (env) options.env = {...process.env, ...env};
  const result = spawnSync('git', args, options);
  if (result.error) throw Object.assign(new Error(`git not available: ${result.error.message}`), {status: 500});
  return result;
}

function fail(message, status = 400) { return Object.assign(new Error(message), {status}); }

export function isRepo(root) {
  return run(root, ['rev-parse', '--is-inside-work-tree']).status === 0;
}

function ensureRepo(root) {
  if (!isRepo(root)) throw fail('This project folder is not a Git repository yet.', 409);
}

export function currentBranch(root) {
  ensureRepo(root);
  const result = run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

export function status(root) {
  ensureRepo(root);
  const result = run(root, ['status', '--porcelain=v1']);
  const files = result.stdout.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3).replace(/^"|"$/g, ''),
  }));
  return {branch: currentBranch(root), clean: files.length === 0, files};
}

export function diff(root, file) {
  ensureRepo(root);
  const args = ['diff', '--no-color', 'HEAD', '--'];
  if (file) args.push(file);
  const result = run(root, args);
  if (result.status !== 0 && result.status !== 1) throw fail(result.stderr || 'git diff failed.', 500);
  return result.stdout;
}

export function log(root, limit = 25) {
  ensureRepo(root);
  const format = '%H%x1f%h%x1f%an%x1f%aI%x1f%s';
  const result = run(root, ['log', `-n${Math.min(Math.max(limit, 1), 200)}`, `--format=${format}`]);
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [hash, short, author, date, subject] = line.split('\x1f');
    return {hash, short, author, date, subject};
  });
}

export function commit(root, message, {authorName = 'Ghost', authorEmail = 'ghost@local'} = {}) {
  ensureRepo(root);
  if (typeof message !== 'string' || !message.trim()) throw fail('Write a commit message.');
  run(root, ['add', '-A']);
  const staged = run(root, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) throw fail('There is nothing to commit.', 409);
  const result = run(root, ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', message]);
  if (result.status !== 0) throw fail(result.stderr || 'Commit failed.', 500);
  return {hash: currentHash(root)};
}

export function currentHash(root) {
  return run(root, ['rev-parse', 'HEAD']).stdout.trim();
}

export function push(root, {remote = 'origin', branch} = {}) {
  ensureRepo(root);
  const target = branch || currentBranch(root);
  const result = run(root, ['push', remote, `HEAD:${target}`]);
  if (result.status !== 0) throw fail(result.stderr || 'Push failed. Check your remote and credentials.', 500);
  return {remote, branch: target, output: result.stdout.trim() || result.stderr.trim()};
}

// Restores a single file's contents from an earlier commit without touching the rest
// of the working tree (safer than a hard reset). Returns the restored text; the caller
// is responsible for writing it through the normal saveFile() path if desired.
export function fileAt(root, hash, file) {
  ensureRepo(root);
  const result = run(root, ['show', `${hash}:${file}`]);
  if (result.status !== 0) throw fail('That file did not exist at that commit.', 404);
  return result.stdout;
}

// Creates an isolated worktree on a new/reused branch so automated changes (e.g. from
// selfimprove.mjs) never touch the caller's live working directory or its uncommitted
// edits. Always pair with removeWorktree() in a `finally` block.
export function addWorktree(root, worktreeDir, branch) {
  ensureRepo(root);
  // If a previous run was killed part way through, git still has its temp directory
  // registered against this branch even though the directory is long gone. Every later
  // run then dies on "branch is already used by worktree", permanently, until someone
  // knows to run `git worktree prune` by hand. Clear the stale registration first.
  run(root, ['worktree', 'prune']);
  let result = run(root, ['worktree', 'add', '-B', branch, worktreeDir, 'HEAD']);
  if (result.status !== 0 && /already used by worktree/i.test(result.stderr || '')) {
    // Still held after a prune, so the recorded directory is really there. Only a
    // directory that has vanished may be cleared: force-removing a live one destroys
    // whatever is running in it, and these branches are shared, so the holder can be a
    // legitimate concurrent run — including an outer run whose own test suite is what
    // called us. That mistake deleted a running update out from under itself.
    const stale = (result.stderr.match(/worktree at '([^']+)'/) || [])[1];
    if (stale && !fs.existsSync(stale)) {
      run(root, ['worktree', 'remove', stale, '--force']);
      run(root, ['worktree', 'prune']);
      result = run(root, ['worktree', 'add', '-B', branch, worktreeDir, 'HEAD']);
    } else if (stale) {
      throw fail(`Another update is already using the branch ${branch} in ${stale}. Wait for it to finish, or delete that folder if nothing is running.`, 409);
    }
  }
  if (result.status !== 0) throw fail(result.stderr || 'Could not create a worktree for the update branch.', 500);
  return branch;
}

export function removeWorktree(root, worktreeDir) {
  run(root, ['worktree', 'remove', worktreeDir, '--force']);
  // Prune as well, so a directory that was already deleted underneath git does not stay
  // registered and block the next run.
  run(root, ['worktree', 'prune']);
}

// Records brand-new files as "intent to add" so `git diff` includes them. Without this
// a proposal that only adds files produces an empty diff and looks like it changed nothing.
export function stageIntentToAdd(root) {
  ensureRepo(root);
  run(root, ['add', '-A', '-N']);
}

// --- Checkpoints -----------------------------------------------------------------
// A checkpoint is a named snapshot of the working tree you can come back to, including
// uncommitted edits. It is NOT a commit: `git stash create` writes a commit object and
// leaves the working tree untouched, so taking one never interrupts what you are doing.
// A ref under refs/ghost/checkpoints/ keeps that object from being garbage-collected,
// and the names and times live in .ghost/checkpoints.json.
const CHECKPOINT_FILE = 'checkpoints.json';
const CHECKPOINT_REF = 'refs/ghost/checkpoints';
// Ghost's own folder is deliberately outside every checkpoint. It holds the checkpoint
// store itself, so including it would mean restoring an old checkpoint deletes every
// checkpoint taken since - destroying the escape route on the way out.
// The `top` magic anchors these at the repository root: a snapshot covers the whole
// repository, so a pathspec relative to the current folder would compare a different
// (and possibly empty) set of files than the one that was saved.
const CHECKPOINT_SCOPE = [':/', ':(top,exclude).ghost', ':(top,exclude).ghost/**'];
// A checkpoint must return the file exactly as it was, byte for byte. Git's line-ending
// conversion is on by default on Windows, which would rewrite CRLF to LF on the way in
// and back again on the way out - silently changing files the user never edited.
const VERBATIM = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

function checkpointStore(dirs) { return path.join(dirs.ghost, CHECKPOINT_FILE); }

// A project folder can sit below the repository root (Ghost's own workspace does), and
// checkpoints are repository-wide, so paths coming back from git are relative to here.
function repoRoot(root) {
  const found = run(root, ['rev-parse', '--show-toplevel']);
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : root;
}

function readCheckpoints(dirs) {
  try { return JSON.parse(fs.readFileSync(checkpointStore(dirs), 'utf8')); }
  catch { return []; }
}

function writeCheckpoints(dirs, list) {
  fs.mkdirSync(dirs.ghost, {recursive: true});
  fs.writeFileSync(checkpointStore(dirs), JSON.stringify(list, null, 2));
  return list;
}

// Writes the current working tree into git's object store using a throwaway index, so
// the real index is never touched and files you have not staged (or never committed)
// are still captured. `git stash create` cannot be used here: it refuses to run when
// any intent-to-add entry is present, which is exactly the brand-new-file case.
function writeWorktreeTree(root) {
  const tempIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cp-')), 'index');
  const env = {GIT_INDEX_FILE: tempIndex};
  try {
    // No pathspec: naming a path that .gitignore covers is a fatal error for `git add`,
    // and .ghost/ is gitignored in every real project - so it cannot be excluded here.
    const added = run(root, [...VERBATIM, 'add', '-A'], env);
    if (added.status !== 0) throw fail(added.stderr || 'Could not read the working tree.', 500);
    // Dropped from the index instead. `git rm --cached` does no ignore checking, so it
    // can name the path that `git add` refused to.
    run(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.ghost'], env);
    const tree = run(root, ['write-tree'], env);
    if (tree.status !== 0) throw fail(tree.stderr || 'Could not snapshot the working tree.', 500);
    return tree.stdout.trim();
  } finally {
    fs.rmSync(path.dirname(tempIndex), {recursive: true, force: true});
  }
}

function snapshotTree(root, message) {
  const tree = writeWorktreeTree(root);
  const args = ['commit-tree', tree, '-m', message];
  const head = run(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.status === 0) args.push('-p', head.stdout.trim());
  const made = run(root, args, {
    GIT_AUTHOR_NAME: 'Ghost', GIT_AUTHOR_EMAIL: 'ghost@local',
    GIT_COMMITTER_NAME: 'Ghost', GIT_COMMITTER_EMAIL: 'ghost@local',
  });
  if (made.status !== 0) throw fail(made.stderr || 'Could not save the snapshot.', 500);
  return made.stdout.trim();
}

export function createCheckpoint(root, dirs, name) {
  ensureRepo(root);
  if (typeof name !== 'string' || !name.trim()) throw fail('Give the checkpoint a name.');
  const label = name.trim().slice(0, 120);

  const hash = snapshotTree(root, `Ghost checkpoint: ${label}`);
  const id = `${Date.now().toString(36)}-${hash.slice(0, 8)}`;
  const ref = `${CHECKPOINT_REF}/${id}`;
  const kept = run(root, ['update-ref', ref, hash]);
  if (kept.status !== 0) throw fail(kept.stderr || 'Could not save the checkpoint.', 500);

  const entry = {
    id, name: label, hash, ref,
    time: new Date().toISOString(),
    branch: currentBranch(root),
    files: status(root).files.length,
  };
  writeCheckpoints(dirs, [entry, ...readCheckpoints(dirs)].slice(0, 100));
  return entry;
}

// Only lists checkpoints whose object is still present, so a pruned or hand-deleted
// ref cannot leave a dead entry that fails the moment you try to restore it.
export function listCheckpoints(root, dirs) {
  ensureRepo(root);
  const alive = readCheckpoints(dirs).filter(entry =>
    run(root, ['cat-file', '-e', `${entry.hash}^{commit}`]).status === 0);
  if (alive.length !== readCheckpoints(dirs).length) writeCheckpoints(dirs, alive);
  return alive;
}

function findCheckpoint(root, dirs, id) {
  const found = listCheckpoints(root, dirs).find(entry => entry.id === id);
  if (!found) throw fail('That checkpoint no longer exists.', 404);
  return found;
}

// What restoring would actually do, so it can be shown before anything is touched.
// The comparison is tree-to-tree rather than against the working copy, because a plain
// `git diff <commit>` cannot see files that were never added to git - and a brand-new
// file is precisely what a restore needs to warn you it will delete.
export function previewRestore(root, dirs, id) {
  const entry = findCheckpoint(root, dirs, id);
  const result = run(root, ['diff', '--name-status', entry.hash, writeWorktreeTree(root), '--', ...CHECKPOINT_SCOPE]);
  if (result.status !== 0 && result.status !== 1) throw fail(result.stderr || 'Could not compare that checkpoint.', 500);
  const changes = result.stdout.split('\n').filter(Boolean).map(line => {
    const [code, ...rest] = line.split('\t');
    const file = rest.join('\t');
    // The diff runs checkpoint -> now, so "added since" means restoring removes it.
    if (code.startsWith('A')) return {path: file, action: 'remove', detail: 'added since the checkpoint'};
    if (code.startsWith('D')) return {path: file, action: 'restore', detail: 'deleted since the checkpoint'};
    return {path: file, action: 'overwrite', detail: 'changed since the checkpoint'};
  });
  return {checkpoint: entry, changes, clean: changes.length === 0};
}

export function restoreCheckpoint(root, dirs, id) {
  const {checkpoint, changes} = previewRestore(root, dirs, id);

  // Restoring discards current work, so snapshot it first. Without this the one
  // operation that exists to undo a mistake is itself impossible to undo.
  const safety = createCheckpoint(root, dirs, `Before restoring "${checkpoint.name}"`);

  // Restore only the files the preview named. `git checkout <commit> -- :/` rewrites
  // every file in the tree, including ones that never changed - which is slower, and
  // fails outright if any unrelated file happens to be locked by another program.
  // `git restore --worktree` is used rather than `git checkout`, because checkout also
  // stages what it writes, which would silently add the restored files to work the user
  // had already staged for a commit.
  const top = repoRoot(root);
  const toWrite = changes.filter(c => c.action !== 'remove').map(c => `:(top,literal)${c.path}`);
  for (let i = 0; i < toWrite.length; i += 200) {
    const batch = toWrite.slice(i, i + 200);
    const applied = run(root, [...VERBATIM, 'restore', '--source', checkpoint.hash, '--worktree', '--', ...batch]);
    if (applied.status !== 0) throw fail(applied.stderr || 'Could not restore that checkpoint.', 500);
  }

  // Checkout writes files but never removes ones the checkpoint lacks, so anything
  // added since would survive and quietly corrupt the restored state. Diff paths are
  // repository-relative, so they resolve against the repository root, not the project
  // folder, which may sit below it.
  const removed = [];
  for (const change of changes.filter(c => c.action === 'remove')) {
    const full = path.join(top, change.path);
    if (fs.existsSync(full)) { fs.rmSync(full, {force: true}); removed.push(change.path); }
  }
  return {checkpoint, safety, restored: changes.length, removed};
}

export function deleteCheckpoint(root, dirs, id) {
  const entry = findCheckpoint(root, dirs, id);
  run(root, ['update-ref', '-d', entry.ref]);
  writeCheckpoints(dirs, readCheckpoints(dirs).filter(item => item.id !== id));
  return {id, name: entry.name};
}

// Throws away every uncommitted change in a worktree, returning it to its last commit.
// Used between self-improvement repair attempts so a failed proposal cannot leak into
// the next one and get blamed on it.
export function resetWorktree(worktreeDir) {
  ensureRepo(worktreeDir);
  run(worktreeDir, ['reset', '--hard', 'HEAD']);
  run(worktreeDir, ['clean', '-fd']);
}

