'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeTempDir, makeRepo, makeProject } = require('./helpers');

const RULES = 'copy .env\nlink node_modules\n';

test('initProject creates config, workspaces dir, and git marks', (t) => {
  const root = makeRepo(t);
  fs.rmSync(path.join(root, '.workler'));

  const result = api.initProject(root);
  assert.strictEqual(result.root, root);
  assert.strictEqual(result.configCreated, true);
  assert.strictEqual(result.gitRepo, true);
  assert.ok(fs.existsSync(result.configPath));
  assert.ok(fs.statSync(result.workspacesPath).isDirectory());
  assert.strictEqual(git(root, 'config', '--get', 'workler.name'), 'main');
  assert.strictEqual(git(root, 'config', '--get', 'workler.root'), root);
  assert.match(fs.readFileSync(result.excludePath, 'utf8'), /^\.worktrees\/$/m);

  // Re-init is idempotent and reports the existing config.
  assert.strictEqual(api.initProject(root).configCreated, false);
});

test('inspectProject treats every Git repository as usable without .workler or init', (t) => {
  const plainRepo = makeRepo(t, { includeWorkler: false });
  const plainInfo = api.inspectProject(plainRepo);
  assert.strictEqual(plainInfo.initialized, true);
  assert.strictEqual(plainInfo.gitRepo, true);
  assert.strictEqual(plainInfo.marked, false);
  assert.strictEqual(plainInfo.configFileExists, false);

  const initialized = makeProject(t);
  const info = api.inspectProject(initialized);
  assert.strictEqual(info.initialized, true);
  assert.strictEqual(info.marked, true);
  assert.strictEqual(info.configFileExists, true);

  const ordinaryDir = makeTempDir(t);
  assert.strictEqual(api.inspectProject(ordinaryDir).initialized, false);
  fs.writeFileSync(path.join(ordinaryDir, '.workler'), '');
  const nonGitChild = path.join(ordinaryDir, 'child');
  fs.mkdirSync(nonGitChild);
  assert.strictEqual(api.inspectProject(ordinaryDir).initialized, true);
  assert.strictEqual(api.findWorklerRoot(nonGitChild), ordinaryDir);

  const missing = path.join(makeTempDir(t), 'nope');
  assert.strictEqual(api.inspectProject(missing).exists, false);
  assert.throws(() => api.initProject(missing), (e) => e.code === 'ROOT_NOT_FOUND');
});

test('operations use the explicit root and never touch process.cwd()', (t) => {
  const root = makeProject(t, { workler: RULES });
  const neutral = makeTempDir(t);
  const previousCwd = process.cwd();
  process.chdir(neutral);
  try {
    const ws = api.createWorkspace(root, { name: 'feat' });
    assert.strictEqual(ws.path, path.join(root, '.worktrees', 'feat'));
    assert.deepStrictEqual(
      api.listWorkspaces(root).map((w) => w.name),
      ['main', 'feat'],
    );
    api.removeWorkspace(root, 'feat', { force: true });
    // Nothing leaked into the unrelated working directory.
    assert.deepStrictEqual(fs.readdirSync(neutral), []);
  } finally {
    process.chdir(previousCwd);
  }
});

test('operations work in a plain Git repository without .workler or init', (t) => {
  const root = makeRepo(t, { includeWorkler: false });

  const workspace = api.createWorkspace(root, { name: 'x' });
  assert.strictEqual(workspace.rules.ruleCount, 0);
  assert.deepStrictEqual(api.listWorkspaces(root).map((item) => item.name), ['main', 'x']);
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.worktrees\/$/m);
  api.removeWorkspace(root, 'x', { force: true });

  const ordinaryDir = makeTempDir(t);
  assert.throws(() => api.listWorkspaces(ordinaryDir), (e) => e.code === 'NOT_INITIALIZED');
});

test('createWorkspace creates a new branch from HEAD by default', (t) => {
  const root = makeProject(t);
  const ws = api.createWorkspace(root, { name: 'feat' });

  assert.strictEqual(ws.name, 'feat');
  assert.strictEqual(ws.branch, 'feat');
  assert.strictEqual(ws.detached, false);
  assert.strictEqual(ws.head, git(root, 'rev-parse', 'HEAD'));
  assert.strictEqual(git(ws.path, 'config', '--get', 'workler.name'), 'feat');
  assert.strictEqual(git(ws.path, 'config', '--get', 'workler.root'), root);
  assert.ok(fs.existsSync(path.join(ws.path, '.git')));
});

test('createWorkspace with a base starts the new branch there', (t) => {
  const root = makeProject(t);
  const firstSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'stable');
  fs.writeFileSync(path.join(root, 'README.md'), 'more\n');
  git(root, 'commit', '-aqm', 'second');

  const ws = api.createWorkspace(root, { name: 'from-stable', base: 'stable' });
  assert.strictEqual(ws.branch, 'from-stable');
  assert.strictEqual(ws.head, firstSha);

  const explicit = api.createWorkspace(root, {
    name: 'ui-safe-workspace-name',
    branch: 'feature/explicit-name',
    base: 'stable',
  });
  assert.strictEqual(explicit.branch, 'feature/explicit-name');
  assert.strictEqual(explicit.head, firstSha);
});

test('createWorkspace --checkout reuses branches and detaches on commits', (t) => {
  const root = makeProject(t);
  git(root, 'branch', 'shared');

  const onBranch = api.createWorkspace(root, { name: 'ws1', checkout: 'shared' });
  assert.strictEqual(onBranch.branch, 'shared');
  assert.strictEqual(onBranch.detached, false);

  const sha = git(root, 'rev-parse', 'HEAD');
  const detached = api.createWorkspace(root, { name: 'ws2', checkout: sha });
  assert.strictEqual(detached.detached, true);
  assert.strictEqual(detached.branch, undefined);
  assert.strictEqual(detached.head, sha);
});

test('createWorkspace rejects clashes and bad input with structured codes', (t) => {
  const root = makeProject(t);
  git(root, 'branch', 'taken');

  assert.throws(() => api.createWorkspace(root, { name: 'taken' }), (e) => e.code === 'BRANCH_EXISTS');
  assert.throws(() => api.createWorkspace(root, { name: 'x', base: 'no-such-ref' }), (e) => e.code === 'BAD_REF');
  assert.throws(() => api.createWorkspace(root, { name: 'x', checkout: 'no-such-ref' }), (e) => e.code === 'BAD_REF');
  assert.throws(() => api.createWorkspace(root, { name: 'main' }), (e) => e.code === 'INVALID_NAME');
  assert.throws(() => api.createWorkspace(root, { name: 'a/b' }), (e) => e.code === 'INVALID_NAME');
  assert.throws(
    () => api.createWorkspace(root, { name: 'x', branch: 'b', checkout: 'c' }),
    (e) => e.code === 'INVALID_OPTIONS',
  );

  api.createWorkspace(root, { name: 'dup', branch: 'taken' });
  assert.throws(() => api.createWorkspace(root, { name: 'dup', branch: 'taken' }), (e) => e.code === 'WORKSPACE_EXISTS');
});

test('.workler copy/link rules are applied to new workspaces', (t) => {
  const root = makeProject(t, { workler: RULES });
  const ws = api.createWorkspace(root, { name: 'feat' });

  assert.deepStrictEqual(
    ws.rules.results.map((r) => [r.action, r.targetPath, r.status]),
    [['copy', '.env', 'applied'], ['link', 'node_modules', 'applied']],
  );
  assert.strictEqual(fs.readFileSync(path.join(ws.path, '.env'), 'utf8'), 'SECRET=1\n');
  const link = path.join(ws.path, 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(root, 'node_modules')));
});

test('rule conflicts fail setup but leave the clone inspectable; force replaces', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, 'data.txt'), 'committed\n');
  git(root, 'add', 'data.txt');
  git(root, 'commit', '-qm', 'data');
  // Uncommitted divergence: the clone gets "committed", the copy source says
  // "changed" -> destination exists and differs -> conflict.
  fs.writeFileSync(path.join(root, 'data.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, '.workler'), 'copy data.txt\n');

  const target = path.join(root, '.worktrees', 'feat');
  assert.throws(
    () => api.createWorkspace(root, { name: 'feat' }),
    (e) => e.code === 'SETUP_FAILED' && /left in place/.test(e.message) && /cannot copy data\.txt/.test(e.message),
  );
  // Partial-create contract: the clone stays for inspection, the lock does not.
  assert.ok(fs.existsSync(path.join(target, '.git')));
  assert.ok(!fs.existsSync(api.projectLockPath(root)));

  fs.rmSync(target, { recursive: true, force: true });
  const ws = api.createWorkspace(root, { name: 'feat', force: true });
  assert.strictEqual(ws.rules.results[0].status, 'applied');
  assert.strictEqual(ws.rules.results[0].replaced, 'regular file');
  assert.strictEqual(fs.readFileSync(path.join(ws.path, 'data.txt'), 'utf8'), 'changed\n');
});

test('invalid .workler reports file, line, and column before cloning', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, '.workler'), 'frobnicate x\n');
  assert.throws(
    () => api.createWorkspace(root, { name: 'feat' }),
    (e) => e.code === 'CONFIG_INVALID' && /\.workler:1:1/.test(e.message),
  );
  assert.strictEqual(fs.existsSync(path.join(root, '.worktrees', 'feat')), false);
});

test('listWorkspaces reports branch, head, clean, and broken metadata', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'clean-ws' });
  const dirty = api.createWorkspace(root, { name: 'dirty-ws' });
  fs.appendFileSync(path.join(dirty.path, 'README.md'), 'local change\n');
  fs.mkdirSync(path.join(root, '.worktrees', 'junk'));
  fs.writeFileSync(path.join(root, '.worktrees', 'junk', 'file.txt'), 'not a clone\n');

  const byName = Object.fromEntries(api.listWorkspaces(root).map((w) => [w.name, w]));

  assert.strictEqual(byName.main.isMain, true);
  assert.strictEqual(byName.main.branch, 'main');
  assert.strictEqual(byName.main.path, root);

  assert.strictEqual(byName['clean-ws'].clean, true);
  assert.strictEqual(byName['clean-ws'].branch, 'clean-ws');
  assert.strictEqual(byName['clean-ws'].head, git(root, 'rev-parse', 'HEAD'));
  assert.strictEqual(byName['dirty-ws'].clean, false);

  assert.strictEqual(byName.junk.isClone, false);
  assert.match(byName.junk.broken, /missing \.git/);
  assert.strictEqual(byName.junk.clean, undefined);
});

test('removeWorkspace protects dirty workspaces unless forced', (t) => {
  const root = makeProject(t);
  const ws = api.createWorkspace(root, { name: 'feat' });
  fs.appendFileSync(path.join(ws.path, 'README.md'), 'local change\n');

  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_DIRTY');
  assert.ok(fs.existsSync(ws.path));

  const removed = api.removeWorkspace(root, 'feat', { force: true });
  assert.strictEqual(removed.path, ws.path);
  assert.ok(!fs.existsSync(ws.path));

  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_NOT_FOUND');
  assert.throws(() => api.removeWorkspace(root, 'main'), (e) => e.code === 'MAIN_WORKSPACE');
});

test('resolveWorkspacePath resolves main and named workspaces', (t) => {
  const root = makeProject(t);
  const ws = api.createWorkspace(root, { name: 'feat' });

  assert.strictEqual(api.resolveWorkspacePath(root, 'main'), root);
  assert.strictEqual(api.resolveWorkspacePath(root, 'feat'), ws.path);
  assert.throws(() => api.resolveWorkspacePath(root, 'ghost'), (e) => e.code === 'WORKSPACE_NOT_FOUND');
});
