'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const CLI = path.join(DIST, 'cli.js');
const api = require(path.join(DIST, 'index.js'));

function makeTempDir(t, prefix = 'workler-test-') {
  // No realpath here: on Windows it can turn C:\\Users\\runneradmin into the 8.3 alias
  // RUNNER~1 while child processes report the long form, so path comparisons with Git disagree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A repo on branch `main` with `workler` committed as .workler (no file with
// includeWorkler: false). Untracked .env and node_modules/ exist only if `workler` names them.
function makeRepo(t, { workler = '', includeWorkler = true } = {}) {
  const candidate = path.join(makeTempDir(t), 'proj');
  fs.mkdirSync(candidate);
  // Expands Windows 8.3 aliases and macOS's /var -> /private/var, so Git, process.cwd()
  // and API results use one spelling. It needs the path to exist.
  const root = fs.realpathSync.native(candidate);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'workler tests');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  if (includeWorkler) {
    fs.writeFileSync(path.join(root, '.workler'), workler);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');

  if (workler.includes('.env')) {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  }
  if (workler.includes('node_modules')) {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'marker.txt'), 'marker\n');
  }
  return root;
}

function makeProject(t, opts) {
  const root = makeRepo(t, opts);
  api.initProject(root);
  return root;
}

// A bare repo as `origin`, with the current branch pushed and tracking it; returns its path.
function addOrigin(t, root) {
  const remote = path.join(makeTempDir(t, 'workler-remote-'), 'origin.git');
  git(path.dirname(remote), 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return remote;
}

function remotes(repo) {
  const output = git(repo, 'remote', '-v');
  const result = {};
  for (const line of output.split('\n').filter(Boolean)) {
    const [name, url] = line.split(/\s+/);
    result[name] = url;
  }
  return result;
}

function runCli(cwd, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Strips the `<dev>:<ino>:<birth> ` identity Workler keeps in front of each recorded path.
function recordedPaths(values) {
  return values.map((value) => value.replace(/^\d+:\d+:\d+ /, ''));
}

function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return result.pid;
}

module.exports = { addOrigin, api, CLI, git, makeTempDir, makeRepo, makeProject, recordedPaths, remotes, runCli, deadPid };
