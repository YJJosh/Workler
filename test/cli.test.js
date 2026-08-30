'use strict';
// Backward-compatibility checks: the CLI commands now delegate to the core
// API but must keep their human output and exit codes.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CLI, makeRepo, makeTempDir, runCli } = require('./helpers');

test('init/add/list/path/remove round-trip via the CLI', (t) => {
  const root = makeRepo(t, { workler: 'copy .env\n' });

  const init = runCli(root, 'init');
  assert.strictEqual(init.status, 0);
  assert.match(init.stdout, /^exists {2}\.workler$/m);
  assert.match(init.stdout, /^ready {3}\.worktrees$/m);
  assert.match(init.stdout, /^ignored \.worktrees\/ in \.git[\\/]info[\\/]exclude$/m);

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0);
  assert.match(add.stdout, /^create branch feat from HEAD$/m);
  assert.match(add.stdout, /^copied \.env$/m);
  assert.match(add.stdout, /^done {3}feat$/m);

  const list = runCli(root, 'list');
  assert.strictEqual(list.status, 0);
  assert.match(list.stdout, /^main\s+main\s+/m);
  assert.match(list.stdout, /^feat\s+feat\s+/m);

  const wsPath = runCli(root, 'path', 'feat');
  assert.strictEqual(wsPath.status, 0);
  assert.strictEqual(
    fs.realpathSync.native(wsPath.stdout.trim()),
    fs.realpathSync.native(path.join(root, '.worktrees', 'feat')),
  );

  // The copied .env is untracked, so plain remove refuses (data-loss guard).
  const removeDirty = runCli(root, 'remove', 'feat');
  assert.strictEqual(removeDirty.status, 1);
  assert.match(removeDirty.stderr, /^workler: workspace has local changes:/m);
  assert.match(removeDirty.stderr, /--force to remove anyway/);

  const removeForced = runCli(root, 'remove', 'feat', '--force');
  assert.strictEqual(removeForced.status, 0);
  assert.match(removeForced.stdout, /^removed feat$/m);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'feat')));
});

test('add works directly in a plain Git repository without .workler or init', (t) => {
  const root = makeRepo(t, { includeWorkler: false });
  const subdir = path.join(root, 'src');
  fs.mkdirSync(subdir);

  const add = runCli(subdir, 'add', 'plain');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.match(add.stdout, /^no workspace rules$/m);
  assert.ok(fs.existsSync(path.join(root, '.worktrees', 'plain', '.git')));
  assert.ok(!fs.existsSync(path.join(root, '.workler')));

  const list = runCli(subdir, 'list');
  assert.strictEqual(list.status, 0, list.stderr);
  assert.match(list.stdout, /^plain\s+plain\s+/m);
  const status = runCli(subdir, 'status');
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^plain\s+plain\s+/m);
  const remove = runCli(subdir, 'remove', 'plain', '--force');
  assert.strictEqual(remove.status, 0, remove.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'plain')));
});

test('add --dry-run plans without creating anything', (t) => {
  const root = makeRepo(t, { workler: 'copy .env\n' });
  runCli(root, 'init');

  const dry = runCli(root, 'add', 'exp', '--dry-run');
  assert.strictEqual(dry.status, 0);
  assert.match(dry.stdout, /^dry run: nothing will be created$/m);
  assert.match(dry.stdout, /^would create branch exp from HEAD$/m);
  assert.match(dry.stdout, /^would {2}copy \.env -> /m);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'exp')));
});

test('CLI errors keep their messages and exit code 1', (t) => {
  const root = makeRepo(t);
  runCli(root, 'init');
  runCli(root, 'add', 'feat');

  const clash = runCli(root, 'add', 'feat');
  assert.strictEqual(clash.status, 1);
  assert.match(clash.stderr, /^workler: workspace already exists:/m);

  const branchClash = runCli(root, 'add', 'feat2', '--branch', 'x', '--checkout', 'y');
  assert.strictEqual(branchClash.status, 1);
  assert.match(branchClash.stderr, /--branch and --checkout cannot be used together/);

  const unknown = runCli(root, 'frobnicate');
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /^workler: unknown command: frobnicate/m);

  const help = runCli(root, 'help');
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('every documented command accepts -h/--help without requiring a project', (t) => {
  const root = makeTempDir(t);
  for (const command of ['init', 'list', 'path', 'shell-init', 'add', 'apply', 'remove', 'status', 'fetch', 'sync', 'branch-sync']) {
    for (const helpFlag of ['-h', '--help']) {
      const result = runCli(root, command, helpFlag);
      assert.strictEqual(result.status, 0, `${command} ${helpFlag} must exit 0: ${result.stderr}`);
      assert.match(result.stdout, /^usage:/m, `${command} ${helpFlag} must print usage`);
      assert.strictEqual(result.stderr, '');
    }
  }
});

test('shell-init preserves the invoked executable name', (t) => {
  const aliasName = 'devworkler-test';
  const aliasPath = path.join(path.dirname(CLI), `${aliasName}.js`);
  t.after(() => fs.rmSync(aliasPath, { force: true }));
  fs.copyFileSync(CLI, aliasPath);

  const result = spawnSync(process.execPath, [aliasPath, 'shell-init'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`dest="$(${aliasName} path "$1")"`));
});

test('shell-init accepts the executable name supplied by a platform shim', () => {
  const result = spawnSync(process.execPath, [CLI, 'shell-init'], {
    encoding: 'utf8',
    env: { ...process.env, WORKLER_INVOKED_AS: 'devworkler' },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('dest="$(devworkler path "$1")"'));
});

test('--version/-v/version print the package version', (t) => {
  const root = makeRepo(t);
  const { version } = require('../package.json');

  for (const flag of ['--version', '-v', 'version']) {
    const result = runCli(root, flag);
    assert.strictEqual(result.status, 0, `${flag} must exit 0`);
    // Bare version, like `npm --version`: parseable without stripping a prefix.
    assert.strictEqual(result.stdout.trim(), version, `${flag} must print ${version}`);
    assert.strictEqual(result.stderr, '');
  }

  // `help` keeps its decorated form, and it must not drift from package.json.
  assert.match(runCli(root, 'help').stdout, new RegExp(`^workler ${version.replace(/\./g, '\\.')}$`, 'm'));
});

test('status and sync still run after the refactor', (t) => {
  const root = makeRepo(t);
  runCli(root, 'init');
  runCli(root, 'add', 'feat');

  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0);
  assert.match(status.stdout, /^NAME\s+BRANCH\s+UPSTREAM\s+STATE$/m);
  assert.match(status.stdout, /^feat\s+feat\s+no upstream\s+clean$/m);

  const sync = runCli(root, 'sync');
  assert.strictEqual(sync.status, 0);
  assert.match(sync.stdout, /skipped \(no origin remote\)/);
});
