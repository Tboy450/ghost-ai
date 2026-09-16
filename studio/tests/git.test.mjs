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
