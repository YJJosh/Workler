'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeProject, makeTempDir, runCli } = require('./helpers');

test('rule paths cannot target the workspace root or bypass protected paths with dot components', (t) => {
  const root = makeProject(t);
  const workspace = api.createWorkspace(root, { name: 'safe' });

  for (const rule of ['link .\n', 'copy ././.git/config\n', 'copy ./.worktrees/other\n', 'copy C:\\outside\\secret\n']) {
    fs.writeFileSync(path.join(root, '.workler'), rule);
    const result = runCli(root, 'apply', 'safe', '--force');
    assert.strictEqual(result.status, 1, rule);
    assert.match(result.stderr, /workler: \.workler:1:/, rule);
    assert.ok(fs.statSync(path.join(workspace.path, '.git')).isDirectory(), `clone must survive ${JSON.stringify(rule)}`);
  }
});

test('an aliased workler.root cannot make bare apply treat main as a child', (t) => {
  const root = makeProject(t);
  const alias = path.join(makeTempDir(t), 'root-alias');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'local-data'));
  fs.writeFileSync(path.join(root, 'local-data', 'marker.txt'), 'keep\n');
  fs.writeFileSync(path.join(root, '.workler'), 'link local-data\n');
  git(root, 'config', '--local', 'workler.root', alias);

  const result = runCli(root, 'apply', '--force');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /apply needs a workspace name/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'local-data', 'marker.txt'), 'utf8'), 'keep\n');
  assert.ok(fs.statSync(path.join(root, 'local-data')).isDirectory());
});

test('a stale workler.root pointing elsewhere cannot make main a child', (t) => {
  const root = makeProject(t);
  const unrelated = makeProject(t);
  fs.mkdirSync(path.join(root, 'local-data'));
  fs.writeFileSync(path.join(root, 'local-data', 'marker.txt'), 'keep\n');
  fs.mkdirSync(path.join(unrelated, 'local-data'));
  fs.writeFileSync(path.join(unrelated, '.workler'), 'link local-data\n');
  git(root, 'config', '--local', 'workler.root', unrelated);

  const result = runCli(root, 'apply', '--force');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /apply needs a workspace name/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'local-data', 'marker.txt'), 'utf8'), 'keep\n');
  assert.ok(fs.statSync(path.join(root, 'local-data')).isDirectory());
});

test('overlapping rule paths are rejected instead of depending on rule order', (t) => {
  const root = makeProject(t);
  const workspace = api.createWorkspace(root, { name: 'safe' });
  fs.writeFileSync(path.join(root, '.workler'), 'link cache\ncopy cache/item\n');

  const result = runCli(root, 'apply', 'safe', '--force');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /rule path overlaps an earlier rule/);
  assert.ok(fs.existsSync(path.join(workspace.path, '.git')));
});

test('backslashes in committed rules have portable path-separator semantics', (t) => {
  const root = makeProject(t);
  fs.mkdirSync(path.join(root, 'local'));
  fs.writeFileSync(path.join(root, 'local', 'settings.txt'), 'portable\n');
  fs.writeFileSync(path.join(root, '.workler'), 'copy local\\settings.txt\n');

  const workspace = api.createWorkspace(root, { name: 'portable' });
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, 'local', 'settings.txt'), 'utf8'), 'portable\n');
  assert.strictEqual(workspace.rules.results[0].targetPath, 'local/settings.txt');
});

test('a valid in-root rule component beginning with two dots is not mistaken for traversal', (t) => {
  const root = makeProject(t);
  fs.mkdirSync(path.join(root, '..local'));
  fs.writeFileSync(path.join(root, '..local', 'settings.txt'), 'inside\n');
  fs.writeFileSync(path.join(root, '.workler'), 'copy ..local/settings.txt\n');

  const workspace = api.createWorkspace(root, { name: 'dot-prefix' });
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, '..local', 'settings.txt'), 'utf8'), 'inside\n');
});

test('the .worktrees containment directory cannot be a symlink or junction', (t) => {
  const root = makeProject(t);
  const outside = makeTempDir(t, 'workler-worktrees-outside-');
  fs.rmSync(path.join(root, '.worktrees'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, '.worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction is unavailable on this Windows host');
      return;
    }
    throw error;
  }

  assert.throws(
    () => api.createWorkspace(root, { name: 'must-not-escape' }),
    (error) => error.code === 'SETUP_FAILED' && /symlinked \.worktrees directory/.test(error.message),
  );
  assert.throws(
    () => api.listWorkspaces(root),
    (error) => error.code === 'SETUP_FAILED' && /symlinked \.worktrees directory/.test(error.message),
  );
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'no lock or clone may be created outside the project');
});

test('rules never traverse a symlinked destination parent, even with --force', (t) => {
  const root = makeProject(t);
  const workspace = api.createWorkspace(root, { name: 'safe' });
  const outside = makeTempDir(t, 'workler-outside-');
  fs.mkdirSync(path.join(root, 'escape'));
  fs.writeFileSync(path.join(root, 'escape', 'victim.txt'), 'replacement\n');
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'outside must survive\n');

  try {
    fs.symlinkSync(outside, path.join(workspace.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(root, '.workler'), 'copy escape/victim.txt\n');

  const result = runCli(root, 'apply', 'safe', '--force');
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /destination parent traverses a symlink/);
  assert.match(result.stderr, /--force will not write outside the workspace/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'outside must survive\n');
});

test('rules reject a symlinked source parent before cloning, even with --force', (t) => {
  const root = makeProject(t);
  const outside = makeTempDir(t, 'workler-source-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'must not be copied\n');
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(root, '.workler'), 'copy escape/secret.txt\n');

  assert.throws(
    () => api.createWorkspace(root, { name: 'must-not-clone', force: true }),
    (error) => error.code === 'RULE_CONFLICT' && /source parent traverses a symlink/.test(error.message),
  );
  assert.strictEqual(
    fs.existsSync(path.join(root, '.worktrees', 'must-not-clone')),
    false,
    'creation preflight must reject a known-bad source rule before clone',
  );
});

test('a direct final symlink source remains a supported rule target', (t) => {
  const root = makeProject(t);
  const actual = path.join(root, 'actual-cache');
  const linked = path.join(root, 'linked-cache');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'marker.txt'), 'shared\n');
  try {
    fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(root, '.workler'), 'link linked-cache\n');

  const workspace = api.createWorkspace(root, { name: 'direct-link' });
  assert.strictEqual(
    fs.realpathSync(path.join(workspace.path, 'linked-cache')),
    fs.realpathSync(actual),
    'only symlink ancestors are refused; the rule entry itself may be a symlink',
  );
  const reapplied = runCli(root, 'apply', 'direct-link');
  assert.strictEqual(reapplied.status, 0, reapplied.stderr);
  assert.match(reapplied.stdout, /already linked/, 'a direct final destination symlink must also remain supported');
});

test('--force stages a copy before moving the conflicting destination', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, 'data.txt'), 'committed\n');
  git(root, 'add', 'data.txt');
  git(root, 'commit', '-qm', 'add data');
  fs.writeFileSync(path.join(root, 'data.txt'), 'new local value\n');
  fs.writeFileSync(path.join(root, '.workler'), 'copy data.txt\n');

  const originalCpSync = fs.cpSync;
  fs.cpSync = () => {
    throw new Error('simulated copy failure');
  };
  try {
    assert.throws(
      () => api.createWorkspace(root, { name: 'copy-fails', force: true }),
      (error) => error.code === 'SETUP_FAILED' && /simulated copy failure/.test(error.message),
    );
  } finally {
    fs.cpSync = originalCpSync;
  }

  const target = path.join(root, '.worktrees', 'copy-fails');
  assert.strictEqual(fs.readFileSync(path.join(target, 'data.txt'), 'utf8').replace(/\r\n/g, '\n'), 'committed\n');
  assert.deepStrictEqual(
    fs.readdirSync(target).filter((name) => name.startsWith('.workler-')),
    [],
    'temporary replacement entries must be cleaned up',
  );
});

test('remove treats ignored local files as data and requires --force', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'ignore local env');
  const workspace = api.createWorkspace(root, { name: 'ignored-data' });
  fs.writeFileSync(path.join(workspace.path, '.env'), 'SECRET=keep-me\n');

  assert.strictEqual(
    api.listWorkspaces(root).find((entry) => entry.name === 'ignored-data').clean,
    false,
    'the API listing must agree with remove about ignored local data',
  );
  assert.throws(() => api.removeWorkspace(root, 'ignored-data'), (error) => error.code === 'WORKSPACE_DIRTY');
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8'), 'SECRET=keep-me\n');
  api.removeWorkspace(root, 'ignored-data', { force: true });
});

test('workspace listings are deterministic regardless of creation order', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'z-last' });
  const progress = [];
  api.createWorkspace(root, { name: 'a-first', onProgress: (line) => progress.push(line) });

  assert.ok(!progress.some((line) => line.startsWith('warning:')), 'existing ignored workspaces are not source changes');
  assert.deepStrictEqual(api.listWorkspaces(root).map((workspace) => workspace.name), ['main', 'a-first', 'z-last']);
});

test('workspace names must be usable in the branch-sync ref namespace', (t) => {
  const root = makeProject(t);
  assert.throws(
    () => api.createWorkspace(root, { name: 'has space', branch: 'valid-branch' }),
    (error) => error.code === 'INVALID_NAME' && /git refs/.test(error.message),
  );
  assert.throws(
    () => api.createWorkspace(root, { name: 'x'.repeat(256), branch: 'valid-branch' }),
    (error) => error.code === 'INVALID_NAME' && /too long/.test(error.message),
  );
  assert.throws(
    () => api.createWorkspace(root, { name: 'valid-name', branch: `feature/${'x'.repeat(256)}` }),
    (error) => error.code === 'INVALID_NAME' && /path component too long/.test(error.message),
  );
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.worktrees')), []);
});

test('JavaScript API callers get structured validation errors for malformed options', (t) => {
  const root = makeProject(t);
  assert.throws(() => api.createWorkspace(root, null), (error) => error.code === 'INVALID_OPTIONS');
  assert.throws(
    () => api.createWorkspace(root, { name: 'bad-options', force: 'yes' }),
    (error) => error.code === 'INVALID_OPTIONS',
  );
  assert.throws(
    () => api.removeWorkspace(root, 'missing', { force: 'yes' }),
    (error) => error.code === 'INVALID_OPTIONS',
  );
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.worktrees')), []);
});

test('fetch and sync return a failing exit status after reporting remote failures', (t) => {
  const root = makeProject(t);
  git(root, 'remote', 'add', 'origin', path.join(makeTempDir(t), 'missing.git'));

  for (const command of ['fetch', 'sync']) {
    const result = runCli(root, command);
    assert.strictEqual(result.status, 1, `${command} must fail for automation`);
    assert.match(result.stdout, /failed: git fetch --prune origin failed/);
    assert.match(result.stderr, new RegExp(`workler: 1 ${command === 'fetch' ? 'fetch' : 'sync operation'} failed`));
  }
});

test('an origin remote with no URL is a failure, not a successful no-origin skip', (t) => {
  const root = makeProject(t);
  git(root, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');

  const result = runCli(root, 'fetch');
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /^main\s+failed:/m);
  assert.doesNotMatch(result.stdout, /skipped \(no origin remote\)/);
});

test('status reports an unreadable index as unknown and exits non-zero', (t) => {
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, '.git', 'index'), 'not a git index');

  const result = runCli(root, 'status');
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /unknown: git status failed/);
  assert.match(result.stderr, /workler: git status failed in 1 workspace/);
});

test('branch-sync reports all work then exits non-zero when a mirrored ref cannot be represented', (t) => {
  const root = makeProject(t);
  const workspace = api.createWorkspace(root, { name: 'legacy' });
  git(workspace.path, 'config', 'workler.name', 'legacy name with spaces');

  const result = runCli(root, 'branch-sync');
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /^workspace legacy name with spaces$/m);
  assert.match(result.stdout, /^  legacy name with spaces  failed:/m);
  assert.match(result.stderr, /workler: 1 branch-sync operation failed/);
});

test('mutating multi-workspace CLI commands honor the project lock, but reads and dry-runs do not', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'safe' });
  fs.writeFileSync(api.projectLockPath(root), JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    operation: 'test holder',
    createdAt: new Date().toISOString(),
  }));
  t.after(() => fs.rmSync(api.projectLockPath(root), { force: true }));

  for (const args of [['apply', 'safe'], ['fetch'], ['sync'], ['branch-sync']]) {
    const result = runCli(root, ...args);
    assert.strictEqual(result.status, 1, `${args.join(' ')} must honor the live lock`);
    assert.match(result.stderr, /another workler operation is in progress/);
  }
  assert.strictEqual(runCli(root, 'apply', 'safe', '--dry-run').status, 0);
  assert.strictEqual(runCli(root, 'status').status, 0);
});

test('git clone failures use the API SETUP_FAILED contract and leave no lock', (t) => {
  const root = makeProject(t);
  const head = git(root, 'rev-parse', 'HEAD');
  fs.rmSync(path.join(root, '.git', 'objects', head.slice(0, 2), head.slice(2)));

  assert.throws(
    () => api.createWorkspace(root, { name: 'clone-failure' }),
    (error) => error.code === 'SETUP_FAILED' && /clone failed/.test(error.message),
  );
  assert.strictEqual(fs.existsSync(api.projectLockPath(root)), false);
});
