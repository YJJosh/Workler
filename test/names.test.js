'use strict';
// Names are validated before anything is cloned, so each case checks both the error
// and that .worktrees/ is untouched.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeProject, runCli } = require('./helpers');

function worktreeEntries(root) {
  const dir = path.join(root, '.worktrees');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// Invalid as a git branch, a directory, or both. Without --branch the workspace name
// is also the branch name, so `add <name>` must reject all of them.
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

// With --branch the workspace name only has to be a directory name; the branch is checked on its own.
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

  // The branch may hold slashes; only the workspace name has to be one directory name.
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

  // A workspace named `con` (made before add rejected it) must stay removable.
  // Windows cannot create a directory with that reserved name, hence the skip.
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

// A path separator gets remove's own advice, not add's --branch hint: the caller usually
// typed a nested workspace (feat/agent-1) or a group member's address (feat/web).
for (const name of ['feat/web', 'feat\\web']) {
  test(`remove rejects ${JSON.stringify(name)} with advice for remove, not add`, (t) => {
    const root = makeProject(t);
    api.createWorkspace(root, { name: 'feat' });

    assert.throws(
      () => api.removeWorkspace(root, name),
      (error) => {
        assert.strictEqual(error.code, 'INVALID_NAME', `expected INVALID_NAME, got ${error.code}: ${error.message}`);
        assert.match(error.message, /workler list/);
        assert.match(error.message, /nested workspace from inside its parent/);
        assert.match(error.message, /project-group workspace only as a whole/);
        assert.doesNotMatch(error.message, /--branch/);
        return true;
      },
    );
    assert.deepStrictEqual(worktreeEntries(root), ['feat'], 'nothing may be removed');
  });
}
