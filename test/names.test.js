'use strict';
// Names are validated BEFORE anything is cloned.
//
// The regression: a name git rejects as a branch (`foo.lock`, `a..b`, ...) was
// only caught by `git checkout -b` INSIDE the fresh clone, so `add` failed
// with SETUP_FAILED and left the clone behind. Every case here asserts both
// halves: the error, and that .worktrees/ is untouched.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeProject, runCli } = require('./helpers');

function worktreeEntries(root) {
  const dir = path.join(root, '.worktrees');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// Names that are invalid as a git branch, as a directory, or both. Without
// --branch the workspace name is also the branch name, so all of them must be
// rejected by `add <name>`.
const INVALID_NAMES = [
  ['a..b', 'consecutive dots are not allowed in a ref'],
  ['foo.lock', 'a ref cannot end in .lock'],
  ['has space', 'a ref cannot contain a space'],
  ['tilde~1', 'a ref cannot contain ~'],
  ['star*', 'a ref cannot contain * (and Windows cannot name a file that)'],
  ['caret^', 'a ref cannot contain ^'],
  ['.leading-dot', 'a ref component cannot start with a dot'],
  ['back\\slash', 'path separator'],
  ['nested/name', 'path separator'],
  ['HEAD', 'a valid refname, but not a branch'],
  ['@', 'a valid refname, but not a branch'],
  ['at@{brace', 'a ref cannot contain @{'],
  ['-dash', 'would be read as a git option'],
  ['main', 'reserved for the main project'],
  ['..', 'directory traversal'],
  ['', 'empty'],
  // Windows: invalid characters, reserved device names, trailing dot/space.
  ['con', 'reserved device name on Windows'],
  ['NUL.txt', 'reserved device name on Windows, extension and all'],
  ['com1', 'reserved device name on Windows'],
  ['pipe|name', 'Windows forbids | in a path component'],
  ['angle<name', 'Windows forbids < in a path component'],
  ['quote"name', 'Windows forbids " in a path component'],
  ['colon:name', 'Windows forbids : (and git rejects it in a ref)'],
  ['trailing.', 'Windows strips a trailing dot'],
];

for (const [name, why] of INVALID_NAMES) {
  test(`add rejects the workspace name ${JSON.stringify(name)} (${why}) and leaves no clone`, (t) => {
    const root = makeProject(t);

    assert.throws(
      () => api.createWorkspace(root, { name }),
      (error) => {
        assert.strictEqual(error.name, 'WorklerError');
        assert.strictEqual(error.code, 'INVALID_NAME', `expected INVALID_NAME, got ${error.code}: ${error.message}`);
        return true;
      },
    );

    assert.deepStrictEqual(worktreeEntries(root), [], 'no clone may be left behind');
  });
}

// With --branch the workspace name only has to be a directory name, but the
// BRANCH still has to be a branch git will accept.
const INVALID_BRANCHES = ['a..b', 'foo.lock', 'has space', 'tilde~1', 'HEAD', '@', '-dash', 'at@{brace', ''];

for (const branch of INVALID_BRANCHES) {
  test(`add --branch ${JSON.stringify(branch)} is rejected and leaves no clone`, (t) => {
    const root = makeProject(t);

    assert.throws(
      () => api.createWorkspace(root, { name: 'ws', branch }),
      (error) => {
        assert.strictEqual(error.code, 'INVALID_NAME', `expected INVALID_NAME, got ${error.code}: ${error.message}`);
        assert.match(error.message, /--branch/);
        return true;
      },
    );

    assert.deepStrictEqual(worktreeEntries(root), []);
  });
}

test('a base ref that cannot be resolved fails before cloning', (t) => {
  const root = makeProject(t);

  assert.throws(
    () => api.createWorkspace(root, { name: 'ws', base: 'no-such-ref' }),
    (error) => error.code === 'BAD_REF',
  );
  assert.deepStrictEqual(worktreeEntries(root), []);

  // A ref that looks like an option must never reach the git command line.
  assert.throws(
    () => api.createWorkspace(root, { name: 'ws', base: '--upload-pack=touch /tmp/pwned' }),
    (error) => error.code === 'BAD_REF',
  );
  assert.deepStrictEqual(worktreeEntries(root), []);
});

test('planWorkspaceCreation (add --dry-run) rejects the same names', (t) => {
  const root = makeProject(t);

  assert.throws(() => api.planWorkspaceCreation(root, { name: 'foo.lock' }), (error) => error.code === 'INVALID_NAME');
  assert.deepStrictEqual(worktreeEntries(root), []);
});

test('a name that is only a valid DIRECTORY is still allowed with --branch', (t) => {
  const root = makeProject(t);

  // "release.1" is a fine directory name and a fine branch name; the point is
  // that a name needing no branch of its own goes through unharmed.
  const workspace = api.createWorkspace(root, { name: 'ws', branch: 'feature/nested/name' });
  assert.strictEqual(workspace.branch, 'feature/nested/name');
  assert.deepStrictEqual(worktreeEntries(root), ['ws']);
});

test('the CLI reports an invalid name on stderr with exit code 1 and no clone', (t) => {
  const root = makeProject(t);

  const result = runCli(root, 'add', 'foo.lock');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /^workler: workspace name \(used as the branch name\) is not a valid git branch name: foo\.lock/m);
  assert.deepStrictEqual(worktreeEntries(root), []);

  const reserved = runCli(root, 'add', 'con');
  assert.strictEqual(reserved.status, 1);
  assert.match(reserved.stderr, /reserved device name on Windows/);
  assert.deepStrictEqual(worktreeEntries(root), []);
});

test('remove still accepts the name of a workspace that predates these rules', { skip: process.platform === 'win32' }, (t) => {
  const root = makeProject(t);

  // Simulate a workspace created by an older workler, whose name `add` would
  // now reject. `remove` must still be able to clean it up. Windows cannot
  // create the reserved directory at all, so this compatibility fixture only
  // applies on filesystems where such a legacy workspace can exist.
  const legacy = path.join(root, '.worktrees', 'con');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  git(root, 'clone', '-q', '--local', root, legacy);
  git(legacy, 'config', 'workler.root', root);
  git(legacy, 'config', 'workler.name', 'con');

  assert.throws(() => api.createWorkspace(root, { name: 'con' }), (error) => error.code === 'INVALID_NAME');

  const removed = api.removeWorkspace(root, 'con', { force: true });
  assert.strictEqual(removed.name, 'con');
  assert.deepStrictEqual(worktreeEntries(root), []);
});
