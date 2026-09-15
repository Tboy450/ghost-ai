// Thin, guarded wrapper around the `git` CLI, scoped to a single project folder.
// Every function takes `root` (the project's folder) and shells out with cwd=root;
// no shell interpolation is used (spawnSync argv arrays only).
import { spawnSync } from 'node:child_process';

function run(root, args) {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024});
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
  const result = run(root, ['worktree', 'add', '-B', branch, worktreeDir, 'HEAD']);
  if (result.status !== 0) throw fail(result.stderr || 'Could not create a worktree for the update branch.', 500);
  return branch;
}

export function removeWorktree(root, worktreeDir) {
  run(root, ['worktree', 'remove', worktreeDir, '--force']);
}

