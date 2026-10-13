'use strict';
// `setup <command>` lines in .workler: parsing, running them at the end of
// `add`, re-running them with `workler setup`, and the failure contract.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, CLI, git, makeRepo, makeProject, makeTempDir, recordedPaths, runCli } = require('./helpers');

// Shell commands that work under sh and cmd.exe alike by running node itself.
// node is quoted because its path may contain spaces (Program Files).
const NODE = `"${process.execPath}"`;

// Appends one line to <cwd>/setup.log: the label, the working directory, and
// the WORKLER_* variables, so a test can check order, cwd, and environment.
function logCommand(label) {
  const fields = `['${label}', process.cwd(), process.env.WORKLER_WORKSPACE, process.env.WORKLER_WORKSPACE_PATH, process.env.WORKLER_ROOT]`;
  return `${NODE} -e "require('fs').appendFileSync('setup.log', ${fields}.join('|') + String.fromCharCode(10))"`;
}

// Like logCommand, but first creates <relPath> (a file, or a directory with
// kind 'dir') so a guarded command produces the output its guard names.
function makingCommand(label, relPath, kind = 'file') {
  const fields = `['${label}', process.cwd(), process.env.WORKLER_WORKSPACE, process.env.WORKLER_WORKSPACE_PATH, process.env.WORKLER_ROOT]`;
  const make = kind === 'dir'
    ? `fs.mkdirSync('${relPath}', {recursive: true});`
    : `fs.mkdirSync(require('path').dirname('${relPath}'), {recursive: true}); fs.writeFileSync('${relPath}', '');`;
  return `${NODE} -e "const fs = require('fs'); ${make} fs.appendFileSync('setup.log', ${fields}.join('|') + String.fromCharCode(10))"`;
}

function exitCommand(code) {
  return `${NODE} -e "process.exit(${code})"`;
}

function readLog(workspacePath) {
  return fs
    .readFileSync(path.join(workspacePath, 'setup.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}

test('setup lines parse in order, keep the command verbatim, and ignore full-line comments only', (t) => {
  const workler = [
    '# full-line comment',
    'copy .env   # inline comment on a rule',
    `setup ${logCommand('one')}`,
    '  # indented full-line comment',
    `\tsetup\t${logCommand('two')}   `,
    'setup echo "a # b" # not a comment: handed to the shell as written',
    '',
  ].join('\n');
  const root = makeRepo(t, { workler });

  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.deepStrictEqual(
    plan.setup.map((command) => command.command),
    [logCommand('one'), logCommand('two'), 'echo "a # b" # not a comment: handed to the shell as written'],
  );
  assert.strictEqual(plan.setup[1].raw, `setup\t${logCommand('two')}`);

  // `add --dry-run` lists the commands after the rules, in file order.
  const dry = runCli(root, 'add', 'feat', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  const lines = dry.stdout.split('\n');
  const ruleLine = lines.findIndex((line) => line.startsWith('would  copy .env'));
  const setupLines = lines.filter((line) => line.startsWith('would  setup '));
  assert.ok(ruleLine >= 0);
  assert.strictEqual(setupLines.length, 3);
  assert.ok(lines.indexOf(setupLines[0]) > ruleLine);
  assert.strictEqual(setupLines[2], 'would  setup echo "a # b" # not a comment: handed to the shell as written');
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'feat')));

  const quiet = runCli(root, 'add', 'feat', '--dry-run', '--no-setup');
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.ok(!quiet.stdout.includes('would  setup'));
});

test('an empty setup command is a config error reported before anything is cloned', (t) => {
  const root = makeRepo(t, { workler: 'copy .env\nsetup   \n' });

  assert.throws(
    () => api.createWorkspace(root, { name: 'feat' }),
    (error) => error.code === 'CONFIG_INVALID' && error.details.line === 2 && error.details.column === 6,
  );
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'feat')));

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 1);
  assert.match(add.stderr, /^workler: \.workler:2:6: missing command after "setup"$/m);
  assert.match(add.stderr, /^ {2}expected: a shell command, e\.g\. setup pnpm install$/m);

  // Other spellings stay unknown actions rather than becoming setup lines.
  fs.writeFileSync(path.join(root, '.workler'), 'setup#x echo\n');
  assert.throws(
    () => api.planWorkspaceCreation(root, { name: 'feat' }),
    (error) => error.code === 'CONFIG_INVALID' && /unknown action "setup#x"/.test(error.message),
  );
});

test('add runs the setup commands in order, in the new workspace, with WORKLER_* set', (t) => {
  const root = makeProject(t, { workler: `copy .env\nsetup ${logCommand('one')}\nsetup ${logCommand('two')}\n` });

  const headings = [];
  const ws = api.createWorkspace(root, {
    name: 'feat',
    onSetupCommand: (command, index, total) => headings.push(`${index + 1}/${total} ${command.command}`),
  });
  assert.strictEqual(ws.setup.commandCount, 2);
  assert.deepStrictEqual(
    ws.setup.results.map((result) => result.status),
    ['ok', 'ok'],
  );
  assert.deepStrictEqual(headings, [`1/2 ${logCommand('one')}`, `2/2 ${logCommand('two')}`]);

  // The rules were applied before the first command ran.
  assert.deepStrictEqual(readLog(ws.path), [
    ['one', ws.path, 'feat', ws.path, root],
    ['two', ws.path, 'feat', ws.path, root],
  ]);
  assert.ok(fs.existsSync(path.join(ws.path, '.env')));
  // Nothing ran in the main project.
  assert.ok(!fs.existsSync(path.join(root, 'setup.log')));
});

test('add prints a heading per command and keeps its stdout free of command output', (t) => {
  const root = makeProject(t, {
    workler: `copy .env\nsetup ${NODE} -e "console.log('polluted')"\nsetup ${logCommand('one')}\n`,
  });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  const lines = add.stdout.split('\n');
  const copied = lines.indexOf('copied .env');
  const first = lines.indexOf(`setup  ${NODE} -e "console.log('polluted')"`);
  const second = lines.indexOf(`setup  ${logCommand('one')}`);
  const done = lines.indexOf('done   feat');
  assert.ok(copied >= 0 && first > copied && second > first && done > second, add.stdout);
  assert.match(add.stdout, /^path {3}.*feat$/m);
  // The command's own output went to stderr because add's stdout was a pipe
  // (the heading still names the command, so match the bare output line).
  assert.doesNotMatch(add.stdout, /^polluted$/m);
  assert.match(add.stderr, /^polluted$/m);
});

test('a failing setup command keeps the workspace, exits non-zero, and hints at workler setup', (t) => {
  const root = makeProject(t, {
    workler: `setup ${logCommand('one')}\nsetup ${exitCommand(3)}\nsetup ${logCommand('never')}\n`,
  });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 1);
  assert.match(add.stdout, /^setup {2}.*process\.exit\(3\)/m);
  assert.ok(!add.stdout.includes('done   feat'));
  assert.match(add.stderr, /^workler: setup command failed in .*feat: .*process\.exit\(3\)"? \(exit code 3\)$/m);
  assert.match(add.stderr, /^the workspace was kept; fix the problem and re-run `workler setup feat`$/m);

  const wsPath = path.join(root, '.worktrees', 'feat');
  assert.ok(fs.existsSync(path.join(wsPath, '.git')));
  assert.strictEqual(git(wsPath, 'config', '--get', 'workler.name'), 'feat');
  assert.deepStrictEqual(readLog(wsPath).map((fields) => fields[0]), ['one']);
  // The project lock was released before the commands ran.
  assert.ok(!fs.existsSync(api.projectLockPath(root)));

  // The API reports the same failure with structured details.
  assert.throws(
    () => api.createWorkspace(root, { name: 'feat2' }),
    (error) =>
      error.code === 'SETUP_COMMAND_FAILED' &&
      error.details.name === 'feat2' &&
      error.details.path === path.join(root, '.worktrees', 'feat2') &&
      error.details.exitCode === 3 &&
      error.details.index === 1 &&
      error.details.commandCount === 3 &&
      error.details.results.length === 2,
  );
  assert.ok(fs.existsSync(path.join(root, '.worktrees', 'feat2', '.git')));
});

test('a command that cannot be started reports the results of the commands before it', (t) => {
  // The workspace is moved away right before the third command, so its shell
  // cannot start there (spawn fails with ENOENT instead of the command
  // exiting non-zero). The move happens from the hook, while no command is
  // running: Windows refuses to rename a folder that is some process's cwd,
  // and the shell of a running command has the workspace as its cwd.
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\nsetup ${logCommand('two')}\nsetup ${logCommand('never')}\n` });
  const target = path.join(root, '.worktrees', 'feat');
  assert.throws(
    () =>
      api.createWorkspace(root, {
        name: 'feat',
        onSetupCommand: (_command, index) => {
          if (index === 2) fs.renameSync(target, `${target}-moved`);
        },
      }),
    (error) => {
      assert.strictEqual(error.code, 'SETUP_COMMAND_FAILED', error.message);
      assert.match(error.message, /^setup command could not be started in .*feat: /);
      assert.match(error.message, /the workspace was kept; fix the problem and re-run `workler setup feat`$/);
      assert.strictEqual(error.details.index, 2);
      assert.strictEqual(error.details.commandCount, 3);
      assert.deepStrictEqual(error.details.results.map((result) => result.status), ['ok', 'ok']);
      return true;
    },
  );
  assert.deepStrictEqual(readLog(`${target}-moved`).map((fields) => fields[0]), ['one', 'two']);
});

test('--no-setup / setup: false skip the commands, and add says how many it skipped', (t) => {
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\nsetup ${logCommand('two')}\n` });

  const add = runCli(root, 'add', 'quiet', '--no-setup');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.ok(!add.stdout.includes('setup  '));
  const lines = add.stdout.split('\n');
  const skipped = lines.indexOf('skip   setup (2 commands, --no-setup)');
  assert.ok(skipped >= 0 && skipped < lines.indexOf('done   quiet'), add.stdout);
  assert.ok(!fs.existsSync(path.join(root, '.worktrees', 'quiet', 'setup.log')));

  // The dry run reports the skip the same way instead of listing the plan.
  const dry = runCli(root, 'add', 'dry', '--dry-run', '--no-setup');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^skip {3}setup \(2 commands, --no-setup\)$/m);
  assert.ok(!dry.stdout.includes('would  setup'));

  // One command is singular; without any command nothing is announced.
  fs.writeFileSync(path.join(root, '.workler'), `setup ${logCommand('one')}\n`);
  assert.match(runCli(root, 'add', 'single', '--no-setup').stdout, /^skip {3}setup \(1 command, --no-setup\)$/m);
  const bare = makeProject(t);
  const none = runCli(bare, 'add', 'quiet', '--no-setup');
  assert.strictEqual(none.status, 0, none.stderr);
  assert.ok(!none.stdout.includes('skip   setup'), none.stdout);

  const ws = api.createWorkspace(root, { name: 'api-quiet', setup: false });
  assert.strictEqual(ws.setup, undefined);
  assert.ok(!fs.existsSync(path.join(ws.path, 'setup.log')));
  assert.throws(() => api.createWorkspace(root, { name: 'x', setup: 'no' }), (e) => e.code === 'INVALID_OPTIONS');
});

test('workler setup re-runs the commands for an existing workspace', (t) => {
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\n` });
  const ws = api.createWorkspace(root, { name: 'feat', setup: false });

  const byName = runCli(root, 'setup', 'feat');
  assert.strictEqual(byName.status, 0, byName.stderr);
  assert.match(byName.stdout, /^setup {2}/m);
  assert.match(byName.stdout, /^done {3}feat$/m);
  assert.deepStrictEqual(readLog(ws.path), [['one', ws.path, 'feat', ws.path, root]]);

  // Bare `setup` inside the workspace targets the workspace itself.
  const bare = runCli(ws.path, 'setup');
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(readLog(ws.path).length, 2);

  const fromMain = runCli(root, 'setup');
  assert.strictEqual(fromMain.status, 1);
  assert.match(fromMain.stderr, /^workler: setup needs a workspace name when run from the main project$/m);
  assert.strictEqual(runCli(root, 'setup', 'main').status, 1);
  const missing = runCli(root, 'setup', 'nope');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /^workler: workspace not found: nope$/m);

  // Failures exit non-zero with the same message as add.
  fs.writeFileSync(path.join(root, '.workler'), `setup ${exitCommand(2)}\n`);
  const failed = runCli(root, 'setup', 'feat');
  assert.strictEqual(failed.status, 1);
  assert.match(failed.stderr, /\(exit code 2\)$/m);
  assert.match(failed.stderr, /re-run `workler setup feat`$/m);

  // Without setup lines there is nothing to do.
  fs.writeFileSync(path.join(root, '.workler'), 'copy .env\n');
  const none = runCli(root, 'setup', 'feat');
  assert.strictEqual(none.status, 0, none.stderr);
  assert.strictEqual(none.stdout, 'no setup commands\n');

  // add announces nothing without setup lines: done/path stay the last lines.
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  const plain = runCli(root, 'add', 'plain');
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /no setup commands/);
  assert.match(plain.stdout, /done {3}plain\npath {3}[^\n]+\n$/);
});

test('setupWorkspace runs the commands via the API and refuses main', (t) => {
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\n` });
  const ws = api.createWorkspace(root, { name: 'feat', setup: false });

  const headings = [];
  const result = api.setupWorkspace(root, 'feat', { onSetupCommand: (command) => headings.push(command.command) });
  assert.strictEqual(result.name, 'feat');
  assert.strictEqual(result.path, ws.path);
  assert.strictEqual(result.root, root);
  assert.strictEqual(result.setup.commandCount, 1);
  assert.deepStrictEqual(headings, [logCommand('one')]);
  assert.deepStrictEqual(readLog(ws.path), [['one', ws.path, 'feat', ws.path, root]]);

  assert.throws(() => api.setupWorkspace(root, 'main'), (e) => e.code === 'MAIN_WORKSPACE');
  assert.throws(() => api.setupWorkspace(root, 'nope'), (e) => e.code === 'WORKSPACE_NOT_FOUND');
  assert.throws(() => api.setupWorkspace(root, 'feat', { setupStdout: 'file' }), (e) => e.code === 'INVALID_OPTIONS');

  fs.writeFileSync(path.join(root, '.workler'), `setup ${exitCommand(4)}\n`);
  assert.throws(
    () => api.setupWorkspace(root, 'feat'),
    (error) => error.code === 'SETUP_COMMAND_FAILED' && error.details.exitCode === 4 && error.details.name === 'feat',
  );
});

test('nested workspaces run the setup commands checked out in their immediate parent', (t) => {
  // .workler is COMMITTED, so the parent workspace carries the same lines.
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\n` });
  const featureA = api.createWorkspace(root, { name: 'feature-a', setup: false });

  const agent1 = api.createWorkspace(featureA.path, { name: 'agent-1' });
  assert.strictEqual(agent1.setup.commandCount, 1);
  // WORKLER_ROOT is the immediate parent, not the outermost project.
  assert.deepStrictEqual(readLog(agent1.path), [['one', agent1.path, 'agent-1', agent1.path, featureA.path]]);

  // The parent's CHECKOUT is what counts: an uncommitted edit there changes
  // what its own nested workspaces run, while the root is unaffected.
  fs.writeFileSync(path.join(featureA.path, '.workler'), `setup ${logCommand('edited')}\n`);
  const agent2 = api.createWorkspace(featureA.path, { name: 'agent-2' });
  assert.deepStrictEqual(readLog(agent2.path).map((fields) => fields[0]), ['edited']);
  const sibling = api.createWorkspace(root, { name: 'feature-b' });
  assert.deepStrictEqual(readLog(sibling.path).map((fields) => fields[0]), ['one']);
});

test('the init starter template parses and declares no setup commands', (t) => {
  const root = makeRepo(t, { includeWorkler: false });
  api.initProject(root);
  assert.match(fs.readFileSync(path.join(root, '.workler'), 'utf8'), /^# setup --if-missing node_modules pnpm install$/m);

  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.deepStrictEqual(plan.setup, []);
  const ws = api.createWorkspace(root, { name: 'feat' });
  assert.deepStrictEqual(ws.setup, { commandCount: 0, results: [] });
});

// --- --if-missing --------------------------------------------------------

test('setup --if-missing <path> runs the command only while the path is absent', (t) => {
  const workler = [
    'link node_modules',
    `setup --if-missing node_modules ${makingCommand('install', 'node_modules', 'dir')}`,
    `setup --if-missing "with space/marker.txt" ${makingCommand('quoted', 'with space/marker.txt')}`,
    `setup ${logCommand('always')}`,
    '',
  ].join('\n');
  // makeRepo creates node_modules in the root because the file mentions it,
  // so the link rule resolves and the guarded install must be skipped.
  const root = makeProject(t, { workler });

  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.deepStrictEqual(
    plan.setup.map((command) => [command.ifMissing, command.command]),
    [
      ['node_modules', makingCommand('install', 'node_modules', 'dir')],
      ['with space/marker.txt', makingCommand('quoted', 'with space/marker.txt')],
      [undefined, logCommand('always')],
    ],
  );

  const dry = runCli(root, 'add', 'feat', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^would {2}setup .*install.* \(only if node_modules is missing\)$/m);
  assert.match(dry.stdout, /^would {2}setup .*quoted.* \(only if with space\/marker\.txt is missing\)$/m);

  const skipped = [];
  const ws = api.createWorkspace(root, { name: 'feat', onSetupSkip: (command, index, total) => skipped.push(`${index + 1}/${total} ${command.ifMissing}`) });
  assert.deepStrictEqual(skipped, ['1/3 node_modules']);
  assert.deepStrictEqual(
    ws.setup.results.map((result) => [result.status, result.ifMissing]),
    [['skipped', 'node_modules'], ['ok', undefined], ['ok', undefined]],
  );
  assert.deepStrictEqual(readLog(ws.path).map((fields) => fields[0]), ['quoted', 'always']);
  // What the guarded command made is on record for remove's guard; what the
  // link rule put at node_modules is the rule's output, not the command's.
  assert.ok(fs.existsSync(path.join(ws.path, 'with space', 'marker.txt')));
  const record = git(ws.path, 'config', '--get-all', 'workler.setupOutput');
  assert.match(record, /^\d+:\d+:\d+ with space\/marker\.txt$/, 'the path, behind the identity of the entry the command made');
  assert.deepStrictEqual(recordedPaths([record]), ['with space/marker.txt']);

  // Once the guarded path exists the command is skipped on re-runs too; when
  // it goes away again the command runs.
  const rerun = runCli(root, 'setup', 'feat');
  assert.strictEqual(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /^skip {3}setup .*install.* \(node_modules exists\)$/m);
  assert.match(rerun.stdout, /^skip {3}setup .*quoted.* \(with space\/marker\.txt exists\)$/m);
  assert.match(rerun.stdout, /^done {3}feat$/m);
  assert.deepStrictEqual(readLog(ws.path).map((fields) => fields[0]), ['quoted', 'always', 'always']);

  fs.rmSync(path.join(ws.path, 'node_modules'), { force: true, recursive: true });
  const afterRemoval = api.setupWorkspace(root, 'feat');
  assert.strictEqual(afterRemoval.setup.results[0].status, 'ok');
  assert.deepStrictEqual(readLog(ws.path).map((fields) => fields[0]), ['quoted', 'always', 'always', 'install', 'always']);
  // Now the install made node_modules itself, so it joins the record.
  assert.ok(fs.statSync(path.join(ws.path, 'node_modules')).isDirectory());
  assert.deepStrictEqual(recordedPaths(git(ws.path, 'config', '--get-all', 'workler.setupOutput').split(/\r?\n/)), ['with space/marker.txt', 'node_modules']);

  // A workspace whose link rule found no source (root without node_modules)
  // runs the install: the guard looks at the workspace, not the root.
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  const fresh = api.createWorkspace(root, { name: 'fresh' });
  assert.strictEqual(fresh.setup.results[0].status, 'ok');
  assert.deepStrictEqual(readLog(fresh.path).map((fields) => fields[0]), ['install', 'quoted', 'always']);
});

test('a guarded command that created its path before failing says the re-run would skip it', (t) => {
  // An install that dies half-way leaves node_modules behind. The guard only
  // asks whether the path exists, so the re-run the failure recommends would
  // skip the command and exit 0 as if nothing was wrong. The failure has to say so.
  const halfInstall = `${NODE} -e "require('fs').mkdirSync('node_modules'); process.exit(7)"`;
  const root = makeProject(t, { workler: `setup --if-missing node_modules ${halfInstall}\n` });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 1);
  assert.match(add.stderr, /exit code 7/);
  assert.match(add.stderr, /node_modules now exists, so `workler setup` would skip this command; remove it before re-running/);
  const ws = path.join(root, '.worktrees', 'feat');
  assert.ok(fs.existsSync(path.join(ws, 'node_modules')));

  // The re-run does skip it, which is exactly why the hint exists.
  const again = runCli(root, 'setup', 'feat');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /^skip   setup .* \(node_modules exists\)$/m);

  // Via the API the details name the leftover path.
  fs.rmSync(path.join(ws, 'node_modules'), { recursive: true });
  assert.throws(
    () => api.setupWorkspace(root, 'feat'),
    (error) => error.code === 'SETUP_COMMAND_FAILED' && error.details.leftBehind === 'node_modules' && error.details.exitCode === 7,
  );
});

test('a guarded command that exits 0 without creating its path is reported, and nothing is recorded', (t) => {
  // The guard names another folder than the one the command writes to, the
  // usual slip in a group's line. The command runs again on every setup and
  // nothing is on record, so the run has to say so.
  const wrongFolder = `${NODE} -e "require('fs').mkdirSync('venv')"`;
  const root = makeProject(t, { workler: `setup --if-missing .venv ${wrongFolder}\n` });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.match(
    add.stdout,
    /^warning: \.venv is still missing after `.*` succeeded, so it will run again on every setup; the guard and the command both start from the folder the command runs in$/m,
  );
  const ws = path.join(root, '.worktrees', 'feat');
  assert.ok(fs.existsSync(path.join(ws, 'venv')));
  assert.throws(() => git(ws, 'config', '--get-all', 'workler.setupOutput'), 'nothing on record');

  // Via the API: the callback fires and the result says which guard.
  fs.rmSync(path.join(ws, 'venv'), { recursive: true });
  const seen = [];
  const again = api.setupWorkspace(root, 'feat', { onSetupGuardMissing: (command, index, total) => seen.push(`${index + 1}/${total} ${command.ifMissing}`) });
  assert.deepStrictEqual(seen, ['1/1 .venv']);
  assert.deepStrictEqual(again.setup.results.map((result) => [result.status, result.ifMissing, result.guardMissing]), [['ok', '.venv', true]]);

  // A guard the command does create gets no warning.
  const good = makeProject(t, { workler: `setup --if-missing .venv ${NODE} -e "require('fs').mkdirSync('.venv')"\n` });
  const fine = runCli(good, 'add', 'feat');
  assert.strictEqual(fine.status, 0, fine.stderr);
  assert.doesNotMatch(fine.stdout + fine.stderr, /still missing/);
});

test('a guard is judged once every setup line has run, so a later line that creates the path silences it', (t) => {
  // The first line exits 0 without making `marker`; the second creates it.
  // From then on both are skipped, so warning after the first would be false.
  const noop = `${NODE} -e "0"`;
  const makeMarker = `${NODE} -e "require('fs').mkdirSync('marker')"`;
  const root = makeProject(t, { workler: `setup --if-missing marker ${noop}\nsetup --if-missing marker ${makeMarker}\n` });
  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.doesNotMatch(add.stdout + add.stderr, /still missing/);
  const again = runCli(root, 'setup', 'feat');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual((again.stdout.match(/^skip   setup /gm) ?? []).length, 2, again.stdout);

  // In a group the group's own lines run after its members': a member guard
  // the group's line creates is fine, one nobody creates is reported with
  // the member it belongs to.
  const group = makeGroup(t, {
    rules: { 'projects/api': `setup --if-missing .venv ${noop}\n`, tools: `setup --if-missing .cache ${noop}\n` },
    groupLines: `setup ${NODE} -e "require('fs').mkdirSync('projects/api/.venv')"\n`,
  });
  const groupAdd = runCli(group, 'add', 'feat');
  assert.strictEqual(groupAdd.status, 0, groupAdd.stderr);
  const warnings = groupAdd.stdout.split('\n').filter((line) => line.startsWith('warning:'));
  assert.deepStrictEqual(warnings.length, 1, groupAdd.stdout);
  assert.match(warnings[0], /^warning: in tools, \.cache is still missing after `.*` succeeded/);

  // Via the API the callback names the member, and only the member left without its path.
  fs.rmSync(path.join(group, '.worktrees', 'feat', 'projects', 'api', '.venv'), { recursive: true });
  const seen = [];
  api.setupWorkspace(group, 'feat', { onSetupGuardMissing: (command, index, total, project) => seen.push(`${project} ${command.ifMissing}`) });
  assert.deepStrictEqual(seen, ['tools .cache']);
});

test('a guard that is a link to a missing target stops the run instead of counting as absent', (t) => {
  // `link node_modules` made a link while the main project had one; later the
  // target was deleted. existsSync follows the link and says "absent", but an
  // install would collide with the stale entry. Stop before running it.
  const root = makeProject(t, { workler: `link node_modules\nsetup --if-missing node_modules ${logCommand('install')}\n` });
  // makeProject already creates node_modules; give it content so the link has a real target.
  fs.writeFileSync(path.join(root, 'node_modules', 'marker'), 'x');

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.match(add.stdout, /^skip   setup .* \(node_modules exists\)$/m);
  const ws = path.join(root, '.worktrees', 'feat');
  assert.ok(fs.lstatSync(path.join(ws, 'node_modules')).isSymbolicLink());

  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  const rerun = runCli(root, 'setup', 'feat');
  assert.strictEqual(rerun.status, 1);
  assert.match(rerun.stderr, /node_modules is a link whose target no longer exists/);
  assert.match(rerun.stderr, /remove the link or restore its target, then re-run `workler setup feat`/);
  assert.ok(!fs.existsSync(path.join(ws, 'setup.log')), 'the guarded command must not have run');
});

test('--if-missing paths are validated like rule paths and the option must be spelled right', (t) => {
  const root = makeRepo(t);
  const expectConfigError = (workler, pattern, column) => {
    fs.writeFileSync(path.join(root, '.workler'), workler);
    assert.throws(
      () => api.planWorkspaceCreation(root, { name: 'feat' }),
      (error) => {
        assert.strictEqual(error.code, 'CONFIG_INVALID');
        assert.match(error.message, pattern);
        if (column !== undefined) assert.strictEqual(error.details.column, column, error.message);
        return true;
      },
    );
  };
  expectConfigError('setup --if-missing\n', /missing path after "--if-missing"/, 19);
  expectConfigError('setup --if-missing node_modules\n', /missing command after "--if-missing node_modules"/, 32);
  expectConfigError('setup --if-missing   \n', /missing path after "--if-missing"/);
  expectConfigError('setup --if-missing ../x pnpm install\n', /paths with "\.\." are not allowed/, 20);
  expectConfigError('setup --if-missing /abs pnpm install\n', /absolute paths are not allowed/);
  expectConfigError('setup --if-missing .git pnpm install\n', /managing \.git is not allowed/);
  expectConfigError('setup --if-missing . pnpm install\n', /managing the project\/workspace root is not allowed/);
  expectConfigError('setup --if-missing "unterminated pnpm install\n', /unterminated "\.\.\." quoted path/, 20);
  expectConfigError('setup --if-missing "a b"c pnpm install\n', /unexpected text after quoted path: "c"/);
  expectConfigError('setup --if-mising node_modules pnpm install\n', /unknown setup option "--if-mising"/, 7);

  // Backslashes are separators; `./` is dropped; the path keeps its case.
  fs.writeFileSync(path.join(root, '.workler'), 'setup --if-missing .\\Deps\\cache pnpm install\n');
  assert.deepStrictEqual(api.planWorkspaceCreation(root, { name: 'feat' }).setup[0].ifMissing, 'Deps/cache');
  // A command that merely contains the option text is left alone.
  fs.writeFileSync(path.join(root, '.workler'), 'setup echo --if-missing\n');
  assert.deepStrictEqual(api.planWorkspaceCreation(root, { name: 'feat' }).setup[0], { command: 'echo --if-missing', raw: 'setup echo --if-missing' });
});

// --- project groups ------------------------------------------------------

// Like logCommand, plus the group variables, so a member's run can be told
// from the group's own.
function logGroupCommand(label) {
  const fields =
    `['${label}', process.cwd(), process.env.WORKLER_WORKSPACE, process.env.WORKLER_WORKSPACE_PATH, process.env.WORKLER_ROOT, ` +
    'process.env.WORKLER_GROUP, process.env.WORKLER_GROUP_WORKSPACE_PATH, process.env.WORKLER_PROJECT]';
  return `${NODE} -e "require('fs').appendFileSync('setup.log', ${fields}.join('|') + String.fromCharCode(10))"`;
}

function makeRepoAt(dir, workler) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'workler tests');
  fs.writeFileSync(path.join(dir, 'README.md'), `${path.basename(dir)}\n`);
  fs.writeFileSync(path.join(dir, '.workler'), workler);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const GROUP_PROJECTS = ['projects/api', 'projects/web', 'tools'];

// A project group whose members carry the given .workler contents, with
// optional group-level lines after the `project` lines.
function makeGroup(t, { rules = {}, groupLines = '', declare = true } = {}) {
  const candidate = path.join(makeTempDir(t, 'workler-group-'), 'root');
  fs.mkdirSync(candidate);
  const root = fs.realpathSync.native(candidate);
  for (const project of GROUP_PROJECTS) {
    makeRepoAt(path.join(root, ...project.split('/')), rules[project] ?? '');
  }
  if (declare) {
    fs.writeFileSync(path.join(root, '.workler'), GROUP_PROJECTS.map((project) => `project ${project}\n`).join('') + groupLines);
  }
  return root;
}

function logLabels(dir) {
  return fs.existsSync(path.join(dir, 'setup.log')) ? readLog(dir).map((fields) => fields[0]) : [];
}

test("add at a group root runs each member's setup commands in its clone, then the group's own", (t) => {
  const root = makeGroup(t, {
    rules: {
      'projects/api': `setup ${logGroupCommand('api')}\n`,
      tools: `setup ${logGroupCommand('tools-1')}\nsetup ${logGroupCommand('tools-2')}\n`,
    },
    groupLines: `setup ${logGroupCommand('group')}\n`,
  });

  const events = [];
  const result = api.createWorkspace(root, {
    name: 'feat',
    onProjectSetup: (project, count, skipped) => events.push(`project ${project} ${count}${skipped ? ` (${skipped})` : ''}`),
    onGroupSetup: (count) => events.push(`group ${count}`),
    onSetupCommand: (command, index, total) => events.push(`run ${index + 1}/${total}`),
  });
  assert.deepStrictEqual(events, [
    'project projects/api 1',
    'run 1/1',
    'project projects/web 0',
    'project tools 2',
    'run 1/2',
    'run 2/2',
    'group 1',
    'run 1/1',
  ]);
  const feat = result.path;
  assert.strictEqual(result.setup.commandCount, 1);
  assert.deepStrictEqual(
    result.projects.map((project) => project.setup.commandCount),
    [1, 0, 2],
  );

  // A member's commands run in its clone with its source as WORKLER_ROOT
  // and the group variables set; the group's own run in the workspace
  // folder with the group root as WORKLER_ROOT and no WORKLER_PROJECT.
  const apiClone = path.join(feat, 'projects', 'api');
  assert.deepStrictEqual(readLog(apiClone), [
    ['api', apiClone, 'feat', apiClone, path.join(root, 'projects', 'api'), root, feat, 'projects/api'],
  ]);
  assert.deepStrictEqual(logLabels(path.join(feat, 'tools')), ['tools-1', 'tools-2']);
  assert.deepStrictEqual(readLog(feat), [['group', feat, 'feat', feat, root, root, feat, '']]);
  assert.deepStrictEqual(logLabels(path.join(feat, 'projects', 'web')), []);
  assert.deepStrictEqual(logLabels(root), []);

  // The CLI prints a project heading per member that has commands, then the
  // group's, after the rule summary.
  const add = runCli(root, 'add', 'feat2');
  assert.strictEqual(add.status, 0, add.stderr);
  const lines = add.stdout.split('\n');
  const after = lines.slice(lines.indexOf('no workspace rules') + 1);
  assert.deepStrictEqual(
    after.map((line) => line.replace(/^setup {2}.*/, 'setup')),
    ['project projects/api', 'setup', 'project tools', 'setup', 'setup', 'group setup', 'setup', 'done   feat2', `path   ${path.join(root, '.worktrees', 'feat2')}`, ''],
  );

  // --dry-run lists the commands in that order and runs nothing.
  const dry = runCli(root, 'add', 'feat3', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  const dryLines = dry.stdout.split('\n');
  const planned = dryLines.slice(dryLines.indexOf('no workspace rules') + 1);
  assert.deepStrictEqual(
    planned.map((line) => line.replace(/^would {2}setup .*/, 'would setup')),
    ['project projects/api', 'would setup', 'project tools', 'would setup', 'would setup', 'group setup', 'would setup', ''],
  );
  assert.strictEqual(fs.existsSync(path.join(root, '.worktrees', 'feat3')), false);

  // A nested group workspace (add inside the workspace folder) runs the same
  // lines from the copied .workler and the member clones' committed files.
  const nested = api.createWorkspace(feat, { name: 'agent' });
  assert.strictEqual(nested.setup.commandCount, 1);
  assert.deepStrictEqual(readLog(nested.path)[0].slice(4), [feat, feat, nested.path, '']);
  assert.deepStrictEqual(logLabels(path.join(nested.path, 'projects', 'api')), ['api']);
});

test('a failing member command stops the whole run and names the project', (t) => {
  const root = makeGroup(t, {
    rules: { 'projects/api': `setup ${exitCommand(3)}\n`, tools: `setup ${logGroupCommand('tools')}\n` },
    groupLines: `setup ${logGroupCommand('group')}\n`,
  });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 1);
  assert.match(add.stderr, /^workler: projects\/api: setup command failed in .*api: .*process\.exit\(3\)"? \(exit code 3\)$/m);
  assert.match(add.stderr, /^the workspace was kept; fix the problem and re-run `workler setup feat`$/m);
  const feat = path.join(root, '.worktrees', 'feat');
  assert.ok(fs.existsSync(path.join(feat, 'tools', '.git')));
  assert.deepStrictEqual(logLabels(path.join(feat, 'tools')), []);
  assert.deepStrictEqual(logLabels(feat), []);

  // The retry hint repeats the address that was run: the whole workspace
  // after `add` or `setup feat`, the one member when it was addressed
  // directly, so the retry does not widen into every member's commands.
  const direct = runCli(root, 'setup', 'feat/projects/api');
  assert.strictEqual(direct.status, 1);
  assert.match(direct.stderr, /^the workspace was kept; fix the problem and re-run `workler setup feat\/projects\/api`$/m);
  const inMember = runCli(path.join(feat, 'projects', 'api'), 'setup');
  assert.strictEqual(inMember.status, 1);
  assert.match(inMember.stderr, /re-run `workler setup feat\/projects\/api`$/m);
  const whole = runCli(root, 'setup', 'feat');
  assert.strictEqual(whole.status, 1);
  assert.match(whole.stderr, /re-run `workler setup feat`$/m);
  assert.throws(
    () => api.setupWorkspace(root, 'feat/projects/api'),
    (error) => error.code === 'SETUP_COMMAND_FAILED' && /re-run `workler setup feat\/projects\/api`$/.test(error.message),
  );

  assert.throws(
    () => api.createWorkspace(root, { name: 'feat2' }),
    (error) =>
      error.code === 'SETUP_COMMAND_FAILED' &&
      error.details.project === 'projects/api' &&
      error.details.name === 'feat2' &&
      error.details.exitCode === 3 &&
      error.details.path === path.join(root, '.worktrees', 'feat2', 'projects', 'api'),
  );
});

// Sets stale group variables in this process, which the API runs and the
// CLI child processes inherit, and restores them when the test ends.
function withStaleGroupEnv(t) {
  const names = ['WORKLER_GROUP', 'WORKLER_GROUP_WORKSPACE_PATH', 'WORKLER_PROJECT'];
  const saved = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = 'stale';
  t.after(() => {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  });
}

test('setup commands never inherit group variables from the process that runs Workler', (t) => {
  withStaleGroupEnv(t);
  // A plain project: a member's command that runs `workler add` for another
  // project must not make that workspace look like a group member.
  const root = makeProject(t, { workler: `setup ${logGroupCommand('plain')}\n` });
  const ws = api.createWorkspace(root, { name: 'feat' });
  assert.deepStrictEqual(readLog(ws.path), [['plain', ws.path, 'feat', ws.path, root, '', '', '']]);

  // A group: the group's own commands see the group but no WORKLER_PROJECT,
  // and a member's see its own values, never the caller's.
  const group = makeGroup(t, {
    rules: { tools: `setup ${logGroupCommand('tools')}\n` },
    groupLines: `setup ${logGroupCommand('group')}\n`,
  });
  const feat = api.createWorkspace(group, { name: 'feat' }).path;
  assert.deepStrictEqual(readLog(feat), [['group', feat, 'feat', feat, group, group, feat, '']]);
  assert.deepStrictEqual(readLog(path.join(feat, 'tools'))[0].slice(5), [group, feat, 'tools']);
});

// Sets variables for the rest of the test (and the CLI children it spawns),
// restoring the previous values afterwards.
function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const assign = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const [name, value] of Object.entries(values)) assign(name, value);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) assign(name, value);
  });
}

test("setup commands do not inherit the caller's package-manager variables", (t) => {
  // `npm run` sets npm_config_* and INIT_CWD for the script it runs; a setup
  // command that runs an installer must see the workspace, not that script.
  // The injected variables are lowercase; a user's own uppercase installer settings pass through.
  withEnv(t, { npm_config_example: 'from-npm', INIT_CWD: '/elsewhere', WORKLER_TEST_UNRELATED: 'kept', NPM_CONFIG_REGISTRY: 'https://registry.example', PNPM_HOME: '/pnpm' });
  const names = ['npm_config_example', 'INIT_CWD', 'WORKLER_TEST_UNRELATED', 'NPM_CONFIG_REGISTRY', 'PNPM_HOME'];
  const fields = `[${names.map((name) => `process.env.${name}`).join(', ')}]`;
  const command = `${NODE} -e "require('fs').appendFileSync('setup.log', ${fields}.map(String).join('|') + String.fromCharCode(10))"`;
  const root = makeProject(t, { workler: `setup ${command}\n` });

  const ws = api.createWorkspace(root, { name: 'feat' });
  assert.deepStrictEqual(readLog(ws.path), [['undefined', 'undefined', 'kept', 'https://registry.example', '/pnpm']]);

  const add = runCli(root, 'add', 'cli');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.deepStrictEqual(readLog(path.join(root, '.worktrees', 'cli')), [['undefined', 'undefined', 'kept', 'https://registry.example', '/pnpm']]);
});

test('WORKLER_NO_SETUP in the environment skips the commands for add, never for workler setup', (t) => {
  withEnv(t, { WORKLER_NO_SETUP: '1' });
  const root = makeProject(t, { workler: `setup ${logCommand('one')}\n` });

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.match(add.stdout, /^skip {3}setup \(1 command, WORKLER_NO_SETUP\)$/m);
  assert.ok(!add.stdout.includes('setup  '));
  const feat = path.join(root, '.worktrees', 'feat');
  assert.ok(!fs.existsSync(path.join(feat, 'setup.log')));

  // The explicit command was asked for: it runs.
  const setup = runCli(root, 'setup', 'feat');
  assert.strictEqual(setup.status, 0, setup.stderr);
  assert.deepStrictEqual(readLog(feat).map((fields) => fields[0]), ['one']);

  // The flag wins the wording when both are given; the dry run agrees.
  assert.match(runCli(root, 'add', 'both', '--no-setup').stdout, /^skip {3}setup \(1 command, --no-setup\)$/m);
  assert.match(runCli(root, 'add', 'dry', '--dry-run').stdout, /^skip {3}setup \(1 command, WORKLER_NO_SETUP\)$/m);

  // "0" and the empty value mean off.
  for (const [value, name] of [['0', 'zero'], ['', 'empty']]) {
    process.env.WORKLER_NO_SETUP = value;
    const run = runCli(root, 'add', name);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes('skip   setup'), run.stdout);
    assert.deepStrictEqual(readLog(path.join(root, '.worktrees', name)).map((fields) => fields[0]), ['one']);
  }

  // The API reads no environment: it runs unless told not to.
  process.env.WORKLER_NO_SETUP = 'yes';
  const ws = api.createWorkspace(root, { name: 'api' });
  assert.strictEqual(ws.setup.commandCount, 1);
  assert.deepStrictEqual(readLog(ws.path).map((fields) => fields[0]), ['one']);

  // In a group the count covers every member's commands and the group's own.
  const group = makeGroup(t, { rules: { tools: 'setup one\n', 'projects/api': 'setup two\n' }, groupLines: 'setup three\n' });
  const groupAdd = runCli(group, 'add', 'feat');
  assert.strictEqual(groupAdd.status, 0, groupAdd.stderr);
  assert.match(groupAdd.stdout, /^skip {3}setup \(3 commands, WORKLER_NO_SETUP\)$/m);
});

test('setupStdio "pipe" hands the API each command\'s output and keeps the caller\'s streams clean', (t) => {
  const noisy = `${NODE} -e "console.log('out'); console.error('err')"`;
  const root = makeProject(t, { workler: `setup ${noisy}\nsetup ${logCommand('one')}\n` });

  const chunks = [];
  const ws = api.createWorkspace(root, {
    name: 'feat',
    setupStdio: 'pipe',
    onSetupOutput: (chunk, stream, command, index) => chunks.push([chunk.trim(), stream, command.command, index]),
  });
  assert.deepStrictEqual(chunks, [
    ['out', 'stdout', noisy, 0],
    ['err', 'stderr', noisy, 0],
  ]);
  // The output stays on the results too, '' for a stream that was silent.
  assert.deepStrictEqual(ws.setup.results.map((result) => [result.status, result.stdout.trim(), result.stderr.trim()]), [
    ['ok', 'out', 'err'],
    ['ok', '', ''],
  ]);
  // With inherited streams nothing is captured.
  fs.writeFileSync(path.join(root, '.workler'), `setup ${logCommand('one')}\n`);
  assert.strictEqual('stdout' in api.setupWorkspace(root, 'feat').setup.results[0], false);
  fs.writeFileSync(path.join(root, '.workler'), `setup ${noisy}\nsetup ${logCommand('one')}\n`);

  for (const options of [{ setupStdio: 'tty' }, { onSetupOutput: () => {} }, { onSetupOutput: 'log', setupStdio: 'pipe' }, { setupStdio: 'pipe', setupStdout: 'stderr' }]) {
    assert.throws(() => api.createWorkspace(root, { name: 'x', ...options }), (e) => e.code === 'INVALID_OPTIONS', JSON.stringify(options));
  }
  assert.throws(() => api.setupWorkspace(root, 'feat', { onSetupOutput: () => {} }), (e) => e.code === 'INVALID_OPTIONS');

  // Nothing reached the consumer's own stdout or stderr: run a consumer in a
  // child process and look at what came out of it.
  const index = path.join(path.dirname(CLI), 'index.js');
  const script = `require(${JSON.stringify(index)}).createWorkspace(${JSON.stringify(root)}, { name: 'child', setupStdio: 'pipe' }); console.log('consumer done');`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(child.stdout.trim(), 'consumer done');
  assert.strictEqual(child.stderr, '');
  assert.deepStrictEqual(readLog(path.join(root, '.worktrees', 'child')).map((fields) => fields[0]), ['one']);
});

test('a failing setup command tells API consumers which workspace was created', (t) => {
  const root = makeProject(t, { workler: `copy .env\nsetup ${NODE} -e "console.error('boom'); process.exit(3)"\n` });

  const error = caught(() => api.createWorkspace(root, { name: 'feat', setupStdio: 'pipe' }));
  assert.strictEqual(error.code, 'SETUP_COMMAND_FAILED');
  assert.strictEqual(error.details.exitCode, 3);
  const created = error.details.workspace;
  assert.strictEqual(created.name, 'feat');
  assert.strictEqual(created.path, path.join(root, '.worktrees', 'feat'));
  assert.strictEqual(created.root, root);
  assert.strictEqual(created.branch, 'feat');
  assert.strictEqual(created.detached, false);
  assert.strictEqual(created.rules.ruleCount, 1);
  assert.ok(!('setup' in created), 'the setup outcome is in details.results, not on the workspace');
  assert.ok(fs.existsSync(path.join(created.path, '.env')));
  // The failed result carries what the command wrote.
  assert.strictEqual(error.details.results[0].status, 'failed');
  assert.strictEqual(error.details.results[0].stderr.trim(), 'boom');

  // A group reports every member it cloned, again without setup outcomes.
  const group = makeGroup(t, { rules: { tools: `setup ${exitCommand(2)}\n` } });
  const groupError = caught(() => api.createWorkspace(group, { name: 'feat' }));
  assert.strictEqual(groupError.code, 'SETUP_COMMAND_FAILED');
  assert.strictEqual(groupError.details.project, 'tools');
  assert.strictEqual(groupError.details.workspace.path, path.join(group, '.worktrees', 'feat'));
  assert.deepStrictEqual(groupError.details.workspace.projects.map((member) => member.project), GROUP_PROJECTS);
  assert.ok(groupError.details.workspace.projects.every((member) => !('setup' in member)));

  // The explicit re-run created nothing, so it reports no workspace.
  assert.strictEqual(caught(() => api.setupWorkspace(group, 'feat')).details.workspace, undefined);
});

function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
}

test('setup at a group root addresses the whole workspace or one member, like apply', (t) => {
  const root = makeGroup(t, {
    rules: { 'projects/api': `setup ${logGroupCommand('api')}\n` },
    groupLines: `setup ${logGroupCommand('group')}\n`,
  });
  const feat = api.createWorkspace(root, { name: 'feat', setup: false }).path;
  const apiClone = path.join(feat, 'projects', 'api');
  const counts = () => [logLabels(apiClone).length, logLabels(feat).length];
  assert.deepStrictEqual(counts(), [0, 0]);

  const whole = runCli(root, 'setup', 'feat');
  assert.strictEqual(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /^project projects\/api$/m);
  assert.match(whole.stdout, /^group setup$/m);
  assert.match(whole.stdout, /^done {3}feat$/m);
  assert.deepStrictEqual(counts(), [1, 1]);

  const one = runCli(root, 'setup', 'feat/projects/api');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.doesNotMatch(one.stdout, /group setup/);
  assert.match(one.stdout, /^project projects\/api$/m);
  assert.match(one.stdout, /^done {3}feat\/projects\/api$/m);
  assert.deepStrictEqual(counts(), [2, 1]);

  // Bare setup inside a member runs its source repository's commands only;
  // inside the workspace folder it runs all of it.
  const inMember = runCli(apiClone, 'setup');
  assert.strictEqual(inMember.status, 0, inMember.stderr);
  assert.deepStrictEqual(counts(), [3, 1]);
  const inWorkspace = runCli(feat, 'setup');
  assert.strictEqual(inWorkspace.status, 0, inWorkspace.stderr);
  assert.deepStrictEqual(counts(), [4, 2]);

  const none = runCli(root, 'setup', 'feat/tools');
  assert.strictEqual(none.status, 0, none.stderr);
  assert.strictEqual(none.stdout, 'no setup commands\n');
  assert.strictEqual(runCli(root, 'setup', 'feat/nope').status, 1);
  assert.match(runCli(root, 'setup', 'feat/nope').stderr, /project not found/);
  assert.strictEqual(runCli(root, 'setup', 'main/projects/api').status, 1);
  assert.strictEqual(runCli(root, 'setup').status, 1);

  const result = api.setupWorkspace(root, 'feat');
  assert.strictEqual(result.path, feat);
  assert.strictEqual(result.root, root);
  assert.strictEqual(result.project, undefined);
  assert.strictEqual(result.setup.commandCount, 1);
  assert.deepStrictEqual(result.projects.map((member) => [member.project, member.setup.commandCount, member.skipped]), [
    ['projects/api', 1, undefined],
    ['projects/web', 0, undefined],
    ['tools', 0, undefined],
  ]);
  const memberEvents = [];
  const memberResult = api.setupWorkspace(root, 'feat/projects/api', {
    onProjectSetup: (project, count, skipped) => memberEvents.push(['project', project, count, skipped]),
    onGroupSetup: (count) => memberEvents.push(['group', count]),
  });
  assert.strictEqual(memberResult.project, 'projects/api');
  assert.strictEqual(memberResult.path, apiClone);
  assert.strictEqual(memberResult.root, path.join(root, 'projects', 'api'));
  assert.strictEqual(memberResult.setup.commandCount, 1);
  assert.strictEqual(memberResult.projects, undefined);
  assert.deepStrictEqual(memberEvents, [['project', 'projects/api', 1, undefined]]);
  assert.throws(() => api.setupWorkspace(root, 'feat/nope'), (error) => error.code === 'WORKSPACE_NOT_FOUND');

  // A member that was never cloned is skipped, not created.
  fs.rmSync(path.join(feat, 'tools'), { recursive: true });
  const partial = runCli(root, 'setup', 'feat');
  assert.strictEqual(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /^project tools: skipped \(not cloned\)$/m);
  assert.strictEqual(fs.existsSync(path.join(feat, 'tools')), false);
  const missing = runCli(root, 'setup', 'feat/tools');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /project tools in workspace feat is not cloned/);
  const partialApi = api.setupWorkspace(root, 'feat');
  assert.strictEqual(partialApi.projects[2].skipped, 'not cloned');
  assert.strictEqual(partialApi.projects[2].setup, undefined);
  assert.throws(() => api.setupWorkspace(root, 'feat/tools'), (error) => error.code === 'WORKSPACE_NOT_FOUND');

  // A source that is gone is refused rather than read from whatever is there.
  fs.rmSync(path.join(root, 'projects', 'api'), { recursive: true });
  const gone = runCli(root, 'setup', 'feat');
  assert.strictEqual(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /^project projects\/api: skipped \(source main\/projects\/api is missing\)$/m);
  assert.strictEqual(runCli(apiClone, 'setup').status, 1);
  assert.match(runCli(apiClone, 'setup').stderr, /source main\/projects\/api is missing/);
  assert.throws(() => api.setupWorkspace(root, 'feat/projects/api'), (error) => error.code === 'NOT_A_GIT_REPO');
});

test('the group starter template mentions setup lines and declares none', (t) => {
  const root = makeGroup(t, { declare: false });
  api.initProject(root);
  assert.match(fs.readFileSync(path.join(root, '.workler'), 'utf8'), /^#   setup <command> {2}# run in the workspace folder/m);
  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.deepStrictEqual(plan.setup, []);
  assert.deepStrictEqual(plan.projects.map((member) => member.setup), [[], [], []]);
});
