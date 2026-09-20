'use strict';
// --copy-links: `link` rules materialized as independent copies, both for a
// new workspace and when converting one that was created with symlinks.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeProject, runCli } = require('./helpers');

const RULES = 'copy .env\nlink node_modules\n';

function isRealDirectory(target) {
  return fs.lstatSync(target).isDirectory();
}

test('createWorkspace copyLinks copies link rules and records the mode', (t) => {
  const root = makeProject(t, { workler: RULES });
  const ws = api.createWorkspace(root, { name: 'solo', copyLinks: true });

  assert.strictEqual(ws.copyLinks, true);
  assert.deepStrictEqual(
    ws.rules.results.map((r) => [r.action, r.targetPath, r.status, r.copiedLink === true]),
    [['copy', '.env', 'applied', false], ['link', 'node_modules', 'applied', true]],
  );
  const copied = path.join(ws.path, 'node_modules');
  assert.ok(isRealDirectory(copied), 'a copied link must not be a symlink');
  assert.strictEqual(fs.readFileSync(path.join(copied, 'marker.txt'), 'utf8'), 'marker\n');
  assert.strictEqual(git(ws.path, 'config', '--get', 'workler.copyLinks'), 'true');

  // Independent: a change in the workspace does not reach the main project.
  fs.writeFileSync(path.join(copied, 'marker.txt'), 'workspace only\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'node_modules', 'marker.txt'), 'utf8'), 'marker\n');

  const linked = api.createWorkspace(root, { name: 'shared' });
  assert.strictEqual(linked.copyLinks, false);
  assert.ok(fs.lstatSync(path.join(linked.path, 'node_modules')).isSymbolicLink());
  assert.throws(
    () => api.createWorkspace(root, { name: 'bad', copyLinks: 'yes' }),
    (e) => e.code === 'INVALID_OPTIONS' && /copyLinks must be a boolean/.test(e.message),
  );
});

test('add --copy-links plans and creates copies via the CLI', (t) => {
  const root = makeProject(t, { workler: RULES });

  const plan = runCli(root, 'add', 'solo', '--copy-links', '--dry-run');
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /would {2}copy node_modules -> .*\(link rule, copied instead\)/);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'solo')));

  const add = runCli(root, 'add', 'solo', '--copy-links');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.match(add.stdout, /^copied node_modules \(link rule, copied instead\)$/m);
  assert.ok(isRealDirectory(path.join(root, '.worktrees', 'solo', 'node_modules')));
});

test('apply --copy-links converts an existing linked workspace without --force', (t) => {
  const root = makeProject(t, { workler: RULES });
  const ws = api.createWorkspace(root, { name: 'feat' });
  const destination = path.join(ws.path, 'node_modules');
  assert.ok(fs.lstatSync(destination).isSymbolicLink());

  const plan = runCli(root, 'apply', 'feat', '--copy-links', '--dry-run');
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /would {2}copy node_modules .*\(replacing existing symlink to the source\)/);
  assert.ok(fs.lstatSync(destination).isSymbolicLink(), 'dry-run must not convert');
  assert.throws(() => git(ws.path, 'config', '--get', 'workler.copyLinks'), 'dry-run must not record the mode');

  const convert = runCli(root, 'apply', 'feat', '--copy-links');
  assert.strictEqual(convert.status, 0, convert.stderr);
  assert.match(convert.stdout, /^copied node_modules \(link rule, copied instead\) \(replaced existing symlink to the source\)$/m);
  assert.ok(isRealDirectory(destination));
  assert.strictEqual(fs.readFileSync(path.join(destination, 'marker.txt'), 'utf8'), 'marker\n');
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'marker.txt')), 'the source must survive the conversion');
  assert.deepStrictEqual(
    fs.readdirSync(ws.path).filter((name) => name.startsWith('.workler-')),
    [],
    'temporary replacement entries must be cleaned up',
  );

  // The mode sticks: plain apply (and --all) keep the copy instead of
  // reporting it as a conflict with the link rule.
  const again = runCli(root, 'apply', '--all');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /^ok {5}link node_modules \(destination matches source\)$/m);
  assert.ok(isRealDirectory(destination));
});

test('apply --copy-links still needs --force for destinations holding other data', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  const ws = api.createWorkspace(root, { name: 'feat' });
  const destination = path.join(ws.path, 'node_modules');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'local.txt'), 'local work\n');

  const refused = runCli(root, 'apply', 'feat', '--copy-links');
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /cannot link node_modules: destination already exists and differs/);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'local.txt'), 'utf8'), 'local work\n');

  const forced = runCli(root, 'apply', 'feat', '--force');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /^copied node_modules .*\(replaced existing directory\)$/m, 'the refused run already recorded the mode');
  assert.ok(!fs.existsSync(path.join(destination, 'local.txt')));
});

test('apply --no-copy-links returns to symlinks and treats the copies as data', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  const ws = api.createWorkspace(root, { name: 'solo', copyLinks: true });
  const destination = path.join(ws.path, 'node_modules');

  const both = runCli(root, 'apply', 'solo', '--copy-links', '--no-copy-links');
  assert.strictEqual(both.status, 1);
  assert.match(both.stderr, /cannot combine --copy-links with --no-copy-links/);

  const refused = runCli(root, 'apply', 'solo', '--no-copy-links');
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /cannot link node_modules: destination already exists/);
  assert.ok(isRealDirectory(destination));

  const forced = runCli(root, 'apply', 'solo', '--no-copy-links', '--force');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /^linked node_modules \(replaced existing directory\)$/m);
  assert.ok(fs.lstatSync(destination).isSymbolicLink());
  assert.throws(() => git(ws.path, 'config', '--get', 'workler.copyLinks'));
});

test('copied links keep relative symlinks inside the tree relative', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'));
  try {
    fs.symlinkSync(path.join('..', 'marker.txt'), path.join(root, 'node_modules', '.bin', 'marker'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a file symlink is unavailable on this Windows host');
      return;
    }
    throw error;
  }

  const ws = api.createWorkspace(root, { name: 'solo', copyLinks: true });
  const bin = path.join(ws.path, 'node_modules', '.bin', 'marker');
  assert.strictEqual(fs.readlinkSync(bin), path.join('..', 'marker.txt'));
  assert.strictEqual(
    fs.realpathSync(bin),
    fs.realpathSync(path.join(ws.path, 'node_modules', 'marker.txt')),
    'an inner link must resolve inside the copy, not back into the main project',
  );

  const again = runCli(root, 'apply', 'solo');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /destination matches source/);
});

test('copied links rebase absolute symlinks that point inside the tree', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  const modules = path.join(root, 'node_modules');
  const outside = path.join(root, 'README.md');
  fs.mkdirSync(path.join(modules, 'pkg'));
  fs.writeFileSync(path.join(modules, 'pkg', 'index.js'), 'original\n');
  fs.mkdirSync(path.join(modules, '.bin'));
  try {
    fs.symlinkSync(path.join(modules, 'pkg', 'index.js'), path.join(modules, '.bin', 'pkg'));
    fs.symlinkSync(path.join(modules, 'pkg'), path.join(modules, 'alias'));
    fs.symlinkSync(outside, path.join(modules, 'outside'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a symlink is unavailable on this Windows host');
      return;
    }
    throw error;
  }

  const assertIndependent = (ws, label) => {
    const copied = path.join(ws.path, 'node_modules');
    assert.strictEqual(
      fs.realpathSync(path.join(copied, '.bin', 'pkg')),
      fs.realpathSync(path.join(copied, 'pkg', 'index.js')),
      `${label}: a file link must resolve inside the copy`,
    );
    assert.strictEqual(
      fs.realpathSync(path.join(copied, 'alias')),
      fs.realpathSync(path.join(copied, 'pkg')),
      `${label}: a directory link must resolve inside the copy`,
    );
    assert.strictEqual(fs.readlinkSync(path.join(copied, 'outside')), outside, `${label}: other absolute links stay verbatim`);

    fs.writeFileSync(path.join(copied, 'alias', 'index.js'), 'changed in workspace\n');
    assert.strictEqual(fs.readFileSync(path.join(modules, 'pkg', 'index.js'), 'utf8'), 'original\n', label);
    fs.writeFileSync(path.join(copied, 'alias', 'index.js'), 'original\n');

    const again = runCli(root, 'apply', ws.name);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /destination matches source/, label);
  };

  assertIndependent(api.createWorkspace(root, { name: 'fresh', copyLinks: true }), 'fresh copy');

  // Converting goes through a staged sibling that is renamed into place; the
  // links must follow the tree there rather than name the staging path.
  const linked = api.createWorkspace(root, { name: 'converted' });
  const converted = runCli(root, 'apply', 'converted', '--copy-links');
  assert.strictEqual(converted.status, 0, converted.stderr);
  assertIndependent(linked, 'converted copy');
});

test('apply --no-copy-links fails when the mode cannot be cleared', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  const ws = api.createWorkspace(root, { name: 'solo', copyLinks: true });
  const destination = path.join(ws.path, 'node_modules');
  const lock = `${path.resolve(ws.path, git(ws.path, 'rev-parse', '--git-path', 'config'))}.lock`;
  fs.writeFileSync(lock, '');

  const blocked = runCli(root, 'apply', 'solo', '--no-copy-links', '--force');
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /config --local --unset-all workler\.copyLinks failed/);
  assert.ok(isRealDirectory(destination), 'the copies must stay while the mode is still recorded');

  fs.rmSync(lock);
  const forced = runCli(root, 'apply', 'solo', '--no-copy-links', '--force');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.ok(fs.lstatSync(destination).isSymbolicLink());
  // Clearing an already absent key is not a failure.
  const repeated = runCli(root, 'apply', 'solo', '--no-copy-links');
  assert.strictEqual(repeated.status, 0, repeated.stderr);
});

test('a nested workspace copies through its parent\'s link', (t) => {
  const root = makeProject(t, { workler: 'link node_modules\n' });
  const parent = api.createWorkspace(root, { name: 'parent' });
  assert.ok(fs.lstatSync(path.join(parent.path, 'node_modules')).isSymbolicLink());

  const child = api.createWorkspace(parent.path, { name: 'child', copyLinks: true });
  const copied = path.join(child.path, 'node_modules');
  assert.ok(isRealDirectory(copied), 'copying a symlinked source must yield files, not another link');
  assert.strictEqual(fs.readFileSync(path.join(copied, 'marker.txt'), 'utf8'), 'marker\n');
});
