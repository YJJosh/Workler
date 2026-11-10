'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { addOrigin, api, git, makeProject, makeTempDir, runCli } = require('./helpers');

function commit(repo, message = 'unique') {
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'workler tests');
  git(repo, 'commit', '--allow-empty', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}
function history(root, name = 'feat') {
  return api.listWorkspaces(root, { history: true }).find((row) => row.name === name).history;
}
function blocked(root, name = 'feat', state = 'unsafe') {
  assert.equal(history(root, name).state, state);
  assert.throws(() => api.removeWorkspace(root, name), (error) => error.code === 'WORKSPACE_HISTORY');
  assert.ok(fs.existsSync(path.join(root, '.worktrees', name)));
}
function fixture(t) {
  const root = makeProject(t);
  const ws = api.createWorkspace(root, { name: 'feat' }).path;
  return { root, ws };
}
function expire(repo) { git(repo, 'reflog', 'expire', '--expire=now', '--all'); }
function importCommit(root, ws, oid, branch = 'kept') {
  git(root, 'fetch', '--no-tags', '--', ws, `${oid}:refs/heads/${branch}`);
}

test('clean unique commits block removal; source import permits removal; force destroys without importing', { timeout: 30000 }, (t) => {
  const { root, ws } = fixture(t);
  const oid = commit(ws);
  assert.equal(api.listWorkspaces(root).find((x) => x.name === 'feat').clean, true);
  blocked(root);
  const status = runCli(root, 'status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /HISTORY/);
  assert.match(status.stdout, /commit\(s\) not preserved in source/);
  assert.ok(status.stdout.includes(oid));
  importCommit(root, ws, oid);
  assert.equal(history(root).state, 'safe');
  assert.match(runCli(root, 'status').stdout, /preserved in source/);
  api.removeWorkspace(root, 'feat');
  const forced = api.createWorkspace(root, { name: 'forced' }).path;
  const lost = commit(forced, 'will be destroyed');
  api.removeWorkspace(root, 'forced', { force: true });
  assert.ok(!git(root, 'for-each-ref', '--format=%(objectname)', 'refs/heads').includes(lost));
});

for (const kind of ['noncurrent branch', 'detached HEAD', 'tag', 'custom ref']) {
  test(`${kind} unique history is checked independently of upstream/current branch`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const base = git(ws, 'rev-parse', 'HEAD');
    const oid = commit(ws, kind);
    if (kind === 'noncurrent branch') git(ws, 'branch', 'other', oid);
    if (kind === 'tag') git(ws, 'tag', '-a', 'saved', '-m', 'tag', oid);
    if (kind === 'custom ref') git(ws, 'update-ref', 'refs/private/kept', oid);
    if (kind === 'detached HEAD') git(ws, 'checkout', '--detach', '-q', oid);
    else git(ws, 'reset', '--hard', base);
    expire(ws);
    blocked(root);
    assert.ok(history(root).commits.includes(oid));
  });
}

test('older stash reflog and its index/untracked parents must be preserved, not just latest stash', { timeout: 30000 }, (t) => {
  const { root, ws } = fixture(t);
  fs.writeFileSync(path.join(ws, 'README.md'), 'older stash\n');
  fs.writeFileSync(path.join(ws, 'untracked.txt'), 'stash data\n');
  git(ws, 'stash', 'push', '-u', '-m', 'older');
  const older = git(ws, 'rev-parse', 'refs/stash');
  fs.writeFileSync(path.join(ws, 'README.md'), 'new stash\n');
  git(ws, 'stash', 'push', '-m', 'newer');
  importCommit(root, ws, git(ws, 'rev-parse', 'refs/stash'));
  blocked(root);
  assert.ok(history(root).commits.includes(older));
  importCommit(root, ws, older, 'older-stash');
  api.removeWorkspace(root, 'feat');
});

for (const kind of ['reset', 'amend', 'deleted branch']) {
  test(`reflog-only commits after ${kind} block normal removal`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const oid = commit(ws, `before ${kind}`);
    if (kind === 'amend') {
      git(ws, 'commit', '--amend', '--allow-empty', '-qm', 'replacement');
      importCommit(root, ws, git(ws, 'rev-parse', 'HEAD'));
    } else if (kind === 'deleted branch') {
      git(ws, 'checkout', '-qb', 'temporary');
      commit(ws, 'branch tip');
      git(ws, 'checkout', '-q', 'feat');
      git(ws, 'branch', '-D', 'temporary');
      git(ws, 'reset', '--hard', 'HEAD~');
    } else git(ws, 'reset', '--hard', 'HEAD~');
    blocked(root);
    assert.ok(history(root).commits.includes(oid));
  });
}

test('hardlinked loose objects in source without surviving refs do NOT prove preservation', { timeout: 30000 }, (t) => {
  const root = makeProject(t);
  const base = git(root, 'rev-parse', 'HEAD');
  const oid = commit(root, 'object only');
  const ws = api.createWorkspace(root, { name: 'feat' }).path;
  git(root, 'reset', '--hard', base);
  expire(root);
  assert.equal(git(root, 'cat-file', '-t', oid), 'commit');
  const objectPath = (repo) => path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  if (process.platform !== 'win32') assert.equal(fs.statSync(objectPath(root)).ino, fs.statSync(objectPath(ws)).ino);
  blocked(root);
});

test('branch-sync mirrors and remote tracking refs are NOT durable source refs', { timeout: 30000 }, (t) => {
  const { root, ws } = fixture(t);
  const oid = commit(ws);
  assert.equal(runCli(root, 'branch-sync').status, 0);
  assert.equal(git(root, 'rev-parse', 'refs/workler/feat/feat'), oid);
  git(root, 'update-ref', 'refs/remotes/origin/feat', oid);
  git(root, 'update-ref', 'refs/workler-group/example/feat/feat', oid);
  blocked(root);
  git(root, 'symbolic-ref', 'refs/heads/alias', 'refs/workler/feat/feat');
  blocked(root);
  importCommit(root, ws, oid);
  api.removeWorkspace(root, 'feat');
  assert.equal(runCli(root, 'branch-sync').status, 0);
  assert.equal(git(root, 'for-each-ref', '--format=%(refname)', 'refs/workler/feat'), '');
});

for (const ref of ['tag', 'detached HEAD']) {
  test(`source ${ref} is durable preservation`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const oid = commit(ws);
    importCommit(root, ws, oid);
    if (ref === 'tag') git(root, 'tag', '-a', 'kept-tag', '-m', 'kept', oid);
    else git(root, 'checkout', '-q', '--detach', oid);
    git(root, 'branch', '-D', 'kept');
    assert.equal(history(root).state, 'safe');
    api.removeWorkspace(root, 'feat');
  });
}

for (const unsupported of ['shallow', 'graft', 'replace', 'alternates', 'partial', 'missing commit', 'missing blob', 'missing tree', 'missing reflog commit', 'git failure']) {
  test(`${unsupported} inspection yields unknown and refuses removal`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    if (unsupported === 'shallow') fs.writeFileSync(path.join(ws, '.git', 'shallow'), git(ws, 'rev-parse', 'HEAD') + '\n');
    if (unsupported === 'graft') fs.writeFileSync(path.join(root, '.git', 'info', 'grafts'), '');
    if (unsupported === 'replace') git(ws, 'update-ref', 'refs/replace/' + git(ws, 'rev-parse', 'HEAD'), git(ws, 'rev-parse', 'HEAD'));
    if (unsupported === 'alternates') fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), path.join(ws, '.git', 'objects') + '\n');
    if (unsupported === 'partial') git(ws, 'config', 'remote.origin.promisor', 'true');
    if (unsupported === 'missing commit') fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'broken'), 'a'.repeat(40) + '\n');
    if (unsupported === 'missing blob') {
      const blob = git(ws, 'rev-parse', 'HEAD:README.md');
      fs.unlinkSync(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    }
    if (unsupported === 'missing tree') {
      const tree = git(ws, 'rev-parse', 'HEAD^{tree}');
      fs.unlinkSync(path.join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    }
    if (unsupported === 'missing reflog commit') {
      fs.appendFileSync(path.join(ws, '.git', 'logs', 'refs', 'heads', 'feat'),
        `${git(ws, 'rev-parse', 'HEAD')} ${'1'.repeat(40)} Probe <probe@example.invalid> 1700000000 +0000\tmissing reflog entry\n`);
    }
    if (unsupported === 'git failure') git(ws, 'config', 'core.repositoryFormatVersion', '999');
    assert.equal(history(root).state, 'unknown');
    assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => ['WORKSPACE_HISTORY', 'WORKSPACE_DIRTY'].includes(e.code));
    const status = runCli(root, 'status');
    assert.equal(status.status, 1);
    assert.match(status.stdout, /unknown:/);
    assert.doesNotMatch(status.stdout, /preserved in source/);
    api.removeWorkspace(root, 'feat', { force: true });
  });
}

// Git boolean syntax includes explicit false and valueless true; neither
// should be mistaken for the other when detecting unsupported partial clones.
for (const repository of ['source', 'workspace']) {
  test(`explicitly disabled promisor in ${repository} does not block a full repository`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const repo = repository === 'source' ? root : ws;
    git(repo, 'config', '--add', 'remote.offline.promisor', 'true');
    git(repo, 'config', '--add', 'remote.offline.promisor', 'false');
    assert.equal(git(repo, 'config', '--bool', '--get', 'remote.offline.promisor'), 'false');
    assert.equal(history(root).state, 'safe');
    api.removeWorkspace(root, 'feat');
  });

  test(`valueless true promisor in ${repository} is unsupported, not safe`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const repo = repository === 'source' ? root : ws;
    fs.appendFileSync(path.join(repo, '.git', 'config'), '\n[remote "offline"]\n\tpromisor\n');
    assert.equal(git(repo, 'config', '--bool', '--get', 'remote.offline.promisor'), 'true');
    blocked(root, 'feat', 'unknown');
    api.removeWorkspace(root, 'feat', { force: true });
  });
}

test('specific-commit advice is escaped, copyable and does not execute unusual names', { timeout: 30000 }, (t) => {
  const root = makeProject(t);
  const name = "odd'$(echo-injection)";
  const ws = api.createWorkspace(root, { name, branch: "branch'$(not-run)" }).path;
  const oid = commit(ws);
  const status = runCli(root, 'status');
  assert.equal(status.status, 0);
  const command = status.stdout.split('\n').find((line) => line.trimStart().startsWith('git -C ')).trim();
  assert.ok(command.includes(oid));
  assert.match(command, /refs\/heads\/keep-/);
  assert.doesNotMatch(command, /refs\/workler/);
  if (process.platform !== 'win32') {
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(history(root, name).state, 'safe');
  }
  const { historyAdvice } = require('../dist/history');
  const line = historyAdvice("/tmp/source\n\u001b\u202e'", '/tmp/ws\\odd\n', { state: 'unsafe', commits: [oid] })[1];
  assert.doesNotMatch(line, /[\n\u001b\u202e]/);
  assert.match(line, /\\012/);
});

function group(t) {
  const root = fs.realpathSync.native(makeTempDir(t));
  fs.writeFileSync(path.join(root, '.workler'), 'project api\nproject web\n');
  for (const member of ['api', 'web']) {
    const source = makeProject(t);
    git(root, 'clone', '-q', '--local', '--', source, path.join(root, member));
  }
  return root;
}

test('group unsafe member preflight is all-or-nothing against each proper source', { timeout: 30000 }, (t) => {
  const root = group(t);
  const ws = api.createWorkspace(root, { name: 'feat' }).path;
  const oid = commit(path.join(ws, 'web'));
  assert.equal(runCli(root, 'branch-sync').status, 0);
  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_HISTORY');
  assert.ok(fs.existsSync(path.join(ws, 'api', '.git')));
  const members = api.listWorkspaces(root, { history: true }).find((x) => x.name === 'feat').projects;
  assert.equal(members.find((x) => x.project === 'web').history.state, 'unsafe');
  importCommit(path.join(root, 'api'), path.join(ws, 'web'), oid);
  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_HISTORY');
  importCommit(path.join(root, 'web'), path.join(ws, 'web'), oid);
  api.removeWorkspace(root, 'feat');
});

for (const broken of ['missing', 'broken', 'linked', 'linked checkout']) {
  test(`group ${broken} source fails closed without deleting any members`, { timeout: 30000 }, (t) => {
    const root = group(t);
    const ws = api.createWorkspace(root, { name: 'feat' }).path;
    const source = path.join(root, 'web');
    if (broken === 'missing') fs.rmSync(source, { recursive: true });
    if (broken === 'broken') fs.writeFileSync(path.join(source, '.git', 'HEAD'), 'bad head\n');
    if (broken === 'linked') {
      const moved = path.join(root, 'moved');
      fs.renameSync(source, moved);
      fs.symlinkSync(moved, source, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (broken === 'linked checkout') {
      const moved = path.join(root, 'moved');
      fs.renameSync(source, moved);
      git(moved, 'worktree', 'add', '--detach', source, 'HEAD');
    }
    const status = runCli(root, 'status');
    assert.equal(status.status, 1);
    assert.match(status.stdout, /unknown:/);
    assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_HISTORY');
    assert.ok(fs.existsSync(path.join(ws, 'api', '.git')));
  });
}

for (const metadata of ['refs', 'objects/pack', 'logs']) {
  test(`linked source Git ${metadata} is unknown, not durable preservation`, { timeout: 30000 }, (t) => {
    const { root, ws } = fixture(t);
    const sourcePath = path.join(root, '.git', ...metadata.split('/'));
    const target = path.join(ws, '.git', ...metadata.split('/'));
    fs.rmSync(sourcePath, { recursive: true });
    fs.symlinkSync(target, sourcePath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(history(root).state, 'unknown');
    assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => ['WORKSPACE_HISTORY', 'WORKSPACE_DIRTY'].includes(e.code));
  });
}

for (const indirection of ['linked directory', 'external table paths']) {
  test(`source reftable ${indirection} is unknown, not durable preservation`, { timeout: 30000 }, (t) => {
    const root = fs.realpathSync.native(makeTempDir(t));
    const initialized = spawnSync('git', ['init', '-q', '-b', 'main', '--ref-format=reftable'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    if (initialized.status !== 0) {
      t.skip('Git does not support the reftable backend');
      return;
    }
    api.initProject(root);
    git(root, 'add', '.workler');
    commit(root, 'initial reftable history');
    const ws = api.createWorkspace(root, { name: 'feat' }).path;
    const oid = commit(ws);
    importCommit(root, ws, oid);
    assert.equal(history(root).state, 'safe', 'ordinary independent reftable storage is supported');
    const sourceTables = path.join(root, '.git', 'reftable');
    const stored = path.join(ws, '.git', 'source-reftable');
    if (indirection === 'linked directory') {
      fs.renameSync(sourceTables, stored);
      fs.symlinkSync(stored, sourceTables, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      // Git accepts external table paths even without symbolic links.
      fs.mkdirSync(stored);
      const names = fs.readFileSync(path.join(sourceTables, 'tables.list'), 'utf8').trim().split('\n');
      for (const name of names) fs.renameSync(path.join(sourceTables, name), path.join(stored, name));
      const relative = path.relative(sourceTables, stored).split(path.sep).join('/');
      fs.writeFileSync(path.join(sourceTables, 'tables.list'), names.map((name) => `${relative}/${name}`).join('\n') + '\n');
      assert.equal(git(root, 'rev-parse', 'refs/heads/kept'), oid, 'Git accepts the external table paths');
    }
    blocked(root, 'feat', 'unknown');
    assert.ok(fs.existsSync(stored), 'the source ref store must survive the refusal');
  });
}

test('commit-graph acceleration cannot hide missing source commit objects', { timeout: 30000 }, (t) => {
  const { root } = fixture(t);
  const oid = git(root, 'rev-parse', 'HEAD');
  git(root, 'commit-graph', 'write', '--reachable');
  fs.unlinkSync(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  assert.equal(history(root).state, 'unknown');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => ['WORKSPACE_HISTORY', 'WORKSPACE_DIRTY'].includes(e.code));
});

test('pushed history still blocks until source has a durable imported ref', { timeout: 30000 }, (t) => {
  const root = makeProject(t);
  addOrigin(t, root);
  const ws = api.createWorkspace(root, { name: 'feat' }).path;
  const oid = commit(ws);
  git(ws, 'push', '-q', 'origin', 'feat');
  git(root, 'fetch', '-q', 'origin');
  blocked(root);
  git(root, 'branch', 'kept-pushed', oid);
  api.removeWorkspace(root, 'feat');
});

test('a local reflog old-value commit stays protected even when a stale remote cache names it', { timeout: 30000 }, (t) => {
  const root = makeProject(t);
  const remote = addOrigin(t, root);
  const ws = api.createWorkspace(root, { name: 'feat' }).path;
  const base = git(ws, 'rev-parse', 'HEAD');
  const oid = commit(ws, 'local recovery work');
  git(ws, 'push', '-q', 'origin', 'feat');
  git(remote, 'update-ref', '-d', 'refs/heads/feat');
  git(ws, 'reset', '--hard', base);
  for (const name of ['HEAD', 'refs/heads/feat']) {
    const file = path.join(ws, '.git', 'logs', name);
    const records = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(file, records[records.length - 1] + '\n');
  }
  assert.equal(git(ws, 'rev-parse', 'refs/remotes/origin/feat'), oid, 'the remote cache can be stale');
  assert.ok(git(ws, 'rev-list', '--all', '--reflog').includes(oid));
  blocked(root);
  assert.ok(history(root).commits.includes(oid));
  importCommit(root, ws, oid);
  api.removeWorkspace(root, 'feat');
});

test('creation warns when linked source Git metadata cannot support verified removal', { timeout: 30000 }, (t) => {
  const root = makeProject(t);
  const linked = path.join(makeTempDir(t), 'linked');
  git(root, 'worktree', 'add', '--detach', linked, 'HEAD');
  const plan = api.planWorkspaceCreation(linked, { name: 'feat' });
  assert.ok(plan.warnings.some((warning) => /linked Git directory/.test(warning)));
  const messages = [];
  api.createWorkspace(linked, { name: 'feat', onProgress: (message) => messages.push(message) });
  assert.ok(messages.some((message) => /normal removal will refuse/.test(message)));
  assert.equal(history(linked).state, 'unknown');
  assert.throws(() => api.removeWorkspace(linked, 'feat'), { code: 'WORKSPACE_HISTORY' });
});

test('group creation warns about a linked member source before cloning', { timeout: 30000 }, (t) => {
  const root = group(t);
  const source = path.join(root, 'web');
  const moved = path.join(root, 'moved');
  fs.renameSync(source, moved);
  git(moved, 'worktree', 'add', '--detach', source, 'HEAD');
  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.ok(plan.warnings.some((warning) => /web uses a linked Git directory/.test(warning)));
  const messages = [];
  api.createWorkspace(root, { name: 'feat', onProgress: (message) => messages.push(message) });
  assert.ok(messages.some((message) => /web uses a linked Git directory/.test(message)));
  assert.throws(() => api.removeWorkspace(root, 'feat'), { code: 'WORKSPACE_HISTORY' });
});

test('opted-in listings omit history where no history assessment applies', { timeout: 30000 }, (t) => {
  const { root } = fixture(t);
  assert.equal(Object.hasOwn(api.listWorkspaces(root, { history: true })[0], 'history'), false);
  const groupRoot = group(t);
  const ws = api.createWorkspace(groupRoot, { name: 'feat' }).path;
  fs.rmSync(path.join(ws, 'web'), { recursive: true });
  const rows = api.listWorkspaces(groupRoot, { history: true });
  assert.ok(rows[0].projects.every((member) => !Object.hasOwn(member, 'history')));
  const feature = rows.find((row) => row.name === 'feat');
  assert.equal(Object.hasOwn(feature, 'history'), false);
  assert.equal(Object.hasOwn(feature.projects.find((member) => member.project === 'web'), 'history'), false);
  assert.equal(feature.projects.find((member) => member.project === 'api').history.state, 'safe');
});

test('history labels truncate Unicode by code point without splitting surrogate pairs', () => {
  const { historyLabel } = require('../dist/history');
  const { displayPath } = require('../dist/git');
  assert.equal(historyLabel('a'.repeat(199) + '🚀' + 'tail'), displayPath('a'.repeat(199) + '🚀...'));
});

test('history listing is opt-in and does not slow ordinary CLI/API listings', { timeout: 30000 }, (t) => {
  const { root, ws } = fixture(t);
  commit(ws);
  const historyModule = require('../dist/history');
  const original = historyModule.targetHistory;
  historyModule.targetHistory = () => { throw new Error('unexpected expensive history proof'); };
  try {
    const row = api.listWorkspaces(root).find((entry) => entry.name === 'feat');
    assert.equal(Object.hasOwn(row, 'history'), false);
    assert.equal(api.listWorkspaces(root, { history: false }).length, 2);
  } finally {
    historyModule.targetHistory = original;
  }
  assert.equal(history(root).state, 'unsafe');
  assert.equal(runCli(root, 'list').status, 0);
  assert.throws(() => api.listWorkspaces(root, { history: 'yes' }), { code: 'INVALID_OPTIONS' });
});

test('file-clean and history-preserved are independent, and nested workspaces still block', { timeout: 30000 }, (t) => {
  const { root, ws } = fixture(t);
  api.createWorkspace(ws, { name: 'child' });
  assert.equal(history(root).state, 'safe');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_DIRTY');
  const status = runCli(root, 'status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /feat\s+feat\s+no upstream\s+clean\s+preserved in source/);
  api.removeWorkspace(ws, 'child');
  fs.writeFileSync(path.join(ws, 'untracked.txt'), 'not backed up');
  assert.equal(history(root).state, 'safe');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (e) => e.code === 'WORKSPACE_DIRTY');
});
