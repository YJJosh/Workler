'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeProject, makeTempDir, recordedPaths, runCli } = require('./helpers');

// node itself as a portable setup command; quoted for paths with spaces.
const NODE = `"${process.execPath}"`;

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

test('remove does not count what the rules produce, ignored or not, but everything else still counts', (t) => {
  const stamp = `${NODE} -e "require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/stamp.txt', 'x')"`;
  const root = makeProject(t, { workler: `copy .env\nlink node_modules\nsetup --if-missing out/stamp.txt ${stamp}\n` });
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nnode_modules\nlocal.db\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'ignore local files');
  const workspace = api.createWorkspace(root, { name: 'feat' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;

  // The copied (ignored) .env, the linked (ignored) node_modules and the
  // untracked out/stamp.txt the guarded command made are all rule outputs.
  for (const output of ['.env', 'node_modules', path.join('out', 'stamp.txt')]) {
    assert.ok(fs.existsSync(path.join(workspace.path, output)), output);
  }
  assert.strictEqual(clean(), true, 'rule outputs are not local data');
  // Editing a copied file makes it data: apply refuses to replace a copy that
  // differs from its source without --force, so removing it would lose the
  // edit. Back in line with the source, it is output again.
  fs.appendFileSync(path.join(workspace.path, '.env'), 'MORE=1\n');
  assert.strictEqual(clean(), false, 'an edited copy is data');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  fs.writeFileSync(path.join(workspace.path, '.env'), 'SECRET=1\n');
  assert.strictEqual(clean(), true);

  // An ignored file no rule produced is data, as before.
  fs.writeFileSync(path.join(workspace.path, 'local.db'), 'rows\n');
  assert.strictEqual(clean(), false, 'the listing must agree with remove');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  fs.rmSync(path.join(workspace.path, 'local.db'));

  // So is an untracked file next to a rule output inside the folder git
  // reports as one entry.
  fs.writeFileSync(path.join(workspace.path, 'out', 'notes.txt'), 'wip\n');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  fs.rmSync(path.join(workspace.path, 'out', 'notes.txt'));

  // And a nested workspace, until it is removed itself (the empty .worktrees/
  // its lock leaves behind does not count).
  api.createWorkspace(workspace.path, { name: 'inner', setup: false });
  assert.strictEqual(clean(), false);
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  api.removeWorkspace(workspace.path, 'inner');
  assert.ok(fs.existsSync(path.join(workspace.path, '.worktrees')));

  assert.strictEqual(clean(), true);
  const removed = runCli(root, 'remove', 'feat');
  assert.strictEqual(removed.status, 0, removed.stderr);
  assert.ok(!fs.existsSync(workspace.path));
  // The sources behind the copy and the link are untouched.
  assert.strictEqual(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'marker.txt')));
});

test('a rule destination whose source is missing in the main project is data, not output', (t) => {
  // `copy .env` is committed but the main project has no .env: apply skips the
  // rule, so nothing regenerates a .env a user then makes in the workspace.
  const root = makeProject(t, { workler: 'copy .env\n' });
  fs.rmSync(path.join(root, '.env'), { force: true });
  assert.ok(!fs.existsSync(path.join(root, '.env')));
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'ignore local env');
  const workspace = api.createWorkspace(root, { name: 'feat' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;
  assert.strictEqual(clean(), true, 'nothing was copied, nothing is there');

  fs.writeFileSync(path.join(workspace.path, '.env'), 'SECRET=mine\n');
  assert.strictEqual(clean(), false, 'a hand-made .env with no source behind it is data');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8'), 'SECRET=mine\n');

  // Once the main project has a source, the hand-made .env still differs from
  // it, so apply refuses it and it stays data until apply --force replaces it.
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  assert.strictEqual(clean(), false, 'a source appearing later does not claim what is there');
  assert.strictEqual(runCli(root, 'apply', 'feat').status, 1);
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8'), 'SECRET=mine\n');
  const forced = runCli(root, 'apply', 'feat', '--force');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.strictEqual(clean(), true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
});

test('a rule added after a workspace has its own file there does not claim it', (t) => {
  // A workspace made before `copy .env` and `link node_modules` existed has
  // its own .env and its own installed node_modules. Adding the rules later
  // must not make them output: apply refuses to replace either without
  // --force, so remove must not delete them without it.
  const root = makeProject(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nnode_modules\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'ignore local files');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'marker.txt'), 'marker\n');
  const workspace = api.createWorkspace(root, { name: 'old' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'old').clean;
  fs.writeFileSync(path.join(workspace.path, '.env'), 'SECRET=mine\n');
  fs.mkdirSync(path.join(workspace.path, 'node_modules'));
  fs.writeFileSync(path.join(workspace.path, 'node_modules', 'marker.txt'), 'installed here\n');
  assert.strictEqual(clean(), false);

  fs.writeFileSync(path.join(root, '.workler'), 'copy .env\nlink node_modules\n');
  assert.strictEqual(clean(), false, 'adding the rules does not turn what is there into output');
  assert.throws(() => api.removeWorkspace(root, 'old'), (error) => error.code === 'WORKSPACE_DIRTY');
  assert.strictEqual(runCli(root, 'apply', 'old').status, 1, 'apply refuses them too');
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, '.env'), 'utf8'), 'SECRET=mine\n');

  // The .env alone matching its source is not enough while the directory
  // where the link belongs holds its own install.
  fs.writeFileSync(path.join(workspace.path, '.env'), 'SECRET=1\n');
  assert.strictEqual(clean(), false);

  // A link that resolves to the source is output, and so is the copy
  // `apply --copy-links` makes of it, while it matches.
  fs.rmSync(path.join(workspace.path, 'node_modules'), { recursive: true });
  const linked = runCli(root, 'apply', 'old');
  assert.strictEqual(linked.status, 0, linked.stderr);
  assert.strictEqual(clean(), true);
  const copied = runCli(root, 'apply', 'old', '--copy-links');
  assert.strictEqual(copied.status, 0, copied.stderr);
  assert.ok(!fs.lstatSync(path.join(workspace.path, 'node_modules')).isSymbolicLink());
  assert.strictEqual(clean(), true, 'a copy of the linked content that matches it is output');
  fs.writeFileSync(path.join(workspace.path, 'node_modules', 'marker.txt'), 'patched\n');
  assert.strictEqual(clean(), false, 'a patched copy is data');
  assert.throws(() => api.removeWorkspace(root, 'old'), (error) => error.code === 'WORKSPACE_DIRTY');
});

test('a recorded guard path keeps the whitespace it is spelled with', (t) => {
  // `git config -z` returns " leading.txt" with its space; reading it back
  // must not trim it, or the record would no longer name the guard path.
  const make = `${NODE} -e "require('fs').writeFileSync(' leading.txt', 'x')"`;
  const root = makeProject(t, { workler: `setup --if-missing " leading.txt" ${make}\n` });
  const workspace = api.createWorkspace(root, { name: 'feat' });
  assert.ok(fs.existsSync(path.join(workspace.path, ' leading.txt')));
  assert.strictEqual(api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean, true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
});

test("the main checkout's rule sources are local data, not rule outputs", (t) => {
  // In the main checkout .env is the source of `copy .env`, not something
  // apply regenerates, so the listing's `clean` for main has to count it.
  const root = makeProject(t, { workler: 'copy .env\n' });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-qm', 'ignore local env');
  const mainClean = () => api.listWorkspaces(root).find((entry) => entry.isMain).clean;
  assert.strictEqual(mainClean(), false, 'the ignored .env in main is data');
  // Nothing else in main counts: with the .env gone, main is clean.
  // Remove it (a rename inside the repo would itself be an untracked file).
  fs.rmSync(path.join(root, '.env'));
  assert.strictEqual(mainClean(), true);
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  assert.strictEqual(mainClean(), false);

  // The copy of it in a workspace is output, as before.
  api.createWorkspace(root, { name: 'feat' });
  assert.strictEqual(api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean, true);
});

test('a guard path is rule output only once its guarded command made it', (t) => {
  const stamp = `${NODE} -e "require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/stamp.txt', 'x')"`;
  const root = makeProject(t, { workler: `setup --if-missing out/stamp.txt ${stamp}\n` });
  // Created without running setup: whatever turns up at the guard path is the user's.
  const workspace = api.createWorkspace(root, { name: 'feat', setup: false });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;
  const recorded = () => {
    try {
      return recordedPaths(git(workspace.path, 'config', '--get-all', 'workler.setupOutput').split(/\r?\n/)).join('\n');
    } catch (_) {
      return '';
    }
  };
  assert.strictEqual(clean(), true);
  assert.strictEqual(recorded(), '');

  fs.mkdirSync(path.join(workspace.path, 'out'));
  fs.writeFileSync(path.join(workspace.path, 'out', 'stamp.txt'), 'mine\n');
  assert.strictEqual(clean(), false, 'a hand-made file at the guard path is data');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  // Running setup now skips the command (the path exists), which proves
  // nothing about who made the path: still data.
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[0].status, 'skipped');
  assert.strictEqual(recorded(), '');
  assert.strictEqual(clean(), false);
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, 'out', 'stamp.txt'), 'utf8'), 'mine\n');

  // Once the command itself has made the path, it is on record and exempt.
  fs.rmSync(path.join(workspace.path, 'out'), { recursive: true });
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[0].status, 'ok');
  assert.strictEqual(recorded(), 'out/stamp.txt');
  assert.strictEqual(clean(), true, 'what the command made is output');
  // A re-run that skips the command keeps the record as it is.
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[0].status, 'skipped');
  assert.strictEqual(recorded(), 'out/stamp.txt');
  assert.strictEqual(clean(), true);

  // The record only means something for a guard line the project still has.
  fs.writeFileSync(path.join(root, '.workler'), '');
  assert.strictEqual(clean(), false, 'no guard line, no output');
  fs.writeFileSync(path.join(root, '.workler'), `setup --if-missing out/stamp.txt ${stamp}\n`);
  assert.strictEqual(clean(), true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
});

test('a recorded guard path stops counting as output once something else takes its entry\'s place', (t) => {
  const make = `${NODE} -e "require('fs').writeFileSync('generated.txt', 'x')"`;
  const root = makeProject(t, { workler: `setup --if-missing generated.txt ${make}\n` });
  const workspace = api.createWorkspace(root, { name: 'feat' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;
  const file = path.join(workspace.path, 'generated.txt');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'x');
  assert.strictEqual(clean(), true, 'what the command made is output');

  // The output is deleted and a file of the user's put at the path before
  // setup runs again: the record still names the path, but not this entry.
  fs.rmSync(file);
  fs.writeFileSync(file, 'mine\n');
  assert.strictEqual(clean(), false, 'a file in place of the recorded entry is data');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  // setup skips the command (the path exists) and does not adopt the file.
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[0].status, 'skipped');
  assert.strictEqual(clean(), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'mine\n');

  // Gone again, the command runs, and the entry it makes is on record.
  fs.rmSync(file);
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[0].status, 'ok');
  assert.strictEqual(clean(), true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
});

test('a guarded command that runs again starts without its earlier record', (t) => {
  const make = `${NODE} -e "require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/stamp.txt', 'x')"`;
  const makeAndDie = `${NODE} -e "require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/stamp.txt', 'half'); process.exit(3)"`;
  const other = `${NODE} -e "require('fs').writeFileSync('other.txt', 'x')"`;
  const config = (command) => `setup --if-missing other.txt ${other}\nsetup --if-missing out/stamp.txt ${command}\n`;
  const root = makeProject(t, { workler: config(make) });
  const workspace = api.createWorkspace(root, { name: 'feat' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;
  const recorded = () => {
    try {
      return recordedPaths(git(workspace.path, 'config', '--get-all', 'workler.setupOutput').split(/\r?\n/));
    } catch (_) {
      return [];
    }
  };
  assert.deepStrictEqual(recorded(), ['other.txt', 'out/stamp.txt']);
  assert.strictEqual(clean(), true);

  // The output is gone, and the command (now broken) dies after re-creating
  // the path. The failure names the leftover; the record must not still call
  // it output, or `remove` would delete the half-made thing without --force.
  fs.rmSync(path.join(workspace.path, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workler'), config(makeAndDie));
  assert.throws(
    () => api.setupWorkspace(root, 'feat'),
    (error) => error.code === 'SETUP_COMMAND_FAILED' && /out\/stamp\.txt now exists/.test(error.message),
  );
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, 'out', 'stamp.txt'), 'utf8'), 'half');
  assert.deepStrictEqual(recorded(), ['other.txt'], 'the guard that ran again is off the record, the other stays');
  assert.strictEqual(clean(), false);
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');

  // Clearing the leftover and fixing the command puts the path back on record.
  fs.rmSync(path.join(workspace.path, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workler'), config(make));
  assert.strictEqual(api.setupWorkspace(root, 'feat').setup.results[1].status, 'ok');
  assert.deepStrictEqual(recorded(), ['other.txt', 'out/stamp.txt']);
  assert.strictEqual(clean(), true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
});

test('a rule whose source sits behind a symlinked parent is not output', (t) => {
  // `copy secrets/.env` with nothing at secrets/ in the main project: apply
  // skips the rule, so a .env the user makes there is data. Once main gets
  // `secrets` as a link to a folder holding a .env, apply refuses to follow
  // it, so still nothing regenerates the workspace's file.
  const root = makeProject(t, { workler: 'copy secrets/.env\n' });
  const workspace = api.createWorkspace(root, { name: 'feat' });
  const clean = () => api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean;
  assert.strictEqual(clean(), true);
  fs.mkdirSync(path.join(workspace.path, 'secrets'));
  fs.writeFileSync(path.join(workspace.path, 'secrets', '.env'), 'SECRET=mine\n');
  assert.strictEqual(clean(), false, 'nothing behind the destination: data');

  const outside = makeTempDir(t, 'workler-secrets-outside-');
  fs.writeFileSync(path.join(outside, '.env'), 'SECRET=theirs\n');
  try {
    fs.symlinkSync(outside, path.join(root, 'secrets'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a junction is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  assert.ok(fs.existsSync(path.join(root, 'secrets', '.env')), 'the source exists, but only through the link');
  assert.strictEqual(clean(), false, 'a source apply refuses to read does not make the destination output');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  assert.strictEqual(fs.readFileSync(path.join(workspace.path, 'secrets', '.env'), 'utf8'), 'SECRET=mine\n');

  // A real folder in its place lets apply read the source; the user's file
  // still differs from it, so it is data until apply --force replaces it.
  fs.unlinkSync(path.join(root, 'secrets'));
  fs.mkdirSync(path.join(root, 'secrets'));
  fs.writeFileSync(path.join(root, 'secrets', '.env'), 'SECRET=1\n');
  assert.strictEqual(clean(), false);
  const forced = runCli(root, 'apply', 'feat', '--force');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.strictEqual(clean(), true);
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(workspace.path));
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
