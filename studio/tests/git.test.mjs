import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as git from '../git.mjs';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-git-'));
  const run = args => spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
  run(['init', '-q']);
  run(['config', 'user.email', 'test@local']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.md'), 'first version\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'initial']);
  return dir;
}

test('isRepo distinguishes git repos from plain folders', () => {
  const repo = makeRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-plain-'));
  try {
    assert.equal(git.isRepo(repo), true);
    assert.equal(git.isRepo(plain), false);
    assert.throws(() => git.status(plain), e => e.status === 409);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(plain, {recursive: true, force: true});
  }
});

test('status, diff, commit, and log reflect a working-tree change', () => {
  const repo = makeRepo();
  try {
    assert.equal(git.status(repo).clean, true);
    fs.writeFileSync(path.join(repo, 'a.md'), 'second version\n');
    const dirtyStatus = git.status(repo);
    assert.equal(dirtyStatus.clean, false);
    assert.ok(dirtyStatus.files.some(f => f.path === 'a.md'));
    assert.match(git.diff(repo), /second version/);
    const committed = git.commit(repo, 'Update a.md');
    assert.match(committed.hash, /^[0-9a-f]{40}$/);
    assert.equal(git.status(repo).clean, true);
    const log = git.log(repo, 5);
    assert.equal(log.length, 2);
    assert.equal(log[0].subject, 'Update a.md');
    assert.throws(() => git.commit(repo, 'nothing to commit'), e => e.status === 409);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

test('fileAt reads a file as it existed at an earlier commit', () => {
  const repo = makeRepo();
  try {
    const firstHash = git.log(repo, 1)[0].hash;
    fs.writeFileSync(path.join(repo, 'a.md'), 'second version\n');
    git.commit(repo, 'second');
    assert.equal(git.fileAt(repo, firstHash, 'a.md'), 'first version\n');
    assert.throws(() => git.fileAt(repo, firstHash, 'missing.md'), e => e.status === 404);
  } finally {
    fs.rmSync(repo, {recursive: true, force: true});
  }
});

test('addWorktree recovers when a killed run left its worktree registered', () => {
  const repo = makeRepo();
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-worktree-stale-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-worktree-next-'));
  fs.rmSync(first, {recursive: true, force: true});
  fs.rmSync(second, {recursive: true, force: true});
  try {
    git.addWorktree(repo, first, 'ghost/self-update');
    // Exactly what a killed process leaves behind: the directory is gone but git still
    // has it registered against the branch. Before the fix this bricked every later run.
    fs.rmSync(first, {recursive: true, force: true});
    git.addWorktree(repo, second, 'ghost/self-update');
    assert.equal(git.currentBranch(second), 'ghost/self-update');
  } finally {
    git.removeWorktree(repo, second);
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(second, {recursive: true, force: true});
  }
});

// The stale-worktree recovery must never touch a worktree that is really there. An
// automated branch is shared, so the holder can be a legitimate concurrent run - and
// force-removing it deletes a running update's directory out from under it.
test('a live worktree on the same branch is reported, never deleted', () => {
  const repo = makeRepo();
  const held = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-held-'));
  fs.rmSync(held, {recursive: true, force: true});
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-second-'));
  fs.rmSync(second, {recursive: true, force: true});
  try {
    git.addWorktree(repo, held, 'ghost/self-update');
    fs.writeFileSync(path.join(held, 'work-in-progress.md'), 'do not delete me\n');
    assert.throws(() => git.addWorktree(repo, second, 'ghost/self-update'), /already using the branch/);
    assert.equal(fs.readFileSync(path.join(held, 'work-in-progress.md'), 'utf8'), 'do not delete me\n');
  } finally {
    try { git.removeWorktree(repo, held); } catch { /* cleanup */ }
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(held, {recursive: true, force: true});
    fs.rmSync(second, {recursive: true, force: true});
  }
});

test('addWorktree/removeWorktree isolate changes on a dedicated branch', () => {
  const repo = makeRepo();
  const originalBranch = git.currentBranch(repo);
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-worktree-'));
  fs.rmSync(worktreeDir, {recursive: true, force: true});
  try {
    git.addWorktree(repo, worktreeDir, 'ghost/self-update');
    fs.writeFileSync(path.join(worktreeDir, 'a.md'), 'from worktree\n');
    git.commit(worktreeDir, 'worktree change');
    // The original repo's working tree file is untouched by the worktree commit.
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'first version\n');
    assert.equal(git.currentBranch(repo), originalBranch);
    assert.equal(git.currentBranch(worktreeDir), 'ghost/self-update');
  } finally {
    git.removeWorktree(repo, worktreeDir);
    fs.rmSync(repo, {recursive: true, force: true});
    fs.rmSync(worktreeDir, {recursive: true, force: true});
  }
});

function ghostDirs(repo) { return {ghost: path.join(repo, '.ghost')}; }

// A checkpoint has to capture work you have NOT committed - that is the whole point of
// it. It must also leave the tree alone: taking one mid-edit should never interrupt you.
test('a checkpoint captures uncommitted work without disturbing the tree', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, 'a.md'), 'edited but not committed\n');
    fs.writeFileSync(path.join(repo, 'brand-new.md'), 'never committed at all\n');

    const mark = git.createCheckpoint(repo, dirs, 'before the risky part');
    assert.equal(mark.name, 'before the risky part');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'edited but not committed\n',
      'taking a checkpoint must not revert anything');
    assert.ok(fs.existsSync(path.join(repo, 'brand-new.md')), 'nor remove anything');

    fs.writeFileSync(path.join(repo, 'a.md'), 'ruined\n');
    fs.rmSync(path.join(repo, 'brand-new.md'));
    fs.writeFileSync(path.join(repo, 'added-later.md'), 'written after the checkpoint\n');

    const back = git.restoreCheckpoint(repo, dirs, mark.id);
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'edited but not committed\n',
      'the uncommitted edit comes back');
    assert.equal(fs.readFileSync(path.join(repo, 'brand-new.md'), 'utf8'), 'never committed at all\n',
      'a file deleted since the checkpoint comes back');
    assert.ok(!fs.existsSync(path.join(repo, 'added-later.md')),
      'a file added since the checkpoint is removed, or the restored state is not the checkpoint');
    assert.deepEqual(back.removed, ['added-later.md']);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Restoring throws away current work, so the one operation that exists to undo a
// mistake must itself be undoable.
test('restoring takes a safety checkpoint first, so a wrong restore is reversible', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, 'a.md'), 'the good state\n');
    const good = git.createCheckpoint(repo, dirs, 'good');
    fs.writeFileSync(path.join(repo, 'a.md'), 'work I forgot to save\n');

    const back = git.restoreCheckpoint(repo, dirs, good.id);
    assert.ok(back.safety?.id, 'a safety checkpoint is recorded');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'the good state\n');

    git.restoreCheckpoint(repo, dirs, back.safety.id);
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'work I forgot to save\n',
      'the work that the restore discarded is recoverable');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// The list is read from disk, so it survives a restart; and a preview must say what
// will happen before anything is touched.
test('checkpoints persist and preview what a restore would do', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, 'a.md'), 'v2\n');
    const mark = git.createCheckpoint(repo, dirs, 'v2 saved');
    fs.writeFileSync(path.join(repo, 'a.md'), 'v3\n');
    fs.writeFileSync(path.join(repo, 'extra.md'), 'new\n');

    const preview = git.previewRestore(repo, dirs, mark.id);
    assert.equal(preview.clean, false);
    const byPath = Object.fromEntries(preview.changes.map(c => [c.path, c.action]));
    assert.equal(byPath['a.md'], 'overwrite');
    assert.equal(byPath['extra.md'], 'remove');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'v3\n',
      'previewing must not change anything');

    assert.ok(git.listCheckpoints(repo, dirs).some(c => c.id === mark.id));
    assert.ok(fs.existsSync(path.join(dirs.ghost, 'checkpoints.json')), 'stored on disk, so it survives a restart');

    git.deleteCheckpoint(repo, dirs, mark.id);
    assert.ok(!git.listCheckpoints(repo, dirs).some(c => c.id === mark.id));
    assert.throws(() => git.previewRestore(repo, dirs, mark.id), e => e.status === 404);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('a checkpoint needs a name, and a clean tree is still restorable', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    assert.throws(() => git.createCheckpoint(repo, dirs, '   '), /name/i);
    const mark = git.createCheckpoint(repo, dirs, 'nothing changed yet');
    assert.equal(git.previewRestore(repo, dirs, mark.id).clean, true);
    fs.writeFileSync(path.join(repo, 'a.md'), 'changed after a clean checkpoint\n');
    git.restoreCheckpoint(repo, dirs, mark.id);
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'first version\n');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Every real project gitignores .ghost/, and naming a gitignored path in `git add` is
// a fatal error - which made checkpoints fail on real projects while passing in tests.
test('checkpoints work in a project that gitignores Ghost own folder', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.ghost/\n');
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'ignore ghost'], {cwd: repo});
    fs.mkdirSync(dirs.ghost, {recursive: true});
    fs.writeFileSync(path.join(dirs.ghost, 'providers.json'), '{"key":"secret"}');

    fs.writeFileSync(path.join(repo, 'a.md'), 'work in progress\n');
    const mark = git.createCheckpoint(repo, dirs, 'ignored-folder project');

    // The secret must not be inside the snapshot, and restoring must not roll the
    // checkpoint store itself backwards.
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', mark.hash], {cwd: repo, encoding: 'utf8'});
    assert.ok(!listed.stdout.includes('.ghost'), 'Ghost own folder must never enter a checkpoint');

    fs.writeFileSync(path.join(repo, 'a.md'), 'broken\n');
    const later = git.createCheckpoint(repo, dirs, 'taken after the first');
    git.restoreCheckpoint(repo, dirs, mark.id);
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'work in progress\n');
    assert.ok(git.listCheckpoints(repo, dirs).some(c => c.id === later.id),
      'restoring an old checkpoint must not delete newer ones');
    assert.equal(fs.readFileSync(path.join(dirs.ghost, 'providers.json'), 'utf8'), '{"key":"secret"}');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Ghost own workspace lives in a subfolder of the repository, so checkpoints must work
// when the project folder is not the repository root. A snapshot covers the whole
// repository; if the preview used folder-relative paths it would compare a different
// set of files and report "nothing changed" no matter what the user did.
test('checkpoints work when the project folder sits below the repository root', () => {
  const repo = makeRepo();
  const dirs = {ghost: path.join(repo, 'sub', '.ghost')};
  try {
    fs.mkdirSync(path.join(repo, 'sub'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'sub', 'inner.md'), 'inner v1\n');
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'add sub'], {cwd: repo});

    const sub = path.join(repo, 'sub');
    const mark = git.createCheckpoint(sub, dirs, 'from a subfolder');

    fs.writeFileSync(path.join(repo, 'a.md'), 'changed at the repository root\n');
    fs.writeFileSync(path.join(sub, 'added.md'), 'added in the subfolder\n');

    const preview = git.previewRestore(sub, dirs, mark.id);
    const byPath = Object.fromEntries(preview.changes.map(c => [c.path, c.action]));
    assert.equal(byPath['a.md'], 'overwrite', 'a change outside the project folder must still be seen');
    assert.equal(byPath['sub/added.md'], 'remove');

    const back = git.restoreCheckpoint(sub, dirs, mark.id);
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'first version\n');
    assert.ok(!fs.existsSync(path.join(sub, 'added.md')),
      'files added since must be removed, resolved against the repository root');
    assert.deepEqual(back.removed, ['sub/added.md']);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// A restore must touch exactly the files it said it would. Rewriting the whole tree
// also fails if any unrelated file is locked by another program, which on Windows is
// enough to make the feature unusable while the app itself is running.
test('a restore only touches the files its preview named', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, 'untouched.md'), 'do not rewrite me\n');
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'add untouched'], {cwd: repo});

    const mark = git.createCheckpoint(repo, dirs, 'baseline');
    const stamp = fs.statSync(path.join(repo, 'untouched.md')).mtimeMs;
    fs.writeFileSync(path.join(repo, 'a.md'), 'only this one changed\n');

    const preview = git.previewRestore(repo, dirs, mark.id);
    assert.deepEqual(preview.changes.map(c => c.path), ['a.md']);

    git.restoreCheckpoint(repo, dirs, mark.id);
    assert.equal(fs.statSync(path.join(repo, 'untouched.md')).mtimeMs, stamp,
      'a file that did not change must not be rewritten');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'first version\n');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Restoring must not touch what the user has staged. `git checkout <commit> -- <path>`
// updates the index as well as the worktree, which would quietly fold restored files
// into a commit the user was in the middle of preparing.
test('a restore leaves the staging area alone', () => {
  const repo = makeRepo();
  const dirs = ghostDirs(repo);
  try {
    fs.writeFileSync(path.join(repo, 'staged.md'), 'deliberately staged\n');
    spawnSync('git', ['add', 'staged.md'], {cwd: repo});

    // The checkpoint holds a version of a.md that differs from the last commit, so a
    // restore that wrongly staged its work would show up as an extra cached change.
    fs.writeFileSync(path.join(repo, 'a.md'), 'work in progress\n');
    const mark = git.createCheckpoint(repo, dirs, 'with something staged');
    const before = spawnSync('git', ['diff', '--cached', '--name-only'], {cwd: repo, encoding: 'utf8'}).stdout;

    fs.writeFileSync(path.join(repo, 'a.md'), 'changed again\n');
    git.restoreCheckpoint(repo, dirs, mark.id);

    const after = spawnSync('git', ['diff', '--cached', '--name-only'], {cwd: repo, encoding: 'utf8'}).stdout;
    assert.equal(after, before, 'the staged file list must be identical after a restore');
    assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'work in progress\n');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// The whole point of the review is that you can understand what changed without
// reading a diff, so these assert on the words it produces, not on its shape.
test('the review says what changed in each file, in words', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'tools.mjs'), 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n');
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'tools'], {cwd: repo});

    // one function gained a line, one was removed, one is brand new
    fs.writeFileSync(path.join(repo, 'tools.mjs'), 'export function alpha() {\n  const extra = 0;\n  return 1 + extra;\n}\n\nexport function gamma() {\n  return 3;\n}\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), '# Notes\n\nsomething new\n');

    const review = git.reviewChanges(repo);
    assert.equal(review.clean, false);

    const tools = review.files.find(f => f.path === 'tools.mjs');
    assert.equal(tools.change, 'edited');
    assert.ok(tools.notes.includes('adds gamma'), `expected "adds gamma" in ${JSON.stringify(tools.notes)}`);
    assert.ok(tools.notes.includes('removes beta'), `expected "removes beta" in ${JSON.stringify(tools.notes)}`);
    assert.ok(tools.lines.added > 0 && tools.lines.removed > 0);

    const notes = review.files.find(f => f.path === 'notes.md');
    assert.equal(notes.change, 'added');
    assert.equal(notes.lines.added, 3, 'a new file counts all of its lines as added');
    assert.match(notes.summary, /New file, 3 lines/);

    assert.match(review.headline, /1 file edited/);
    assert.match(review.headline, /1 file added/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('the review reports a deleted file as deleted, not as an empty edit', () => {
  const repo = makeRepo();
  try {
    fs.rmSync(path.join(repo, 'a.md'));
    const review = git.reviewChanges(repo);
    const gone = review.files.find(f => f.path === 'a.md');
    assert.equal(gone.change, 'deleted');
    assert.equal(gone.summary, 'Deleted.');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('the review is silent when nothing has changed', () => {
  const repo = makeRepo();
  try {
    const review = git.reviewChanges(repo);
    assert.equal(review.clean, true);
    assert.equal(review.files.length, 0);
    assert.match(review.headline, /Nothing has changed/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// `git diff HEAD` says nothing at all about a file that has never been committed, so
// asking to see a brand-new file used to show an empty panel with no explanation.
test('the diff of a brand-new file shows its contents', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'fresh.mjs'), 'export const hello = 1;\n');
    const patch = git.diff(repo, 'fresh.mjs');
    assert.ok(patch.includes('+export const hello = 1;'), `expected the new line in the patch, got: ${patch}`);
    assert.ok(patch.includes('fresh.mjs'), 'the patch must name the real file, not a temporary one');
    assert.ok(!patch.includes(os.tmpdir().replace(/\\/g, '/').split('/').pop() + '/ghost-empty'), 'the temporary file must not leak into the patch');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Found live, not by the suite: `git status --porcelain` prints repo-root-relative
// paths while a `git diff` pathspec is folder-relative. Ghost's project folder is not
// always the repository root, so every description came back empty and the review
// degraded to bare line counts.
test('the review still describes changes when the project folder is below the repo root', () => {
  const repo = makeRepo();
  try {
    const inner = path.join(repo, 'workspace');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'keep.md'), 'keeps the folder in git\n');
    fs.writeFileSync(path.join(repo, 'tools.mjs'), 'export function alpha() {\n  return 1;\n}\n');
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'with a subfolder'], {cwd: repo});

    fs.writeFileSync(path.join(repo, 'tools.mjs'), 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n');

    // reviewed from the subfolder, exactly as the server does
    const review = git.reviewChanges(inner);
    const tools = review.files.find(f => f.path === 'tools.mjs');
    assert.ok(tools, `expected tools.mjs in ${JSON.stringify(review.files.map(f => f.path))}`);
    assert.ok(tools.notes.includes('adds beta'), `expected a description, got ${JSON.stringify(tools.notes)}`);
    assert.ok(git.diff(inner, 'tools.mjs').includes('+export function beta'), 'the diff must find a file outside the project folder');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Live, the review said "changes test" for an edited test file and "changes $" for the
// UI - the names of the harness around the change, not the change.
test('the review leaves out harness names that say nothing about the change', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'suite.test.mjs'), "test('one', () => {\n  assert.ok(true);\n});\n");
    spawnSync('git', ['add', '-A'], {cwd: repo});
    spawnSync('git', ['commit', '-q', '-m', 'a suite'], {cwd: repo});
    fs.writeFileSync(path.join(repo, 'suite.test.mjs'), "test('one', () => {\n  assert.ok(true);\n  assert.equal(1, 1);\n});\n");

    const review = git.reviewChanges(repo);
    const suite = review.files.find(f => f.path === 'suite.test.mjs');
    assert.deepEqual(suite.notes, [], `expected no harness names, got ${JSON.stringify(suite.notes)}`);
    assert.match(suite.summary, /1 line added/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

function committedFiles(repo) {
  return spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], {cwd: repo, encoding: 'utf8'}).stdout.trim().split('\n').filter(Boolean);
}

// `git add -A` then commit sweeps up every unrelated edit in the folder. If you are
// halfway through a second change, it ends up in a commit you did not intend.
test('committing chosen files leaves the other changes alone', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.md'), 'the change I meant to commit\n');
    fs.writeFileSync(path.join(repo, 'half-finished.md'), 'not ready yet\n');

    const result = git.commit(repo, 'just the one file', {files: ['a.md']});
    assert.deepEqual(committedFiles(repo), ['a.md']);
    assert.deepEqual(result.files, ['a.md']);

    const after = git.status(repo);
    const leftover = after.files.find(f => f.path === 'half-finished.md');
    assert.ok(leftover, 'the unfinished file must still be sitting there, uncommitted');
    assert.equal(fs.readFileSync(path.join(repo, 'half-finished.md'), 'utf8'), 'not ready yet\n');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('committing chosen files does not take what was staged for something else', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'staged-for-later.md'), 'deliberately staged\n');
    spawnSync('git', ['add', 'staged-for-later.md'], {cwd: repo});
    fs.writeFileSync(path.join(repo, 'a.md'), 'the change I meant to commit\n');

    git.commit(repo, 'just the one file', {files: ['a.md']});
    assert.deepEqual(committedFiles(repo), ['a.md']);

    const stillStaged = spawnSync('git', ['diff', '--cached', '--name-only'], {cwd: repo, encoding: 'utf8'}).stdout.trim();
    assert.equal(stillStaged, 'staged-for-later.md', 'what the user staged must survive the commit, still staged');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('a brand-new file can be committed by name', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'brand-new.md'), 'never committed before\n');
    fs.writeFileSync(path.join(repo, 'a.md'), 'also changed\n');
    git.commit(repo, 'the new file only', {files: ['brand-new.md']});
    assert.deepEqual(committedFiles(repo), ['brand-new.md']);
    assert.ok(git.status(repo).files.some(f => f.path === 'a.md'), 'the other edit stays uncommitted');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('committing files with no changes says so instead of failing obscurely', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'b.md'), 'changed\n');
    assert.throws(() => git.commit(repo, 'nothing here', {files: ['a.md']}), e => e.status === 409 && /no changes/i.test(e.message));
    assert.throws(() => git.commit(repo, 'nothing chosen', {files: []}), e => /Choose at least one file/.test(e.message));
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Live check: the review marked every changed file as "staged" because status() trimmed
// the two porcelain columns together, so an unstaged " M" was indistinguishable from a
// staged "M ". The index and working-tree columns are now kept apart.
test('only files actually staged are reported as staged', () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.md'), 'edited but not staged\n');
    fs.writeFileSync(path.join(repo, 'b.md'), 'edited and staged\n');
    spawnSync('git', ['add', 'b.md'], {cwd: repo, encoding: 'utf8'});    const review = git.reviewChanges(repo);
    const byPath = Object.fromEntries(review.files.map(f => [f.path, f]));
    assert.equal(byPath['a.md'].staged, false, 'an unstaged edit must not claim to be staged');
    assert.equal(byPath['b.md'].staged, true);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Live check: pushing with no remote returned git's raw "fatal: 'origin' does not appear
// to be a git repository", which reads as a crash. Failures say what to do instead.
test('a push with no remote explains what to do', () => {
  const repo = makeRepo();
  try {
    assert.throws(() => git.push(repo), e => e.status === 400 && /no remote called "origin"/.test(e.message) && !/fatal:/.test(e.message));
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Live check: when someone else has pushed first, git reports "non-fast-forward" plus a
// wall of hint text. The user is told to pull instead.
test('a rejected push tells you to pull first', () => {
  const repo = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-remote-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-other-'));
  const at = (dir, args) => spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
  try {
    spawnSync('git', ['init', '-q', '--bare', bare], {encoding: 'utf8'});
    at(repo, ['remote', 'add', 'origin', bare]);
    const branch = git.currentBranch(repo);
    at(repo, ['push', '-q', 'origin', `HEAD:${branch}`]);
    at(other, ['clone', '-q', bare, '.']);
    at(other, ['config', 'user.email', 'other@local']);
    at(other, ['config', 'user.name', 'Other']);
    fs.writeFileSync(path.join(other, 'a.md'), 'their version\n');
    at(other, ['commit', '-aqm', 'theirs']);
    at(other, ['push', '-q', 'origin', `HEAD:${branch}`]);
    fs.writeFileSync(path.join(repo, 'a.md'), 'my version\n');
    at(repo, ['commit', '-aqm', 'mine']);
    assert.throws(() => git.push(repo), e => /pull those in first/i.test(e.message) && !/hint:/i.test(e.message));
  } finally {
    for (const dir of [repo, bare, other]) fs.rmSync(dir, {recursive: true, force: true});
  }
});
