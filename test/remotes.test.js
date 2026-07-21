'use strict';
// Remote wiring of a fresh workspace.
//
// `git clone --local` points the clone's `origin` at the main checkout on
// disk. That is never what `origin` should mean: `workler fetch`/`sync` would
// treat the main project as the upstream, and `git push origin` would push
// into it. `add` therefore repoints origin at the main project's REAL origin,
// or removes it when there is none, and always records the way back to the
// main checkout as the `workler-root` remote.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { addOrigin, api, git, makeProject, remotes, runCli } = require('./helpers');

test('a workspace inherits the root origin and gets a workler-root remote', (t) => {
  const root = makeProject(t);
  const origin = addOrigin(t, root);

  const workspace = api.createWorkspace(root, { name: 'feat' });
  const configured = remotes(workspace.path);

  assert.strictEqual(configured.origin, origin, 'origin must be the root REAL origin, not the root checkout');
  assert.strictEqual(configured['workler-root'], root);
});

test('relative local origin URLs are inherited without changing their meaning', (t) => {
  const root = makeProject(t);
  const origin = path.join(path.dirname(root), 'relative-origin.git');
  git(path.dirname(root), 'init', '-q', '--bare', origin);
  git(root, 'remote', 'add', 'origin', path.relative(root, origin));
  git(root, 'push', '-q', '-u', 'origin', 'main');

  const workspace = api.createWorkspace(root, { name: 'feat' });
  assert.strictEqual(git(workspace.path, 'remote', 'get-url', 'origin'), fs.realpathSync.native(origin));
  assert.doesNotThrow(() => git(workspace.path, 'fetch', 'origin'));
});

test('all origin fetch URLs and separate push URLs are inherited', (t) => {
  const root = makeProject(t);
  const origin = addOrigin(t, root);
  const mirror = path.join(path.dirname(root), 'mirror.git');
  const pushOne = path.join(path.dirname(root), 'push-one.git');
  const pushTwo = path.join(path.dirname(root), 'push-two.git');
  git(root, 'remote', 'set-url', '--add', 'origin', path.relative(root, mirror));
  git(root, 'remote', 'set-url', '--add', 'origin', 'git@[2001:db8::1]:team/project.git');
  git(root, 'remote', 'set-url', '--add', '--push', 'origin', path.relative(root, pushOne));
  git(root, 'remote', 'set-url', '--add', '--push', 'origin', path.relative(root, pushTwo));

  const workspace = api.createWorkspace(root, { name: 'feat' });
  assert.deepStrictEqual(
    git(workspace.path, 'remote', 'get-url', '--all', 'origin').split('\n'),
    [origin, path.resolve(root, path.relative(root, mirror)), 'git@[2001:db8::1]:team/project.git'],
  );
  assert.deepStrictEqual(
    git(workspace.path, 'remote', 'get-url', '--all', '--push', 'origin').split('\n'),
    [path.resolve(root, path.relative(root, pushOne)), path.resolve(root, path.relative(root, pushTwo))],
  );
});

test('a root with no origin leaves the workspace with no origin at all', (t) => {
  const root = makeProject(t);
  assert.strictEqual(git(root, 'remote'), '', 'precondition: the root has no origin');

  const workspace = api.createWorkspace(root, { name: 'feat' });
  const configured = remotes(workspace.path);

  // The bug this guards: `clone --local` left origin -> <root>, so the
  // workspace fetched/pushed against the main checkout as if it were upstream.
  assert.ok(!('origin' in configured), `workspace must have no origin, got ${JSON.stringify(configured)}`);
  assert.strictEqual(configured['workler-root'], root);

  // Removing origin must also take its remote-tracking refs with it: those
  // were copies of the ROOT's local branches and would otherwise read as
  // real upstream state (bogus ahead/behind in `status`).
  assert.strictEqual(git(workspace.path, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin'), '');

  // And the multi-workspace commands must agree there is nothing to fetch.
  const sync = runCli(root, 'sync');
  assert.strictEqual(sync.status, 0);
  assert.match(sync.stdout, /^\s+feat\s+skipped \(no origin remote\)$/m);
});

test('local-only branches have no fake upstream and origin refs mirror the root snapshot', (t) => {
  const root = makeProject(t);
  addOrigin(t, root);
  git(root, 'branch', 'remote-only');
  git(root, 'push', '-q', 'origin', 'remote-only');
  git(root, 'branch', '-D', 'remote-only');
  git(root, 'branch', 'local-only');
  git(root, 'remote', 'set-head', 'origin', '-a');
  fs.appendFileSync(path.join(root, 'README.md'), 'main moved locally\n');
  git(root, 'commit', '-aqm', 'ahead of origin');

  const expectedLocalTip = git(root, 'rev-parse', 'refs/heads/local-only');
  const workspace = api.createWorkspace(root, { name: 'local-ws', checkout: 'local-only' });

  assert.strictEqual(workspace.head, expectedLocalTip, 'the exact root-local branch tip must be checked out');
  assert.strictEqual(
    git(workspace.path, 'for-each-ref', '--format=%(upstream)', 'refs/heads/local-only'),
    '',
    'a root-local-only branch must not retain clone --local tracking config',
  );
  assert.strictEqual(
    git(workspace.path, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/local-only'),
    '',
    'clone --local must not leave a synthetic origin/local-only ref behind',
  );
  const snapshotFormat = '--format=%(refname) %(objectname) %(symref)';
  assert.strictEqual(
    git(workspace.path, 'for-each-ref', snapshotFormat, 'refs/remotes/origin/'),
    git(root, 'for-each-ref', snapshotFormat, 'refs/remotes/origin/'),
    'workspace remote-tracking refs must exactly mirror the root origin snapshot',
  );
  assert.match(runCli(root, 'status').stdout, /^local-ws\s+local-only\s+no upstream\s+clean$/m);
});

test('a root local branch tracks only the real origin snapshot, not its local tip', (t) => {
  const root = makeProject(t);
  addOrigin(t, root);
  fs.appendFileSync(path.join(root, 'README.md'), 'root-only commit\n');
  git(root, 'commit', '-aqm', 'ahead of origin');

  const workspace = api.createWorkspace(root, { name: 'main-ws', checkout: 'main' });

  assert.strictEqual(workspace.head, git(root, 'rev-parse', 'refs/heads/main'));
  assert.strictEqual(git(workspace.path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'), '1\t0');
  assert.match(runCli(root, 'status').stdout, /^main-ws\s+main\s+ahead 1\s+clean$/m);
});

test('--checkout HEAD and @ are detached revision shorthands even when origin/HEAD exists', (t) => {
  const root = makeProject(t);
  addOrigin(t, root);
  git(root, 'remote', 'set-head', 'origin', '-a');
  const expected = git(root, 'rev-parse', 'HEAD');

  for (const [name, checkout] of [['head-ws', 'HEAD'], ['at-ws', '@']]) {
    const workspace = api.createWorkspace(root, { name, checkout });
    assert.strictEqual(workspace.detached, true, checkout);
    assert.strictEqual(workspace.branch, undefined, checkout);
    assert.strictEqual(workspace.head, expected, checkout);
  }
});

test('a nested workspace points workler-root at its immediate parent', (t) => {
  const root = makeProject(t);
  const parent = api.createWorkspace(root, { name: 'outer' });
  api.initProject(parent.path);

  const nested = api.createWorkspace(parent.path, { name: 'inner' });

  assert.strictEqual(remotes(nested.path)['workler-root'], parent.path);
  assert.strictEqual(nested.path, path.join(parent.path, '.worktrees', 'inner'));
});

test('branch-sync works over the remote add created, without re-adding it', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'feat' });
  git(root, 'branch', 'shared');

  const output = runCli(root, 'branch-sync');
  assert.strictEqual(output.status, 0);
  // `add` already wired workler-root, so branch-sync has nothing to add.
  assert.doesNotMatch(output.stdout, /added remote workler-root/);
  assert.match(output.stdout, /^ {2}shared\s+created$/m);
});
