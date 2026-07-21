'use strict';
// Shared fixtures for the node:test suite. Tests exercise the compiled
// output (dist/), which is what package consumers get; `npm test` builds
// first.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const CLI = path.join(DIST, 'cli.js');
const api = require(path.join(DIST, 'index.js'));

function makeTempDir(t, prefix = 'workler-test-') {
  // Keep the OS-provided spelling on Windows. realpathSync can turn
  // C:\\Users\\runneradmin into its 8.3 alias C:\\Users\\RUNNER~1; child
  // processes then report the long form again, making path.relative and Git's
  // working-tree checks disagree about otherwise identical paths.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A git repo on branch `main` with one commit. `workler` is the committed
// .workler content (pass '' for an empty file); set includeWorkler to false
// to model a repository that has never had the optional file. Untracked extras
// (.env, node_modules/) are only created when the rules reference them.
function makeRepo(t, { workler = '', includeWorkler = true } = {}) {
  const candidate = path.join(makeTempDir(t), 'proj');
  fs.mkdirSync(candidate);
  // Canonicalize only after the path exists: this expands Windows 8.3 aliases
  // and macOS's /var -> /private/var alias, keeping Git, process.cwd(), and
  // API return values on one spelling.
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

// Gives `root` a real upstream: a bare repo added as `origin`, with the
// current branch pushed and tracking it. Returns the bare repo's path.
function addOrigin(t, root) {
  const remote = path.join(makeTempDir(t, 'workler-remote-'), 'origin.git');
  git(path.dirname(remote), 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return remote;
}

// The remotes configured in a repo, as { name: url }.
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

// A pid that is guaranteed dead: spawn a no-op node process and wait for it.
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return result.pid;
}

module.exports = { addOrigin, api, CLI, git, makeTempDir, makeRepo, makeProject, remotes, runCli, deadPid };
