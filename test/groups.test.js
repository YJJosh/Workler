'use strict';
// Project groups: a plain folder whose .workler lists repositories with `project <path>`
// lines. `add` clones each into .worktrees/<name>/<path> as a workspace of its source.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { addOrigin, api, git, makeRepo, makeTempDir, recordedPaths, remotes, runCli } = require('./helpers');

// Like makeRepo from helpers, but at a given path.
function makeRepoAt(dir, { workler = '', includeWorkler = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'workler tests');
  fs.writeFileSync(path.join(dir, 'README.md'), `${path.basename(dir)}\n`);
  if (includeWorkler) {
    fs.writeFileSync(path.join(dir, '.workler'), workler);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  if (workler.includes('.env')) {
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  }
  if (workler.includes('node_modules')) {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'marker.txt'), 'marker\n');
  }
  return dir;
}

const DEFAULT_PROJECTS = ['projects/api', 'projects/web', 'tools'];

// `rules` maps a project path to its own .workler; `declare: false` writes no group .workler.
function makeGroup(t, { projects = DEFAULT_PROJECTS, rules = {}, groupRules = '', declare = true } = {}) {
  const candidate = path.join(makeTempDir(t, 'workler-group-'), 'root');
  fs.mkdirSync(candidate);
  const root = fs.realpathSync.native(candidate);
  for (const project of projects) {
    makeRepoAt(member(root, project), { workler: rules[project] ?? '' });
  }
  if (declare) {
    fs.writeFileSync(path.join(root, '.workler'), projects.map((project) => `project ${project}\n`).join('') + groupRules);
  }
  if (groupRules.includes('.env.shared')) {
    fs.writeFileSync(path.join(root, '.env.shared'), 'SHARED=1\n');
  }
  return root;
}

function member(base, project) {
  return path.join(base, ...project.split('/'));
}

function workspaceDir(root, name) {
  return path.join(root, '.worktrees', name);
}

function branchOf(repo) {
  return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
}

function refs(repo, prefix) {
  const output = git(repo, 'for-each-ref', '--format=%(refname)', prefix);
  return output ? output.split('\n') : [];
}

// --- configuration -------------------------------------------------------

test('a folder whose .workler declares projects is a project group', (t) => {
  const root = makeGroup(t);
  const info = api.inspectProject(root);
  assert.strictEqual(info.isGroup, true);
  assert.deepStrictEqual(info.projects, DEFAULT_PROJECTS);
  assert.strictEqual(info.gitRepo, false);
  assert.strictEqual(info.marked, false);
  assert.strictEqual(info.initialized, true);
  assert.strictEqual(info.parent, undefined);
  assert.strictEqual(info.memberOf, undefined);

  const source = api.inspectProject(member(root, 'projects/api'));
  assert.strictEqual(source.isGroup, false);
  assert.deepStrictEqual(source.projects, []);
  assert.strictEqual(source.gitRepo, true);
});

test('project lines are validated like rule paths and may not overlap anything', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'] });
  const config = path.join(root, '.workler');
  const expectInvalid = (text, fragment) => {
    fs.writeFileSync(config, text);
    const info = api.inspectProject(root);
    assert.strictEqual(info.isGroup, false, text);
    assert.match(info.configError, fragment, text);
    assert.throws(() => api.createWorkspace(root, { name: 'feat' }), (error) => error.code === 'CONFIG_INVALID' && fragment.test(error.message), text);
    assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false);
  };

  expectInvalid('project projects/api\nlink projects/api/node_modules\n', /rule path overlaps an earlier project/);
  expectInvalid('copy projects\nproject projects/api\n', /project path overlaps an earlier rule/);
  expectInvalid('project projects\nproject projects/api\n', /project path overlaps an earlier project/);
  expectInvalid('project projects/api\nproject projects/api\n', /project path overlaps an earlier project/);
  expectInvalid('project ../elsewhere\n', /paths with "\.\." are not allowed/);
  expectInvalid('project /abs/path\n', /absolute paths are not allowed/);
  expectInvalid('project .worktrees/x\n', /managing \.worktrees is not allowed/);
  expectInvalid('project .git\n', /managing \.git is not allowed/);
  expectInvalid('project\n', /missing path after "project"/);
  expectInvalid('prject projects/api\n', /unknown action "prject"/);

  fs.writeFileSync(config, '# group\nproject "projects/api"  # the api\n');
  assert.deepStrictEqual(api.inspectProject(root).projects, ['projects/api']);
});

test('a Git repository cannot declare projects', (t) => {
  const repo = makeRepo(t, { workler: 'project sub\n' });
  makeRepoAt(path.join(repo, 'sub'));

  assert.strictEqual(api.inspectProject(repo).isGroup, false);
  assert.deepStrictEqual(api.inspectProject(repo).projects, []);
  for (const operation of [() => api.createWorkspace(repo, { name: 'feat' }), () => api.planWorkspaceCreation(repo, { name: 'feat' })]) {
    assert.throws(operation, (error) => error.code === 'CONFIG_INVALID' && /cannot declare "project" entries/.test(error.message));
  }
  assert.strictEqual(fs.existsSync(workspaceDir(repo, 'feat')), false);
});

test('a member repository cannot declare projects either: the group refuses before cloning', (t) => {
  const root = makeGroup(t, { projects: ['projects/api', 'tools'], rules: { tools: 'project sub\n' } });
  makeRepoAt(member(root, 'tools/sub'));

  for (const operation of [() => api.createWorkspace(root, { name: 'feat' }), () => api.planWorkspaceCreation(root, { name: 'feat' })]) {
    assert.throws(
      operation,
      (error) => error.code === 'CONFIG_INVALID' && error.details.project === 'tools' && /^tools: .*cannot declare "project" entries/.test(error.message),
    );
  }
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false);
});

test('a non-Git folder without project lines is still not something add can clone', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'], declare: false });
  fs.writeFileSync(path.join(root, '.workler'), 'copy .env\n');
  assert.strictEqual(api.inspectProject(root).isGroup, false);
  assert.throws(() => api.createWorkspace(root, { name: 'feat' }), (error) => error.code === 'NOT_A_GIT_REPO' && /project group/.test(error.message));
});

// --- discovery -----------------------------------------------------------

test('discovery: the group root, a folder between projects, and a project itself', (t) => {
  const root = makeGroup(t);
  assert.strictEqual(api.findWorklerRoot(root), root);
  assert.strictEqual(api.findWorklerRoot(path.join(root, 'projects')), root);
  assert.strictEqual(api.findWorklerRoot(path.join(root, '.worktrees')), root);

  const inside = path.join(member(root, 'projects/api'), 'src');
  fs.mkdirSync(inside);
  assert.strictEqual(api.findWorklerRoot(inside), member(root, 'projects/api'));
  assert.strictEqual(api.findWorklerRoot(member(root, 'tools')), member(root, 'tools'));
});

test('add on a hand-written group ignores .worktrees/ in .gitignore, as init does', (t) => {
  const outer = makeRepo(t, { includeWorkler: false });
  const group = path.join(outer, 'services');
  makeRepoAt(path.join(group, 'a'));
  fs.writeFileSync(path.join(group, '.workler'), 'project a\ncopy .env.shared\n');
  fs.writeFileSync(path.join(group, '.env.shared'), 'SHARED=1\n');
  assert.strictEqual(fs.existsSync(path.join(group, '.gitignore')), false);

  const feat = api.createWorkspace(group, { name: 'feat' });
  assert.strictEqual(fs.readFileSync(path.join(group, '.gitignore'), 'utf8'), '.worktrees/\n');
  assert.match(git(outer, 'check-ignore', '-v', 'services/.worktrees/feat/.env.shared'), /services\/\.gitignore:1:\.worktrees\//);

  // A nested group workspace already lives under the group's ignored .worktrees/.
  api.createWorkspace(group, { name: 'feat2' });
  assert.strictEqual(fs.readFileSync(path.join(group, '.gitignore'), 'utf8'), '.worktrees/\n');
  api.createWorkspace(feat.path, { name: 'inner' });
  assert.strictEqual(fs.existsSync(path.join(feat.path, '.gitignore')), false);
});

test('a hand-written group in a tracked folder named .worktrees still gets its own ignore line', (t) => {
  // Here .worktrees/tools is tracked content of a plain outer repository, not a
  // Workler workspace, so only the group's own .gitignore keeps its clones out of Git.
  const outer = makeRepo(t, { includeWorkler: false });
  fs.rmSync(path.join(outer, '.gitignore'), { force: true });
  fs.rmSync(path.join(outer, '.git', 'info', 'exclude'), { force: true });
  const group = path.join(outer, '.worktrees', 'tools');
  makeRepoAt(path.join(group, 'projects', 'api'));
  fs.writeFileSync(path.join(group, '.workler'), 'project projects/api\ncopy .env.shared\n');
  fs.writeFileSync(path.join(group, '.env.shared'), 'SHARED=1\n');
  git(outer, 'add', '-f', '.worktrees/tools/.workler', '.worktrees/tools/.env.shared');
  assert.strictEqual(fs.existsSync(path.join(group, '.gitignore')), false);

  const feat = api.createWorkspace(group, { name: 'feat' });
  assert.strictEqual(fs.readFileSync(path.join(group, '.gitignore'), 'utf8'), '.worktrees/\n');
  assert.match(
    git(outer, 'check-ignore', '-v', '.worktrees/tools/.worktrees/feat/.env.shared'),
    /\.worktrees\/tools\/\.gitignore:1:\.worktrees\//,
  );
  const leaked = git(outer, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter((line) => line.includes('tools/.worktrees/'));
  assert.deepStrictEqual(leaked, []);

  api.createWorkspace(feat.path, { name: 'inner' });
  assert.strictEqual(fs.existsSync(path.join(feat.path, '.gitignore')), false);
});

test('a group-level rule for .workler is a configuration error: add writes that file into every group workspace', (t) => {
  for (const line of ['link .workler', 'copy .workler', 'copy ./.WORKLER']) {
    const root = makeGroup(t, { projects: ['a'], groupRules: `${line}\n` });
    assert.match(api.inspectProject(root).configError ?? '', /\.workler:2:\d+: a project group cannot manage \.workler/, line);
    for (const operation of [() => api.createWorkspace(root, { name: 'feat' }), () => api.planWorkspaceCreation(root, { name: 'feat' })]) {
      assert.throws(operation, (error) => error.code === 'CONFIG_INVALID' && /cannot manage \.workler/.test(error.message), line);
    }
    assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false, line);
    const { status, stderr } = runCli(root, 'add', 'feat');
    assert.strictEqual(status, 1, line);
    assert.match(stderr, /cannot manage \.workler/, line);
  }
  // A plain repository's .workler is never pre-written into its workspaces.
  const repo = makeRepo(t, { workler: 'link .workler\n' });
  assert.doesNotThrow(() => api.planWorkspaceCreation(repo, { name: 'feat' }));
});

test('a group inside an unrelated outer repository is the nearer project', (t) => {
  const outer = makeRepo(t, { includeWorkler: false });
  const group = path.join(outer, 'services');
  makeRepoAt(path.join(group, 'a'));
  makeRepoAt(path.join(group, 'b'));
  fs.writeFileSync(path.join(group, '.workler'), 'project a\nproject b\n');

  assert.strictEqual(api.findWorklerRoot(group), group);
  const between = path.join(group, 'docs');
  fs.mkdirSync(between);
  assert.strictEqual(api.findWorklerRoot(between), group);
  assert.strictEqual(api.findWorklerRoot(path.join(group, 'a')), path.join(group, 'a'));
  assert.strictEqual(api.findWorklerRoot(outer), outer);

  const result = api.createWorkspace(group, { name: 'feat' });
  assert.strictEqual(result.path, workspaceDir(group, 'feat'));
  assert.strictEqual(branchOf(path.join(result.path, 'a')), 'feat');
  assert.strictEqual(api.findWorklerRoot(result.path), result.path);
});

// --- init ----------------------------------------------------------------

test('init on a plain folder discovers the repositories below it and declares them', (t) => {
  const root = makeGroup(t, { declare: false });
  // Not discovered: too deep, under node_modules, under .worktrees, or a
  // linked `git worktree` (a .git file, not an independent clone).
  makeRepoAt(path.join(root, 'a', 'b', 'c'));
  makeRepoAt(path.join(root, 'node_modules', 'dep'));
  makeRepoAt(path.join(root, '.worktrees', 'old'));
  git(member(root, 'tools'), 'worktree', 'add', '-q', '-b', 'linked', path.join(root, 'linked'));

  assert.deepStrictEqual(api.discoverProjects(root), DEFAULT_PROJECTS);

  const result = api.initProject(root);
  assert.strictEqual(result.configCreated, true);
  assert.strictEqual(result.gitRepo, false);
  assert.deepStrictEqual(result.projects, DEFAULT_PROJECTS);
  assert.deepStrictEqual(result.discoveredProjects, DEFAULT_PROJECTS);
  const config = fs.readFileSync(result.configPath, 'utf8');
  for (const project of DEFAULT_PROJECTS) {
    assert.ok(config.includes(`\nproject ${project}\n`), config);
  }
  assert.ok(fs.readFileSync(result.gitignorePath, 'utf8').includes('.worktrees/'));
  assert.deepStrictEqual(api.inspectProject(root).projects, DEFAULT_PROJECTS);

  const again = api.initProject(root);
  assert.strictEqual(again.configCreated, false);
  assert.deepStrictEqual(again.projects, DEFAULT_PROJECTS);

  for (const project of DEFAULT_PROJECTS) {
    assert.strictEqual(api.inspectProject(member(root, project)).marked, false);
  }
});

test('the init command prepares a group folder and hints at undeclared repositories', (t) => {
  const root = makeGroup(t, { declare: false });
  const created = runCli(root, 'init');
  assert.strictEqual(created.status, 0, created.stderr);
  assert.match(created.stdout, /^created .workler$/m);
  assert.match(created.stdout, /^project projects\/api$/m);
  assert.match(created.stdout, /^project tools$/m);
  assert.match(created.stdout, /^ready {3}.worktrees$/m);
  assert.match(created.stdout, /^ignored .worktrees\/ in .gitignore$/m);
  assert.doesNotMatch(created.stdout, /warning/);

  // Hinted lines are quoted to paste as-is: bare, `has # hash` would declare `has`
  // and start a comment.
  makeRepoAt(path.join(root, 'later'));
  makeRepoAt(path.join(root, 'has # hash'));
  const again = runCli(root, 'init');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /^exists {2}.workler$/m);
  assert.match(again.stdout, /^hint: .*not declared/m);
  assert.match(again.stdout, /^ {2}project "has # hash"$/m);
  assert.match(again.stdout, /^ {2}project later$/m);
  assert.deepStrictEqual(api.inspectProject(root).projects, DEFAULT_PROJECTS);
  const hinted = again.stdout.split('\n').filter((line) => line.startsWith('  project ')).map((line) => line.trim());
  fs.appendFileSync(path.join(root, '.workler'), `${hinted.join('\n')}\n`);
  assert.deepStrictEqual(api.inspectProject(root).projects, [...DEFAULT_PROJECTS, 'has # hash', 'later']);
});

test('the init command inside an outer repository initializes the group folder, not the repository', (t) => {
  const outer = makeRepo(t, { includeWorkler: false });
  const group = path.join(outer, 'services');
  makeRepoAt(path.join(group, 'a'));
  makeRepoAt(path.join(group, 'b'));

  const result = runCli(group, 'init');
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^created .workler$/m);
  assert.match(result.stdout, /^project a$/m);
  assert.deepStrictEqual(api.inspectProject(group).projects, ['a', 'b']);
  assert.strictEqual(fs.existsSync(path.join(outer, '.workler')), false);
  assert.strictEqual(api.inspectProject(outer).marked, false);

  const plain = path.join(outer, 'src');
  fs.mkdirSync(plain);
  const repoInit = runCli(plain, 'init');
  assert.strictEqual(repoInit.status, 0, repoInit.stderr);
  assert.strictEqual(api.inspectProject(outer).marked, true);
  assert.strictEqual(fs.existsSync(path.join(plain, '.workler')), false);
});

test('init skips a repository whose name cannot be written to .workler, and says so', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows forbids " in a file name');
    return;
  }
  const root = makeGroup(t, { projects: ['projects/api'], declare: false });
  const odd = `it's "odd"`;
  const slashed = 'back\\slash';
  makeRepoAt(path.join(root, odd));
  makeRepoAt(path.join(root, slashed));
  makeRepoAt(path.join(root, 'has space'));

  // Quoting covers a space or one kind of quote; both kinds cannot be spelled.
  // Neither can a backslash: the parser would read `back\slash` as `back/slash`.
  const result = api.initProject(root);
  assert.deepStrictEqual(result.projects, ['has space', 'projects/api']);
  assert.deepStrictEqual(result.discoveredProjects, ['has space', 'projects/api']);
  assert.deepStrictEqual(result.unwritableProjects, [slashed, odd]);
  assert.ok(fs.readFileSync(result.configPath, 'utf8').includes('\nproject "has space"\n'));
  const info = api.inspectProject(root);
  assert.strictEqual(info.configError, undefined);
  assert.deepStrictEqual(info.projects, ['has space', 'projects/api']);

  fs.rmSync(result.configPath);
  const cli = runCli(root, 'init');
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^project "has space"$/m);
  assert.match(cli.stdout, /^skipped it's "odd": cannot be written to .workler/m);
  assert.match(cli.stdout, /^skipped back\\slash: cannot be written to .workler/m);
  assert.doesNotMatch(cli.stdout, /^project it's/m);
  assert.doesNotMatch(cli.stdout, /^project back/m);
});

test('init declares only one of two repositories whose paths .workler could not tell apart', (t) => {
  // The .workler parser compares paths case-insensitively and rejects a parent declared
  // with its child, so `API` and `api` (or `Projects` and `projects/api`) cannot both be written.
  const probe = makeTempDir(t, 'workler-case-');
  fs.mkdirSync(path.join(probe, 'A'));
  if (fs.existsSync(path.join(probe, 'a'))) {
    t.skip('needs a case-sensitive file system');
    return;
  }
  const root = makeGroup(t, { projects: ['api'], declare: false });
  makeRepoAt(path.join(root, 'API'));
  makeRepoAt(path.join(root, 'Projects'));
  makeRepoAt(path.join(root, 'projects', 'api'));

  // Discovery is sorted, so `API` and `Projects` are found first and win.
  const result = api.initProject(root);
  assert.deepStrictEqual(result.discoveredProjects, ['API', 'Projects']);
  assert.deepStrictEqual(result.overlappingProjects, [
    { path: 'api', overlaps: 'API' },
    { path: 'projects/api', overlaps: 'Projects' },
  ]);
  assert.deepStrictEqual(result.projects, ['API', 'Projects']);
  const info = api.inspectProject(root);
  assert.strictEqual(info.configError, undefined);
  assert.deepStrictEqual(info.projects, ['API', 'Projects']);

  fs.rmSync(result.configPath);
  const cli = runCli(root, 'init');
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^project API$/m);
  assert.match(cli.stdout, /^project Projects$/m);
  assert.match(cli.stdout, /^skipped api: overlaps API \(/m);
  assert.match(cli.stdout, /^skipped projects\/api: overlaps Projects \(/m);
  assert.doesNotMatch(cli.stdout, /^project api$/m);
  assert.doesNotMatch(cli.stdout, /^project projects\/api$/m);
  assert.strictEqual(api.inspectProject(root).configError, undefined);

  fs.writeFileSync(path.join(root, '.workler'), 'project api\n');
  const again = runCli(root, 'init');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /^skipped API: overlaps api \(/m);
  assert.match(again.stdout, /^  project Projects$/m);
  assert.doesNotMatch(again.stdout, /^  project API$/m);
  assert.deepStrictEqual(api.initProject(root).overlappingProjects, [
    { path: 'API', overlaps: 'api' },
    { path: 'projects/api', overlaps: 'Projects' },
  ]);
});

test('init does not suggest a project line that overlaps a rule already in .workler', (t) => {
  // `copy shared` would reach into a project at `shared/lib`.
  const root = makeGroup(t, { projects: ['projects/api'], declare: false });
  makeRepoAt(path.join(root, 'shared', 'lib'));
  fs.writeFileSync(path.join(root, '.workler'), 'project projects/api\ncopy shared\n');

  const result = api.initProject(root);
  assert.deepStrictEqual(result.projects, ['projects/api']);
  assert.deepStrictEqual(result.discoveredProjects, ['projects/api']);
  assert.deepStrictEqual(result.overlappingProjects, [{ path: 'shared/lib', overlaps: 'shared' }]);

  const cli = runCli(root, 'init');
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^skipped shared\/lib: overlaps shared \(/m);
  assert.doesNotMatch(cli.stdout, /project shared/);
  assert.doesNotMatch(cli.stdout, /^hint:/m);
});

// --- add -----------------------------------------------------------------

test('init leaves a malformed .workler alone, says so, and still prepares the folder', (t) => {
  // A plain folder with no repository above it.
  const root = makeTempDir(t);
  makeRepoAt(path.join(root, 'projects', 'api'));
  const configPath = path.join(root, '.workler');
  const broken = 'frobnicate projects/api\n';
  fs.writeFileSync(configPath, broken);

  const result = api.initProject(root);
  assert.equal(result.configCreated, false);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.discoveredProjects, ['projects/api']);
  assert.match(result.configError, /unknown action/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), broken);
  assert.ok(fs.existsSync(path.join(root, '.worktrees')));
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.worktrees\/$/m);

  const run = runCli(root, 'init');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^exists  \.workler$/m);
  assert.match(run.stdout, /^warning: \.workler does not parse and was left as is: .*unknown action/m);
  assert.match(run.stdout, /^  project projects\/api$/m);
  assert.match(run.stdout, /^ready   \.worktrees$/m);
  assert.equal(fs.readFileSync(configPath, 'utf8'), broken);

  // Inside an outer repository the repositories below still make the folder the project.
  const outer = makeRepo(t, { includeWorkler: false });
  const outerWorktreesBefore = fs.existsSync(path.join(outer, '.worktrees'));
  const outerExclude = path.join(outer, '.git', 'info', 'exclude');
  const outerExcludeBefore = fs.existsSync(outerExclude) ? fs.readFileSync(outerExclude, 'utf8') : undefined;
  const services = path.join(outer, 'services');
  fs.mkdirSync(services);
  makeRepoAt(path.join(services, 'api'));
  fs.writeFileSync(path.join(services, '.workler'), broken);

  const nested = runCli(services, 'init');
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /^exists  \.workler$/m);
  assert.match(nested.stdout, /^warning: \.workler does not parse/m);
  assert.match(nested.stdout, /^  project api$/m);
  assert.ok(fs.existsSync(path.join(services, '.worktrees')));
  assert.equal(fs.readFileSync(path.join(services, '.workler'), 'utf8'), broken);
  assert.equal(fs.existsSync(path.join(outer, '.worktrees')), outerWorktreesBefore);
  assert.equal(fs.existsSync(outerExclude) ? fs.readFileSync(outerExclude, 'utf8') : undefined, outerExcludeBefore);
});

test('add at a group root clones every project into one workspace, in the same layout', (t) => {
  const root = makeGroup(t, {
    rules: { 'projects/api': 'link node_modules\n', 'projects/web': 'copy .env\n' },
    groupRules: 'copy .env.shared\n',
  });
  const progress = [];
  const result = api.createWorkspace(root, { name: 'feat', onProgress: (line) => progress.push(line) });

  const feat = workspaceDir(root, 'feat');
  assert.strictEqual(result.path, feat);
  assert.strictEqual(result.root, root);
  assert.strictEqual(result.branch, 'feat');
  assert.strictEqual(result.detached, false);
  assert.strictEqual(result.head, undefined);
  assert.deepStrictEqual(result.projects.map((project) => project.project), DEFAULT_PROJECTS);
  assert.ok(progress.includes('project projects/api'));
  assert.ok(progress.includes('group rules'));

  assert.strictEqual(fs.readFileSync(path.join(feat, '.workler'), 'utf8'), fs.readFileSync(path.join(root, '.workler'), 'utf8'));
  assert.strictEqual(fs.readFileSync(path.join(feat, '.env.shared'), 'utf8'), 'SHARED=1\n');
  assert.strictEqual(result.rules.ruleCount, 1);

  for (const entry of result.projects) {
    const source = member(root, entry.project);
    const clone = member(feat, entry.project);
    assert.strictEqual(entry.root, source);
    assert.strictEqual(entry.path, clone);
    assert.strictEqual(entry.branch, 'feat');
    assert.strictEqual(entry.detached, false);
    assert.strictEqual(entry.head, git(source, 'rev-parse', 'HEAD'));
    assert.strictEqual(branchOf(clone), 'feat');
    assert.strictEqual(git(clone, 'config', '--get', 'workler.root'), source);
    assert.strictEqual(git(clone, 'config', '--get', 'workler.name'), 'feat');
    assert.strictEqual(git(clone, 'config', '--get', 'workler.group'), root);
    assert.strictEqual(git(clone, 'config', '--get', 'workler.groupProject'), entry.project);
    assert.strictEqual(remotes(clone)['workler-root'], source);
    assert.strictEqual(fs.existsSync(path.join(clone, '.worktrees')), false);
  }

  const link = path.join(feat, 'projects', 'api', 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(root, 'projects', 'api', 'node_modules')));
  assert.strictEqual(fs.readFileSync(path.join(feat, 'projects', 'web', '.env'), 'utf8'), 'SECRET=1\n');
  assert.strictEqual(result.projects[0].rules.ruleCount, 1);
  assert.strictEqual(result.projects[2].rules.ruleCount, 0);
});

test('branch options apply to every member', (t) => {
  const root = makeGroup(t);
  const api1 = member(root, 'projects/api');
  git(api1, 'branch', 'topic');

  // --branch: reused where it exists, created from HEAD elsewhere.
  const topic = api.createWorkspace(root, { name: 'topic-ws', branch: 'topic' });
  assert.strictEqual(topic.branch, 'topic');
  for (const project of DEFAULT_PROJECTS) {
    assert.strictEqual(branchOf(member(topic.path, project)), 'topic');
  }

  const based = api.createWorkspace(root, { name: 'based', base: 'main', branch: 'feature/x' });
  assert.strictEqual(based.branch, 'feature/x');

  for (const project of DEFAULT_PROJECTS) {
    git(member(root, project), 'tag', 'v1');
  }
  const tagged = api.createWorkspace(root, { name: 'tagged', checkout: 'v1' });
  assert.strictEqual(tagged.detached, true);
  assert.strictEqual(tagged.branch, undefined);
  assert.ok(tagged.projects.every((project) => project.detached && project.branch === undefined));
  const listed = runCli(root, 'list');
  assert.match(listed.stdout, /^tagged\s+detached\s+/m);
});

test('add is all-or-nothing: a bad ref or an existing branch in any member clones nothing', (t) => {
  const root = makeGroup(t);
  git(member(root, 'projects/web'), 'branch', 'feat');

  assert.throws(
    () => api.createWorkspace(root, { name: 'feat' }),
    (error) => error.code === 'BRANCH_EXISTS' && error.message.startsWith('projects/web: ') && error.details.project === 'projects/web',
  );
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false);

  assert.throws(
    () => api.createWorkspace(root, { name: 'other', base: 'no-such-ref' }),
    (error) => error.code === 'BAD_REF' && error.message.startsWith('projects/api: '),
  );
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'other')), false);

  assert.throws(() => api.planWorkspaceCreation(root, { name: 'feat' }), (error) => error.code === 'BRANCH_EXISTS');
  const cli = runCli(root, 'add', 'feat');
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /projects\/web: /);
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false);
});

test('a declared project that is not a repository fails before anything is cloned', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'] });
  fs.mkdirSync(path.join(root, 'tools'));
  fs.appendFileSync(path.join(root, '.workler'), 'project tools\n');

  assert.throws(
    () => api.createWorkspace(root, { name: 'feat' }),
    (error) => error.code === 'NOT_A_GIT_REPO' && error.details.project === 'tools' && /project tools/.test(error.message),
  );
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false);

  const [main] = api.listWorkspaces(root);
  assert.strictEqual(main.projects.find((project) => project.project === 'tools').broken, 'not a Git repository top level');
  assert.match(main.broken, /tools: not a Git repository top level/);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^main\/tools\s+-\s+-\s+broken: not a Git repository top level\s+-$/m);

  fs.rmSync(path.join(root, 'projects', 'api'), { recursive: true });
  assert.match(runCli(root, 'status').stdout, /^main\/projects\/api\s+-\s+-\s+broken: missing\s+-$/m);
});

test('the plan lists one checkout per member and add --dry-run creates nothing', (t) => {
  const root = makeGroup(t);
  fs.writeFileSync(path.join(root, 'projects', 'api', 'scratch.txt'), 'wip\n');

  const plan = api.planWorkspaceCreation(root, { name: 'feat' });
  assert.strictEqual(plan.checkout, undefined);
  assert.strictEqual(plan.target, workspaceDir(root, 'feat'));
  assert.deepStrictEqual(plan.projects.map((entry) => entry.project), DEFAULT_PROJECTS);
  assert.deepStrictEqual(plan.projects.map((entry) => entry.checkout.kind), ['create-branch', 'create-branch', 'create-branch']);
  assert.strictEqual(plan.projects[0].root, member(root, 'projects/api'));
  assert.strictEqual(plan.projects[0].target, member(plan.target, 'projects/api'));
  assert.deepStrictEqual(plan.warnings, ['projects/api has uncommitted changes; its clone will only contain committed tracked files']);

  const dry = runCli(root, 'add', 'feat', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^dry run: nothing will be created$/m);
  assert.match(dry.stdout, /^warning: projects\/api has uncommitted changes/m);
  assert.match(dry.stdout, /^project projects\/api$/m);
  assert.match(dry.stdout, /^project tools$/m);
  assert.ok(dry.stdout.includes(`would clone ${member(root, 'projects/web')}`));
  assert.ok(dry.stdout.includes(`         to ${member(plan.target, 'projects/web')}`));
  assert.match(dry.stdout, /^would create branch feat from HEAD$/m);
  assert.strictEqual(fs.existsSync(plan.target), false);
});

test('add --dry-run heads the group rules like add does', (t) => {
  const root = makeGroup(t, { groupRules: 'copy .env.shared\n' });

  const dry = runCli(root, 'add', 'feat', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  const lines = dry.stdout.split('\n');
  const heading = lines.indexOf('group rules');
  assert.ok(heading > 0, dry.stdout);
  assert.match(lines[heading + 1], /^would {2}copy \.env\.shared/);

  const add = runCli(root, 'add', 'feat');
  assert.strictEqual(add.status, 0, add.stderr);
  assert.ok(add.stdout.split('\n').includes('group rules'), add.stdout);
});

// --- list, status, path --------------------------------------------------

test('the lock directory a group command leaves in every member is not reported as uncommitted changes', (t) => {
  const root = makeGroup(t);
  const progress = [];
  api.createWorkspace(root, { name: 'feat', onProgress: (line) => progress.push(line) });
  assert.deepStrictEqual(progress.filter((line) => line.startsWith('warning:')), []);

  // add leaves the lock directory .worktrees/ in each source and nothing excludes it:
  // Git lists it as untracked while the lock file is inside, which is when the clean check runs.
  for (const project of DEFAULT_PROJECTS) {
    assert.ok(fs.existsSync(path.join(member(root, project), '.worktrees')));
  }
  const again = runCli(root, 'add', 'feat2');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^warning:/m);

  fs.writeFileSync(path.join(member(root, 'tools'), 'scratch.txt'), 'wip\n');
  assert.deepStrictEqual(api.planWorkspaceCreation(root, { name: 'feat3' }).warnings, [
    'tools has uncommitted changes; its clone will only contain committed tracked files',
  ]);
});

test('list shows a group workspace as one line; status shows every member', (t) => {
  const root = makeGroup(t);
  const added = runCli(root, 'add', 'feat');
  assert.strictEqual(added.status, 0, added.stderr);
  assert.match(added.stdout, /^project projects\/api$/m);
  assert.match(added.stdout, /^done {3}feat$/m);
  assert.ok(added.stdout.includes(`path   ${workspaceDir(root, 'feat')}`));
  const feat = workspaceDir(root, 'feat');

  const [main, workspace, ...rest] = api.listWorkspaces(root);
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(main.name, 'main');
  assert.strictEqual(main.isMain, true);
  assert.strictEqual(main.path, root);
  assert.strictEqual(main.branch, 'main');
  assert.deepStrictEqual(main.projects.map((project) => project.path), DEFAULT_PROJECTS.map((project) => member(root, project)));
  assert.strictEqual(workspace.name, 'feat');
  assert.strictEqual(workspace.path, feat);
  assert.strictEqual(workspace.isClone, true);
  assert.strictEqual(workspace.branch, 'feat');
  assert.strictEqual(workspace.head, undefined);
  assert.strictEqual(workspace.clean, true);
  assert.strictEqual(workspace.broken, undefined);
  assert.deepStrictEqual(workspace.projects.map((project) => [project.project, project.isClone, project.branch, project.clean]), [
    ['projects/api', true, 'feat', true],
    ['projects/web', true, 'feat', true],
    ['tools', true, 'feat', true],
  ]);
  assert.strictEqual(workspace.projects[0].head, git(member(feat, 'projects/api'), 'rev-parse', 'HEAD'));

  const listed = runCli(root, 'list');
  assert.strictEqual(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^main\s+main\s+/m);
  assert.match(listed.stdout, /^feat\s+feat\s+/m);
  assert.ok(listed.stdout.includes(feat));
  assert.doesNotMatch(listed.stdout, /projects\/api/);

  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0, status.stderr);
  for (const name of ['main/projects/api', 'main/projects/web', 'main/tools', 'feat/projects/api', 'feat/projects/web', 'feat/tools']) {
    assert.match(status.stdout, new RegExp(`^${name.replace(/\//g, '\\/')}\\s+(main|feat)\\s+no upstream\\s+clean\\s+(preserved in source|-)$`, 'm'));
  }

  git(member(feat, 'projects/web'), 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(feat, 'tools', 'note.txt'), 'x\n');
  const mixed = api.listWorkspaces(root)[1];
  assert.strictEqual(mixed.branch, undefined);
  assert.strictEqual(mixed.clean, false);
  assert.match(runCli(root, 'list').stdout, /^feat\s+mixed\s+/m);
});

test('a workspace with a missing member is incomplete, still listed, and can be removed', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  fs.rmSync(member(feat, 'projects/web'), { recursive: true });
  // Even without the .workler copy the clones identify the workspace.
  fs.rmSync(path.join(feat, '.workler'));

  const workspace = api.listWorkspaces(root)[1];
  assert.strictEqual(workspace.name, 'feat');
  assert.strictEqual(workspace.isClone, true);
  assert.strictEqual(workspace.broken, 'projects/web: missing (not cloned)');
  assert.strictEqual(workspace.branch, undefined);
  assert.strictEqual(workspace.clean, undefined);
  assert.match(runCli(root, 'list').stdout, /^feat\s+incomplete\s+/m);
  assert.match(runCli(root, 'status').stdout, /^feat\/projects\/web\s+-\s+-\s+broken: missing \(not cloned\)\s+-$/m);

  fs.mkdirSync(member(feat, 'projects/web'));
  fs.writeFileSync(path.join(member(feat, 'projects/web'), 'x.txt'), 'x\n');
  fs.mkdirSync(path.join(root, '.worktrees', 'junk'));
  fs.writeFileSync(path.join(root, '.worktrees', 'junk', 'x.txt'), 'x\n');
  const status = runCli(root, 'status');
  assert.match(status.stdout, /^feat\/projects\/web\s+-\s+-\s+broken: missing .git \(not a clone\)\s+unknown: workspace repository is missing or broken$/m);
  assert.match(status.stdout, /^junk\s+-\s+-\s+broken: not a group workspace/m);
  assert.doesNotMatch(runCli(root, 'list').stdout, /^junk/m);
  assert.deepStrictEqual(api.listWorkspaces(root).map((info) => [info.name, info.isClone]), [['main', true], ['feat', true], ['junk', false]]);

  // The not-a-clone member holds unknown data; the never-cloned one alone does not.
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/web: not a Git clone/.test(error.message));
  fs.rmSync(member(feat, 'projects/web'), { recursive: true });
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat'), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
});

test('a symbolic link at a member path is local data: remove refuses, --force deletes only the link', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const source = path.join(root, 'projects', 'api');
  const link = member(feat, 'projects/api');
  const dirLinkType = process.platform === 'win32' ? 'junction' : undefined;

  // First a dangling link, then a link straight at the source repository.
  fs.rmSync(link, { recursive: true });
  fs.symlinkSync(path.join(root, 'does-not-exist'), link);
  for (const target of [undefined, source]) {
    if (target) {
      fs.unlinkSync(link);
      fs.symlinkSync(target, link, dirLinkType);
    }
    const workspace = api.listWorkspaces(root)[1];
    assert.strictEqual(workspace.name, 'feat');
    assert.strictEqual(workspace.broken, 'projects/api: a symbolic link, not a clone');
    assert.strictEqual(workspace.clean, undefined);
    assert.match(runCli(root, 'status').stdout, /^feat\/projects\/api\s+-\s+-\s+broken: a symbolic link, not a clone\s+unknown: workspace repository is missing or broken$/m);
    assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: a symbolic link, not a clone/.test(error.message));
    assert.strictEqual(fs.existsSync(feat), true);
  }

  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(a symbolic link, not a clone\)$/m);
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /projects\/api in workspace feat is a symbolic link, not a clone/);

  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  assert.strictEqual(fs.lstatSync(path.join(source, '.git')).isDirectory(), true);
  assert.ok(fs.readdirSync(source).length > 1);
});

test('a source repository behind a symbolic link is refused: nothing reaches what the link points at', (t) => {
  const dirLinkType = process.platform === 'win32' ? 'junction' : undefined;
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const namespace = api.groupRefNamespace(root);

  // `projects/api` then resolves to a repository outside the group.
  const outside = makeTempDir(t, 'workler-outside-');
  fs.renameSync(path.join(root, 'projects'), path.join(outside, 'projects'));
  fs.symlinkSync(path.join(outside, 'projects'), path.join(root, 'projects'), dirLinkType);
  const externalApi = path.join(outside, 'projects', 'api');
  const snapshot = () => ({ files: fs.readdirSync(externalApi).sort(), head: git(externalApi, 'rev-parse', 'HEAD') });
  const externalBefore = snapshot();

  const [main] = api.listWorkspaces(root);
  const sourceOf = (project) => main.projects.find((entry) => entry.project === project);
  assert.strictEqual(sourceOf('projects/api').broken, 'behind a symbolic link at projects, not a repository');
  assert.strictEqual(sourceOf('projects/web').broken, 'behind a symbolic link at projects, not a repository');
  assert.strictEqual(sourceOf('tools').broken, undefined);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 1, status.stderr);
  assert.match(status.stdout, /^main\/projects\/api\s+-\s+-\s+broken: behind a symbolic link at projects, not a repository\s+-$/m);

  const synced = runCli(root, 'sync');
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /main\/projects\/api\s+skipped \(broken: behind a symbolic link at projects, not a repository\)/);
  const branchSync = runCli(root, 'branch-sync');
  assert.strictEqual(branchSync.status, 0, branchSync.stderr);
  assert.match(branchSync.stdout, /^  skipped \(source main\/projects\/api is broken: behind a symbolic link at projects, not a repository\)$/m);
  assert.deepStrictEqual(refs(externalApi, namespace), []);
  assert.ok(refs(path.join(root, 'tools'), namespace).includes(`${namespace}/feat/feat`));

  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(source main\/projects\/api is behind a symbolic link at projects, not a repository\)$/m);
  assert.match(applied.stdout, /^project tools$/m);
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /source main\/projects\/api is behind a symbolic link at projects, not a repository/);

  assert.throws(
    () => api.createWorkspace(root, { name: 'other' }),
    (error) => error.code === 'NOT_A_GIT_REPO' && error.details.project === 'projects/api'
      && /behind a symbolic link at projects, not a repository/.test(error.message),
  );
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'other')), false);

  assert.deepStrictEqual(snapshot(), externalBefore);

  // The repository behind the link gets a `copy secret` rule that bare `apply`
  // inside the member clone must not follow.
  const memberApi = path.join(workspaceDir(root, 'feat'), 'projects', 'api');
  fs.writeFileSync(path.join(externalApi, '.workler'), 'copy secret\n');
  fs.writeFileSync(path.join(externalApi, 'secret'), 'leak\n');
  const memberInfo = api.inspectProject(memberApi);
  assert.strictEqual(memberInfo.parent, undefined);
  assert.deepStrictEqual(memberInfo.memberOf, { group: fs.realpathSync(root), workspace: 'feat', project: 'projects/api' });
  const bare = runCli(memberApi, 'apply');
  assert.strictEqual(bare.status, 1);
  assert.match(bare.stderr, /source main\/projects\/api is behind a symbolic link at projects, not a repository/);
  assert.strictEqual(fs.existsSync(path.join(memberApi, 'secret')), false);
});

test('a source replaced by a plain folder is refused by bare apply inside the member', (t) => {
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const memberTools = path.join(workspaceDir(root, 'feat'), 'tools');
  const sourceTools = path.join(root, 'tools');
  assert.strictEqual(api.inspectProject(memberTools).parent, fs.realpathSync(sourceTools));

  fs.rmSync(sourceTools, { recursive: true, force: true });
  fs.mkdirSync(sourceTools);
  fs.writeFileSync(path.join(sourceTools, '.workler'), 'copy secret\n');
  fs.writeFileSync(path.join(sourceTools, 'secret'), 'leak\n');

  const info = api.inspectProject(memberTools);
  assert.strictEqual(info.parent, undefined);
  assert.deepStrictEqual(info.memberOf, { group: fs.realpathSync(root), workspace: 'feat', project: 'tools' });
  const bare = runCli(memberTools, 'apply');
  assert.strictEqual(bare.status, 1);
  assert.match(bare.stderr, /source main\/tools is [^\n]*not a (Git )?repository/);
  assert.strictEqual(fs.existsSync(path.join(memberTools, 'secret')), false);

  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project tools: skipped \(source main\/tools is [^)]*not a (Git )?repository[^)]*\)$/m);
  assert.strictEqual(fs.existsSync(path.join(memberTools, 'secret')), false);
});


test('a symbolic link on the way to a nested member is never followed: status, apply, branch-sync and remove treat the member as local data', (t) => {
  const { execFileSync } = require('node:child_process');
  const refs = (cwd, prefix) => execFileSync('git', ['for-each-ref', '--format=%(refname)', prefix], { cwd, encoding: 'utf8' }).trim();
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const dirLinkType = process.platform === 'win32' ? 'junction' : undefined;
  const sourceApi = path.join(root, 'projects', 'api');
  const sourceWeb = path.join(root, 'projects', 'web');
  const sourceTools = path.join(root, 'tools');
  // `add` and `branch-sync` at the group root lock each usable source, which
  // leaves an empty .worktrees/ (the lock directory) behind; ignore it.
  const withoutLockDir = (dir) => fs.readdirSync(dir).filter((entry) => entry !== '.worktrees').sort();
  const before = { api: withoutLockDir(sourceApi), web: withoutLockDir(sourceWeb) };

  // A link to the group's own `projects` folder puts the source repositories
  // exactly where the members are expected, behind the link.
  fs.rmSync(path.join(feat, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(root, 'projects'), path.join(feat, 'projects'), dirLinkType);

  const workspace = api.listWorkspaces(root)[1];
  assert.strictEqual(workspace.name, 'feat');
  assert.match(workspace.broken, /projects\/api: behind a symbolic link at projects, not a clone/);
  assert.match(workspace.broken, /projects\/web: behind a symbolic link at projects, not a clone/);
  assert.strictEqual(workspace.clean, undefined);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 1, status.stderr);
  assert.match(status.stdout, /^feat\/projects\/api\s+-\s+-\s+broken: behind a symbolic link at projects, not a clone\s+unknown: workspace repository is missing or broken$/m);
  assert.match(status.stdout, /^feat\/projects\/web\s+-\s+-\s+broken: behind a symbolic link at projects, not a clone\s+unknown: workspace repository is missing or broken$/m);
  assert.match(status.stdout, /^feat\/tools\s+feat\s/m);

  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(behind a symbolic link at projects, not a clone\)$/m);
  assert.match(applied.stdout, /^project projects\/web: skipped \(behind a symbolic link at projects, not a clone\)$/m);
  assert.match(applied.stdout, /^project tools$/m);
  const one = runCli(root, 'apply', 'feat/projects/web');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /projects\/web in workspace feat is behind a symbolic link at projects, not a clone/);

  const namespace = api.groupRefNamespace(root);
  runCli(root, 'branch-sync');
  const mirrored = refs(sourceTools, namespace).split('\n');
  assert.ok(mirrored.includes(`${namespace}/feat/feat`), mirrored.join(', '));
  assert.ok(mirrored.every((ref) => ref.startsWith(`${namespace}/feat/`)), mirrored.join(', '));
  assert.strictEqual(refs(sourceApi, 'refs/workler-group'), '');
  assert.strictEqual(refs(sourceWeb, 'refs/workler-group'), '');

  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) =>
    error.code === 'WORKSPACE_DIRTY'
    && /projects\/api: behind a symbolic link at projects, not a clone/.test(error.message)
    && /projects\/web: behind a symbolic link at projects, not a clone/.test(error.message)
    && !/not part of a declared project/.test(error.message));
  assert.strictEqual(fs.existsSync(feat), true);
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  assert.deepStrictEqual(withoutLockDir(sourceApi), before.api);
  assert.deepStrictEqual(withoutLockDir(sourceWeb), before.web);
  for (const dir of [sourceApi, sourceWeb]) {
    if (fs.existsSync(path.join(dir, '.worktrees'))) {
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.worktrees')), [], `${dir}: only the released lock directory`);
    }
  }
  assert.strictEqual(fs.lstatSync(path.join(sourceApi, '.git')).isDirectory(), true);
});

test('a group workspace whose first clone failed is still listed, as incomplete', (t) => {
  const root = makeGroup(t);
  // What createWorkspace leaves behind when the first member clone fails.
  const feat = workspaceDir(root, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  fs.copyFileSync(path.join(root, '.workler'), path.join(feat, '.workler'));

  const workspace = api.listWorkspaces(root)[1];
  assert.strictEqual(workspace.name, 'feat');
  assert.strictEqual(workspace.isClone, true);
  assert.strictEqual(workspace.broken, 'projects/api: missing (not cloned); projects/web: missing (not cloned); tools: missing (not cloned)');
  assert.deepStrictEqual(workspace.projects.map((project) => project.isClone), [false, false, false]);
  assert.match(runCli(root, 'list').stdout, /^feat\s+incomplete\s+/m);

  assert.deepStrictEqual(api.removeWorkspace(root, 'feat'), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
});

test('path resolves a workspace, one member of it, and a source repository', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;

  assert.strictEqual(api.resolveWorkspacePath(root, 'main'), root);
  assert.strictEqual(api.resolveWorkspacePath(root, 'feat'), feat);
  assert.strictEqual(api.resolveWorkspacePath(root, 'feat/projects/api'), member(feat, 'projects/api'));
  assert.strictEqual(api.resolveWorkspacePath(root, 'feat/projects/api/'), member(feat, 'projects/api'));
  assert.strictEqual(api.resolveWorkspacePath(root, 'feat\\tools'), member(feat, 'tools'));
  assert.strictEqual(api.resolveWorkspacePath(root, 'main/projects/web'), member(root, 'projects/web'));
  assert.throws(() => api.resolveWorkspacePath(root, 'feat/projects'), (error) => error.code === 'WORKSPACE_NOT_FOUND' && /declared projects: projects\/api, projects\/web, tools/.test(error.message));
  assert.throws(() => api.resolveWorkspacePath(root, 'nope'), (error) => error.code === 'WORKSPACE_NOT_FOUND');
  assert.throws(() => api.resolveWorkspacePath(root, 'nope/projects/api'), (error) => error.code === 'WORKSPACE_NOT_FOUND');

  const cli = runCli(root, 'path', 'feat/projects/api');
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(cli.stdout.trim(), member(feat, 'projects/api'));
  assert.strictEqual(runCli(root, 'path', 'feat').stdout.trim(), feat);
  assert.strictEqual(runCli(root, 'path', 'feat/nope').status, 1);

  // Outside a group a slash is just part of an unknown name.
  const repo = makeRepo(t);
  assert.throws(() => api.resolveWorkspacePath(repo, 'main/x'), (error) => error.code === 'WORKSPACE_NOT_FOUND');
});

// --- the three levels ----------------------------------------------------

test('a project keeps its own workspaces; they are never part of a group workspace', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\n' } });
  const source = member(root, 'projects/api');

  const fix = api.createWorkspace(source, { name: 'fix' });
  assert.strictEqual(fix.path, path.join(source, '.worktrees', 'fix'));
  assert.strictEqual(api.inspectProject(fix.path).parent, source);
  assert.strictEqual(api.inspectProject(fix.path).memberOf, undefined);
  assert.deepStrictEqual(api.listWorkspaces(source).map((info) => info.name), ['main', 'fix']);

  const feat = api.createWorkspace(root, { name: 'feat' });
  assert.strictEqual(fs.existsSync(path.join(feat.path, 'projects', 'api', '.worktrees')), false);
  assert.deepStrictEqual(api.listWorkspaces(root).map((info) => info.name), ['main', 'feat']);
  assert.deepStrictEqual(api.listWorkspaces(source).map((info) => info.name), ['main', 'fix']);
});

test('a member clone is a project of its own that can host nested workspaces', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\n' } });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const clone = member(feat, 'projects/api');
  const source = member(root, 'projects/api');

  assert.strictEqual(api.findWorklerRoot(clone), clone);
  const inside = path.join(clone, 'src');
  fs.mkdirSync(inside);
  assert.strictEqual(api.findWorklerRoot(inside), clone);

  const info = api.inspectProject(clone);
  assert.strictEqual(info.marked, true);
  assert.strictEqual(info.isGroup, false);
  assert.strictEqual(info.parent, source);
  assert.deepStrictEqual(info.memberOf, { group: root, workspace: 'feat', project: 'projects/api' });

  const sub = api.createWorkspace(clone, { name: 'sub' });
  assert.strictEqual(sub.path, path.join(clone, '.worktrees', 'sub'));
  assert.strictEqual(sub.branch, 'sub');
  assert.strictEqual(git(sub.path, 'config', '--get', 'workler.root'), clone);
  // Git config is not cloned, so the nested workspace is not a group member.
  assert.throws(() => git(sub.path, 'config', '--get', 'workler.group'));
  assert.strictEqual(api.inspectProject(sub.path).parent, clone);
  assert.strictEqual(api.inspectProject(sub.path).memberOf, undefined);
  const link = path.join(sub.path, 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(path.resolve(path.dirname(link), fs.readlinkSync(link)), path.join(clone, 'node_modules'));

  assert.deepStrictEqual(api.listWorkspaces(clone).map((item) => item.name), ['main', 'sub']);
  assert.deepStrictEqual(api.listWorkspaces(root).map((item) => item.name), ['main', 'feat']);
  assert.strictEqual(api.listWorkspaces(root)[1].clean, false);
});

test('a group workspace is a group root of its own: nested group workspaces', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;

  assert.strictEqual(api.findWorklerRoot(feat), feat);
  assert.strictEqual(api.findWorklerRoot(path.join(feat, 'projects')), feat);
  const info = api.inspectProject(feat);
  assert.strictEqual(info.isGroup, true);
  assert.deepStrictEqual(info.projects, DEFAULT_PROJECTS);
  assert.strictEqual(info.parent, root);

  const nested = api.createWorkspace(feat, { name: 'feat2' });
  assert.strictEqual(nested.path, path.join(feat, '.worktrees', 'feat2'));
  assert.strictEqual(nested.branch, 'feat2');
  const nestedClone = member(nested.path, 'projects/api');
  assert.strictEqual(git(nestedClone, 'config', '--get', 'workler.root'), member(feat, 'projects/api'));
  assert.strictEqual(git(nestedClone, 'config', '--get', 'workler.group'), feat);
  assert.strictEqual(api.inspectProject(nestedClone).parent, member(feat, 'projects/api'));
  assert.strictEqual(api.findWorklerRoot(nested.path), nested.path);
  assert.strictEqual(api.inspectProject(nested.path).parent, feat);

  assert.deepStrictEqual(api.listWorkspaces(root).map((item) => item.name), ['main', 'feat']);
  assert.deepStrictEqual(api.listWorkspaces(feat).map((item) => item.name), ['main', 'feat2']);
  assert.strictEqual(api.resolveWorkspacePath(feat, 'feat2/tools'), member(nested.path, 'tools'));

  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /\.worktrees: not part of a declared project/.test(error.message));
  api.removeWorkspace(feat, 'feat2');
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat'), { name: 'feat', path: feat });
});

// --- apply ---------------------------------------------------------------

test('apply refreshes every member from its source repository, then the group rules', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\n' }, groupRules: 'copy .env.shared\n' });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const link = path.join(feat, 'projects', 'api', 'node_modules');
  const shared = path.join(feat, '.env.shared');
  const wipe = () => {
    fs.rmSync(link, { force: true });
    fs.rmSync(shared, { force: true });
  };

  wipe();
  const whole = runCli(root, 'apply', 'feat');
  assert.strictEqual(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /^project projects\/api$/m);
  assert.match(whole.stdout, /^group rules$/m);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(shared));

  wipe();
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.doesNotMatch(one.stdout, /group rules/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.existsSync(shared), false);

  wipe();
  const inMember = runCli(path.join(feat, 'projects', 'api'), 'apply');
  assert.strictEqual(inMember.status, 0, inMember.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.existsSync(shared), false);

  wipe();
  const inWorkspace = runCli(feat, 'apply');
  assert.strictEqual(inWorkspace.status, 0, inWorkspace.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(shared));

  wipe();
  const all = runCli(root, 'apply', '--all');
  assert.strictEqual(all.status, 0, all.stderr);
  assert.match(all.stdout, /^applying feat$/m);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(shared));

  const dry = runCli(root, 'apply', 'feat', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^dry run: nothing will be changed$/m);

  assert.strictEqual(runCli(root, 'apply', 'feat/nope').status, 1);
  assert.match(runCli(root, 'apply', 'feat/nope').stderr, /project not found/);
  assert.strictEqual(runCli(root, 'apply', 'main/projects/api').status, 1);
  assert.strictEqual(runCli(root, 'apply').status, 1);

  fs.rmSync(path.join(feat, 'tools'), { recursive: true });
  const partial = runCli(root, 'apply', 'feat');
  assert.strictEqual(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /^project tools: skipped \(not cloned\)$/m);
  assert.strictEqual(fs.existsSync(path.join(feat, 'tools')), false);
});

test('the group rules keep their own copy-links mode; one member switching its mode does not flip it', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\n' }, groupRules: 'link shared\n' });
  fs.mkdirSync(path.join(root, 'shared'));
  fs.writeFileSync(path.join(root, 'shared', 'marker.txt'), 'shared\n');
  const feat = api.createWorkspace(root, { name: 'feat', copyLinks: true }).path;
  const clone = member(feat, 'projects/api');
  const groupCopy = path.join(feat, 'shared');
  const memberCopy = path.join(clone, 'node_modules');
  assert.ok(fs.lstatSync(groupCopy).isDirectory(), 'the group link rule is copied');
  assert.ok(fs.lstatSync(memberCopy).isDirectory(), 'the member link rule is copied');
  assert.strictEqual(git(clone, 'config', '--get', 'workler.copyLinks'), 'true');
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');

  const one = runCli(root, 'apply', 'feat/projects/api', '--no-copy-links', '--force');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.ok(fs.lstatSync(memberCopy).isSymbolicLink());
  assert.throws(() => git(clone, 'config', '--get', 'workler.copyLinks'));
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');

  const whole = runCli(root, 'apply', 'feat');
  assert.strictEqual(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /^ok {5}link shared \(destination matches source\)$/m);
  assert.ok(fs.lstatSync(groupCopy).isDirectory());

  const back = runCli(root, 'apply', 'feat', '--no-copy-links', '--force');
  assert.strictEqual(back.status, 0, back.stderr);
  assert.ok(fs.lstatSync(groupCopy).isSymbolicLink());
  assert.throws(() => git(clone, 'config', '--get', 'workler.groupCopyLinks'));
  const again = runCli(root, 'apply', 'feat');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.ok(fs.lstatSync(groupCopy).isSymbolicLink());
});

test('apply records an explicit group copy-links mode even while the group has no rules yet', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const clone = member(feat, 'projects/api');
  assert.throws(() => git(clone, 'config', '--get', 'workler.groupCopyLinks'));

  const choose = runCli(root, 'apply', 'feat', '--copy-links');
  assert.strictEqual(choose.status, 0, choose.stderr);
  assert.doesNotMatch(choose.stdout, /^group rules$/m);
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');
  const dry = runCli(root, 'apply', 'feat', '--no-copy-links', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');

  fs.mkdirSync(path.join(root, 'shared'));
  fs.writeFileSync(path.join(root, 'shared', 'marker.txt'), 'shared\n');
  fs.appendFileSync(path.join(root, '.workler'), 'link shared\n');
  const plain = runCli(root, 'apply', 'feat');
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^group rules$/m);
  const groupCopy = path.join(feat, 'shared');
  assert.ok(fs.lstatSync(groupCopy).isDirectory(), 'the new group link rule is copied, as chosen before');
  assert.strictEqual(fs.readFileSync(path.join(groupCopy, 'marker.txt'), 'utf8'), 'shared\n');
});

// --- remove --------------------------------------------------------------

test('bare apply inside a member clone takes the group lock, like every other group command', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'], rules: { 'projects/api': 'link node_modules\n' } });
  const clone = path.join(api.createWorkspace(root, { name: 'feat' }).path, 'projects', 'api');
  const link = path.join(clone, 'node_modules');
  // Holds a project's lock as this (live) process.
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // `remove feat` and `apply feat/projects/api` take the group lock too, so none
  // of them can race this apply.
  fs.rmSync(link, { force: true });
  let release = hold(root);
  try {
    const blocked = runCli(clone, 'apply');
    assert.strictEqual(blocked.status, 1);
    assert.match(blocked.stderr, /lock/i);
    assert.strictEqual(fs.existsSync(link), false);
  } finally {
    release();
  }

  // The source's lock blocks it too: a `sync` there must not rewrite the rules or
  // link targets while apply reads them.
  release = hold(member(root, 'projects/api'));
  try {
    const blocked = runCli(clone, 'apply');
    assert.strictEqual(blocked.status, 1);
    assert.match(blocked.stderr, /lock/i);
    assert.strictEqual(fs.existsSync(link), false);
  } finally {
    release();
  }

  // The clone's own lock does not: a bare apply changes the clone, not its .worktrees/.
  release = hold(clone);
  try {
    const ok = runCli(clone, 'apply');
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  } finally {
    release();
  }
});

test('every mutating command inside a member clone takes the group lock first, then its own', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'] });
  const clone = path.join(api.createWorkspace(root, { name: 'feat' }).path, 'projects', 'api');
  api.createWorkspace(clone, { name: 'nested' });
  const nested = path.join(clone, '.worktrees', 'nested');
  const nested2 = path.join(clone, '.worktrees', 'nested2');
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // `remove feat` holds only the group's lock while it deletes the clones; without it,
  // remove could pass its clean check and then delete a workspace `add` is still cloning.
  let release = hold(root);
  try {
    for (const args of [['add', 'nested2'], ['remove', 'nested'], ['apply', 'nested'], ['apply', '--all'], ['fetch'], ['sync'], ['branch-sync'], ['init']]) {
      const blocked = runCli(clone, ...args);
      assert.strictEqual(blocked.status, 1, `${args.join(' ')} ran: ${blocked.stdout}`);
      assert.match(blocked.stderr, /lock/i, args.join(' '));
    }
    assert.throws(() => api.createWorkspace(clone, { name: 'nested2' }), { code: 'LOCKED' });
    assert.throws(() => api.removeWorkspace(clone, 'nested', { force: true }), { code: 'LOCKED' });
    assert.throws(() => api.initProject(clone), { code: 'LOCKED' });
    assert.strictEqual(fs.existsSync(nested2), false, 'nothing was cloned under the held lock');
    assert.ok(fs.existsSync(nested), 'nothing was removed under the held lock');
  } finally {
    release();
  }

  release = hold(clone);
  try {
    assert.throws(() => api.createWorkspace(clone, { name: 'nested2' }), { code: 'LOCKED' });
    assert.throws(() => api.removeWorkspace(clone, 'nested', { force: true }), { code: 'LOCKED' });
  } finally {
    release();
  }

  api.createWorkspace(clone, { name: 'nested2' });
  api.removeWorkspace(clone, 'nested2', { force: true });
  assert.strictEqual(fs.existsSync(path.join(root, '.worktrees', '.workler.lock')), false);
  assert.strictEqual(fs.existsSync(path.join(clone, '.worktrees', '.workler.lock')), false);
});

test('add inside a group workspace folder (a nested group) takes the outer group lock first', (t) => {
  const root = makeGroup(t, { projects: ['projects/api'] });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // `remove feat` holds only the root's lock while it deletes feat; without it, remove
  // could pass its check and then delete clones a nested `add` is making.
  let release = hold(root);
  try {
    const blocked = runCli(feat, 'add', 'feat2');
    assert.strictEqual(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stderr, /lock/i);
    assert.throws(() => api.createWorkspace(feat, { name: 'feat2' }), { code: 'LOCKED' });
    assert.strictEqual(fs.existsSync(workspaceDir(feat, 'feat2')), false, 'nothing was created under the held lock');
  } finally {
    release();
  }

  release = hold(feat);
  try {
    assert.throws(() => api.createWorkspace(feat, { name: 'feat2' }), { code: 'LOCKED' });
  } finally {
    release();
  }

  // Two levels down, the root's lock still applies.
  const feat2 = api.createWorkspace(feat, { name: 'feat2' }).path;
  release = hold(root);
  try {
    assert.throws(() => api.createWorkspace(feat2, { name: 'feat3' }), { code: 'LOCKED' });
    assert.throws(() => api.removeWorkspace(feat, 'feat2', { force: true }), { code: 'LOCKED' });
    assert.strictEqual(runCli(feat2, 'add', 'feat3').status, 1);
    assert.strictEqual(fs.existsSync(workspaceDir(feat2, 'feat3')), false);
    assert.ok(fs.existsSync(feat2), 'nothing was removed under the held lock');
  } finally {
    release();
  }

  api.createWorkspace(feat2, { name: 'feat3' });
  for (const dir of [root, feat, feat2]) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.worktrees', '.workler.lock')), false, dir);
  }
});

test('fetch, sync and branch-sync at a group root also hold every usable source repository lock', (t) => {
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const source = member(root, 'projects/api');
  // A missing source is skipped, so it must not be locked either: locking would
  // create .worktrees/ there.
  fs.appendFileSync(path.join(root, '.workler'), 'project projects/missing\n');
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // A `sync` inside one source holds its lock; the group commands fetch into and
  // fast-forward that same checkout.
  const release = hold(source);
  try {
    for (const args of [['fetch'], ['sync'], ['branch-sync']]) {
      const blocked = runCli(root, ...args);
      assert.strictEqual(blocked.status, 1, `${args.join(' ')} ran: ${blocked.stdout}`);
      assert.match(blocked.stderr, /lock/i, args.join(' '));
    }
  } finally {
    release();
  }

  // `add` left empty lock directories in the sources; clear them to see `sync` lock them.
  for (const dir of ['projects/web', 'tools']) {
    fs.rmSync(path.join(member(root, dir), '.worktrees'), { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(path.join(member(root, dir), '.worktrees')), false, `${dir} has no .worktrees now`);
  }
  const synced = runCli(root, 'sync');
  assert.strictEqual(synced.status, 0, synced.stderr);
  for (const dir of ['projects/api', 'projects/web', 'tools']) {
    assert.ok(fs.existsSync(path.join(member(root, dir), '.worktrees')), `${dir} was locked`);
    assert.strictEqual(fs.existsSync(path.join(member(root, dir), '.worktrees', '.workler.lock')), false, `${dir} lock released`);
  }
  assert.strictEqual(fs.existsSync(member(root, 'projects/missing')), false, 'the missing source was not created by locking');
  assert.match(synced.stdout, /main\/projects\/missing\s+skipped \(broken:/);
  assert.strictEqual(fs.existsSync(path.join(root, '.worktrees', '.workler.lock')), false);
});

test('apply on a workspace with no member clone skips the group rules instead of recording nothing', (t) => {
  const root = makeGroup(t, { groupRules: 'link shared\n' });
  fs.mkdirSync(path.join(root, 'shared'));
  fs.writeFileSync(path.join(root, 'shared', 'x.txt'), 'x\n');
  // What createWorkspace leaves behind when the first member clone fails.
  const feat = workspaceDir(root, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  fs.copyFileSync(path.join(root, '.workler'), path.join(feat, '.workler'));

  // The group's copy-links mode is recorded in the member clones. With none, a copy made
  // now would be forgotten and the next plain apply would report a conflict.
  const explicit = runCli(root, 'apply', 'feat', '--copy-links');
  assert.strictEqual(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /group rules: skipped \(workspace feat has no member clone; remove it and run add again\)/);
  assert.strictEqual(fs.existsSync(path.join(feat, 'shared')), false);

  const plain = runCli(root, 'apply', 'feat');
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /group rules: skipped/);
  assert.doesNotMatch(plain.stdout + plain.stderr, /conflict/i);
  assert.strictEqual(fs.existsSync(path.join(feat, 'shared')), false);

  const all = runCli(root, 'apply', '--all');
  assert.strictEqual(all.status, 0, all.stderr);
  assert.match(all.stdout, /group rules: skipped/);
});

test('add and apply at a group root hold every usable source repository lock, like fetch and sync', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\n' } });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const link = path.join(feat, 'projects', 'api', 'node_modules');
  const other = workspaceDir(root, 'other');
  // Holds a project's lock as this (live) process.
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // Stands in for a `sync` inside projects/api, whose fast-forward could rewrite files
  // the group root clones or copies from it.
  fs.rmSync(link, { force: true });
  const release = hold(member(root, 'projects/api'));
  try {
    for (const args of [['apply', 'feat'], ['apply', 'feat/projects/api'], ['apply', '--all'], ['add', 'other']]) {
      const blocked = runCli(root, ...args);
      assert.strictEqual(blocked.status, 1, args.join(' '));
      assert.match(blocked.stderr, /lock/i, args.join(' '));
    }
    assert.strictEqual(fs.existsSync(link), false);
    assert.strictEqual(fs.existsSync(other), false);
    assert.throws(() => api.createWorkspace(root, { name: 'other' }), (error) => error.code === 'LOCKED');
    // Dry runs take no locks.
    const dry = runCli(root, 'apply', 'feat', '--dry-run');
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.doesNotThrow(() => api.planWorkspaceCreation(root, { name: 'other' }));
  } finally {
    release();
  }

  const ok = runCli(root, 'apply', 'feat');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(api.createWorkspace(root, { name: 'other' }).path, other);
  for (const dir of [root, member(root, 'projects/api'), member(root, 'projects/web'), member(root, 'tools')]) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.worktrees', '.workler.lock')), false, dir);
  }
});

test('a repository at a member path that is not the recorded clone counts as local data', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'link node_modules\ncopy .env\n' } });
  api.createWorkspace(root, { name: 'feat' });
  const feat = workspaceDir(root, 'feat');
  const apiMember = member(feat, 'projects/api');
  const sourceApi = member(root, 'projects/api');
  const namespace = api.groupRefNamespace(root).replace(/\/$/, '');

  // An unrelated clean repository: it has a .git directory but none of the identity `add` records.
  fs.rmSync(apiMember, { recursive: true, force: true });
  makeRepoAt(apiMember, { includeWorkler: false });
  git(apiMember, 'checkout', '-qb', 'private');
  const foreignHead = git(apiMember, 'rev-parse', 'HEAD');
  const before = fs.readdirSync(apiMember).sort();

  const listed = api.listWorkspaces(root).find((workspace) => workspace.name === 'feat');
  assert.match(listed.broken, /projects\/api: not the recorded clone of projects\/api/);
  assert.strictEqual(listed.clean, undefined);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 1);
  assert.match(status.stdout, /feat\/projects\/api[^\n]*not the recorded clone of projects\/api/);

  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /project projects\/api: skipped \(not the recorded clone of projects\/api/);
  assert.deepStrictEqual(fs.readdirSync(apiMember).sort(), before);
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /not the recorded clone of projects\/api/);

  const synced = runCli(root, 'sync');
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /feat\/projects\/api[^\n]*skipped \(broken: not the recorded clone/);
  const mirrored = runCli(root, 'branch-sync');
  assert.strictEqual(mirrored.status, 0, mirrored.stderr);
  assert.deepStrictEqual(refs(sourceApi, namespace), []);
  assert.strictEqual(git(apiMember, 'remote'), '');
  assert.strictEqual(git(apiMember, 'rev-parse', 'HEAD'), foreignHead);

  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: not the recorded clone of projects\/api/.test(error.message),
  );
  assert.strictEqual(git(apiMember, 'rev-parse', 'HEAD'), foreignHead);
  api.removeWorkspace(root, 'feat', { force: true });
  assert.strictEqual(fs.existsSync(feat), false);

  // A clone recorded for another workspace is not this one's either.
  api.createWorkspace(root, { name: 'feat' });
  api.createWorkspace(root, { name: 'other' });
  fs.rmSync(apiMember, { recursive: true, force: true });
  fs.renameSync(member(workspaceDir(root, 'other'), 'projects/api'), apiMember);
  assert.match(
    api.listWorkspaces(root).find((workspace) => workspace.name === 'feat').broken,
    /projects\/api: not the recorded clone of projects\/api/,
  );
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
});

test('a clone that an interrupted add left unmarked still counts as the member', (t) => {
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const feat = workspaceDir(root, 'feat');
  const apiMember = member(feat, 'projects/api');
  const sourceApi = member(root, 'projects/api');
  const featInfo = () => api.listWorkspaces(root).find((workspace) => workspace.name === 'feat');

  // Interrupted between clone and marking: a bare `git clone --local` with no workler.* keys.
  fs.rmSync(apiMember, { recursive: true, force: true });
  git(root, 'clone', '-q', '--local', sourceApi, apiMember);
  assert.doesNotMatch(git(apiMember, 'config', '--local', '--list'), /^workler\./m);
  assert.strictEqual(featInfo().broken, undefined);
  assert.strictEqual(featInfo().projects.find((project) => project.project === 'projects/api').isClone, true);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0);
  assert.doesNotMatch(status.stdout, /broken/);
  const unmarked = api.inspectProject(apiMember);
  assert.deepStrictEqual(unmarked.memberOf, { group: root, workspace: 'feat', project: 'projects/api' });
  assert.strictEqual(unmarked.parent, sourceApi);

  // add marks in this order: workler.root and workler.name, the remotes, workler.group,
  // workler.groupProject. An interruption after any prefix still leaves the member.
  const unset = (repo, ...keys) => keys.forEach((key) => git(repo, 'config', '--unset', key));
  const prefixes = [
    ['root-only', (repo) => unset(repo, 'workler.name', 'workler.group', 'workler.groupProject')],
    ['no-group-marks', (repo) => unset(repo, 'workler.group', 'workler.groupProject')],
    ['no-group-project', (repo) => unset(repo, 'workler.groupProject')],
    // Remotes rewritten (workler-root points at the source), keys not yet written.
    ['remotes-only', (repo) => unset(repo, 'workler.root', 'workler.name', 'workler.group', 'workler.groupProject')],
  ];
  for (const [name, interrupt] of prefixes) {
    const repo = member(api.createWorkspace(root, { name }).path, 'projects/api');
    interrupt(repo);
    assert.strictEqual(api.listWorkspaces(root).find((workspace) => workspace.name === name).broken, undefined, name);
    assert.deepStrictEqual(api.inspectProject(repo).memberOf, { group: root, workspace: name, project: 'projects/api' }, name);
    api.removeWorkspace(root, name);
  }

  api.removeWorkspace(root, 'feat');
  assert.strictEqual(fs.existsSync(feat), false);

  // The same unmarked state cloned from the wrong source is not the member.
  api.createWorkspace(root, { name: 'feat' });
  fs.rmSync(apiMember, { recursive: true, force: true });
  git(root, 'clone', '-q', '--local', member(root, 'projects/web'), apiMember);
  assert.match(featInfo().broken, /projects\/api: not the recorded clone of projects\/api/);
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY');
  api.removeWorkspace(root, 'feat', { force: true });
  assert.strictEqual(fs.existsSync(feat), false);
});

test('commands inside a clone that add left unmarked still take the group lock', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const apiMember = member(feat, 'projects/api');
  fs.rmSync(apiMember, { recursive: true, force: true });
  git(root, 'clone', '-q', '--local', member(root, 'projects/api'), apiMember);
  // Holds a project's lock as this (live) process.
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // `remove feat` holds the group's lock; a workspace created in the clone now would
  // be deleted mid-creation.
  const nested = path.join(apiMember, '.worktrees', 'nested');
  const release = hold(root);
  try {
    for (const args of [['add', 'nested'], ['init'], ['apply']]) {
      const blocked = runCli(apiMember, ...args);
      assert.strictEqual(blocked.status, 1, args.join(' '));
      assert.match(blocked.stderr, /lock/i, args.join(' '));
    }
    assert.strictEqual(fs.existsSync(nested), false);
    assert.throws(() => api.createWorkspace(apiMember, { name: 'nested' }), (error) => error.code === 'LOCKED');
    assert.throws(() => api.initProject(apiMember), (error) => error.code === 'LOCKED');
  } finally {
    release();
  }

  api.initProject(apiMember);
  assert.strictEqual(api.createWorkspace(apiMember, { name: 'nested' }).path, nested);
  api.removeWorkspace(apiMember, 'nested', { force: true });
  assert.strictEqual(fs.existsSync(nested), false);
});

test('remove needs every member clean and nothing but members and rule outputs in the workspace folder', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'copy .env\n' }, groupRules: 'copy .env.shared\n' });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;

  assert.ok(fs.existsSync(path.join(feat, '.env.shared')));
  assert.strictEqual(api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean, true);
  fs.writeFileSync(path.join(member(feat, 'projects/api'), 'wip.txt'), 'x\n');
  fs.writeFileSync(path.join(feat, 'notes.txt'), 'x\n');
  assert.strictEqual(api.listWorkspaces(root).find((entry) => entry.name === 'feat').clean, false);
  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) =>
      error.code === 'WORKSPACE_DIRTY' &&
      error.details.reasons.includes('projects/api: uncommitted changes or untracked files') &&
      error.details.reasons.includes('notes.txt: not part of a declared project') &&
      !error.details.reasons.some((reason) => reason.startsWith('.env.shared')) &&
      /Use --force/.test(error.message),
  );
  assert.ok(fs.existsSync(feat));
  const cli = runCli(root, 'remove', 'feat');
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /notes\.txt: not part of a declared project/);
  assert.match(cli.stderr, /^ {2}projects\/api: uncommitted changes or untracked files\n {4}untracked: wip\.txt$/m);

  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  assert.strictEqual(fs.readFileSync(path.join(root, 'projects', 'api', '.env'), 'utf8'), 'SECRET=1\n');
  assert.strictEqual(fs.readFileSync(path.join(root, '.env.shared'), 'utf8'), 'SHARED=1\n');

  const clean = makeGroup(t);
  const cleanFeat = api.createWorkspace(clean, { name: 'feat' }).path;
  fs.writeFileSync(path.join(cleanFeat, 'tools', 'wip.txt'), 'x\n');
  assert.throws(() => api.removeWorkspace(clean, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /tools: uncommitted changes/.test(error.message));
  fs.rmSync(path.join(cleanFeat, 'tools', 'wip.txt'));
  const removed = runCli(clean, 'remove', 'feat');
  assert.strictEqual(removed.status, 0, removed.stderr);
  assert.strictEqual(fs.existsSync(cleanFeat), false);

  assert.throws(() => api.removeWorkspace(clean, 'main'), (error) => error.code === 'MAIN_WORKSPACE');
  assert.throws(() => api.removeWorkspace(clean, 'feat'), (error) => error.code === 'WORKSPACE_NOT_FOUND');
  for (const project of DEFAULT_PROJECTS) {
    assert.ok(fs.existsSync(path.join(member(clean, project), '.git')));
  }
});

test('an edited .workler copy inside a group workspace counts as local data', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const copy = path.join(feat, '.workler');
  const featInfo = () => api.listWorkspaces(root).find((workspace) => workspace.name === 'feat');
  assert.strictEqual(featInfo().clean, true);

  fs.appendFileSync(copy, 'copy .env.feat\n');
  assert.strictEqual(featInfo().clean, false);
  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) =>
      error.code === 'WORKSPACE_DIRTY' &&
      error.details.reasons.length === 1 &&
      /^\.workler: differs from the group's \.workler/.test(error.details.reasons[0]),
  );
  assert.ok(fs.existsSync(copy));
  const cli = runCli(root, 'remove', 'feat');
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /\.workler: differs from the group's \.workler/);

  fs.copyFileSync(path.join(root, '.workler'), copy);
  assert.strictEqual(featInfo().clean, true);
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat'), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);

  // Editing the group's own .workler after add makes the copy differ too.
  const again = api.createWorkspace(root, { name: 'feat' }).path;
  fs.appendFileSync(path.join(root, '.workler'), '# group note\n');
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /\.workler: differs/.test(error.message));
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: again });
  assert.strictEqual(fs.existsSync(again), false);
});

test('a .workler copy replaced by a symbolic link counts as local data, even when its target matches', (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const copy = path.join(feat, '.workler');
  const groupConfig = path.join(root, '.workler');
  const featInfo = () => api.listWorkspaces(root).find((workspace) => workspace.name === 'feat');
  assert.strictEqual(featInfo().clean, true);

  // Byte-identical through the link, but the link itself is the user's.
  fs.rmSync(copy);
  fs.symlinkSync(groupConfig, copy);
  assert.ok(fs.lstatSync(copy).isSymbolicLink());
  assert.strictEqual(featInfo().clean, false);
  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) =>
      error.code === 'WORKSPACE_DIRTY' &&
      error.details.reasons.length === 1 &&
      /^\.workler: a symbolic link, not the generated copy/.test(error.details.reasons[0]),
  );
  assert.ok(fs.lstatSync(copy).isSymbolicLink());
  const cli = runCli(root, 'remove', 'feat');
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /\.workler: a symbolic link, not the generated copy/);

  // --force deletes the link, never the group's file behind it.
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  assert.ok(fs.existsSync(groupConfig));
  assert.strictEqual(api.inspectProject(root).configError, undefined);
});

// --- branch-sync, fetch, sync --------------------------------------------

test('branch-sync works per member against its source repository, in its own ref namespace', (t) => {
  const root = makeGroup(t, { projects: ['projects/api', 'tools'] });
  const source = member(root, 'projects/api');
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const clone = member(feat, 'projects/api');
  const ns = api.groupRefNamespace(root);
  assert.match(ns, /^refs\/workler-group\/root-[0-9a-f]{12}$/);
  git(source, 'branch', 'from-root');
  git(clone, 'branch', 'from-feat');

  const first = runCli(root, 'branch-sync');
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /^workspace feat\/projects\/api$/m);
  assert.match(first.stdout, /^workspace feat\/tools$/m);
  assert.match(first.stdout, /from-root\s+created$/m);
  assert.ok(first.stdout.split('\n').includes(`  feat/projects/api  4 branches -> ${ns}/feat/`), first.stdout);
  assert.strictEqual(git(clone, 'rev-parse', 'refs/heads/from-root'), git(source, 'rev-parse', 'refs/heads/from-root'));
  assert.deepStrictEqual(refs(source, 'refs/workler-group/'), [
    `${ns}/feat/feat`,
    `${ns}/feat/from-feat`,
    `${ns}/feat/from-root`,
    `${ns}/feat/main`,
  ]);
  assert.deepStrictEqual(refs(source, 'refs/workler/'), []);

  // The source repository's own workspace "feat" uses refs/workler/feat/;
  // the two never prune each other.
  api.createWorkspace(source, { name: 'feat' });
  const own = runCli(source, 'branch-sync');
  assert.strictEqual(own.status, 0, own.stderr);
  assert.ok(refs(source, 'refs/workler/feat/').includes('refs/workler/feat/feat'));
  assert.strictEqual(refs(source, 'refs/workler-group/').length, 4);

  api.removeWorkspace(root, 'feat');
  const pruned = runCli(root, 'branch-sync');
  assert.strictEqual(pruned.status, 0, pruned.stderr);
  assert.match(pruned.stdout, /^no workspaces$/m);
  assert.ok(pruned.stdout.split('\n').includes(`  pruned ${ns}/feat/ (workspace removed)`), pruned.stdout);
  assert.deepStrictEqual(refs(source, 'refs/workler-group/'), []);
  assert.ok(refs(source, 'refs/workler/feat/').includes('refs/workler/feat/feat'));

  api.removeWorkspace(source, 'feat');
  assert.strictEqual(runCli(source, 'branch-sync').status, 0);
  assert.deepStrictEqual(refs(source, 'refs/workler/'), []);
});

test('a repository in two groups keeps one mirror namespace per group, so pruning in one never touches the other', (t) => {
  // outer/ declares services/api; outer/services/ is a group of its own that
  // declares api. The repository belongs to both.
  const outer = makeGroup(t, { projects: ['services/api', 'tools'] });
  const inner = path.join(outer, 'services');
  fs.writeFileSync(path.join(inner, '.workler'), 'project api\n');
  const source = member(outer, 'services/api');
  const outerNs = api.groupRefNamespace(outer);
  const innerNs = api.groupRefNamespace(inner);
  assert.notStrictEqual(outerNs, innerNs);
  assert.match(innerNs, /^refs\/workler-group\/services-[0-9a-f]{12}$/);

  api.createWorkspace(outer, { name: 'feat' });
  api.createWorkspace(inner, { name: 'other' });
  assert.strictEqual(runCli(outer, 'branch-sync').status, 0);
  assert.strictEqual(runCli(inner, 'branch-sync').status, 0);
  assert.ok(refs(source, `${outerNs}/`).includes(`${outerNs}/feat/feat`));
  assert.ok(refs(source, `${innerNs}/`).includes(`${innerNs}/other/other`));

  const again = runCli(outer, 'branch-sync');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /pruned/);
  assert.ok(refs(source, `${innerNs}/`).includes(`${innerNs}/other/other`));

  api.removeWorkspace(inner, 'other');
  const pruned = runCli(inner, 'branch-sync');
  assert.strictEqual(pruned.status, 0, pruned.stderr);
  assert.ok(pruned.stdout.split('\n').includes(`  pruned ${innerNs}/other/ (workspace removed)`), pruned.stdout);
  assert.deepStrictEqual(refs(source, `${innerNs}/`), []);
  assert.ok(refs(source, `${outerNs}/`).includes(`${outerNs}/feat/feat`));
});

test('fetch and sync cover every member of the group and of its workspaces', (t) => {
  const root = makeGroup(t, { projects: ['projects/api', 'tools'] });
  const source = member(root, 'projects/api');
  const origin = addOrigin(t, source);
  const feat = api.createWorkspace(root, { name: 'feat', checkout: 'main' }).path;

  const elsewhere = path.join(makeTempDir(t), 'elsewhere');
  git(path.dirname(elsewhere), 'clone', '-q', origin, elsewhere);
  git(elsewhere, 'config', 'user.email', 'test@example.invalid');
  git(elsewhere, 'config', 'user.name', 'workler tests');
  fs.writeFileSync(path.join(elsewhere, 'new.txt'), 'new\n');
  git(elsewhere, 'add', '-A');
  git(elsewhere, 'commit', '-qm', 'remote change');
  git(elsewhere, 'push', '-q', 'origin', 'main');

  const fetched = runCli(root, 'fetch');
  assert.strictEqual(fetched.status, 0, fetched.stderr);
  assert.match(fetched.stdout, /^main\/projects\/api\s+fetched origin$/m);
  assert.match(fetched.stdout, /^main\/tools\s+skipped \(no origin remote\)$/m);
  assert.match(fetched.stdout, /^feat\/projects\/api\s+fetched origin$/m);

  const synced = runCli(root, 'sync');
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /^ {2}main\/projects\/api\s+fast-forwarded main \(1 commit\)$/m);
  assert.match(synced.stdout, /^ {2}feat\/projects\/api\s+fast-forwarded main \(1 commit\)$/m);
  assert.match(synced.stdout, /^ {2}feat\/tools\s+skipped \(no upstream for main\)$/m);
  assert.ok(fs.existsSync(path.join(source, 'new.txt')));
  assert.ok(fs.existsSync(path.join(feat, 'projects', 'api', 'new.txt')));

  const status = runCli(root, 'status');
  assert.match(status.stdout, /^main\/projects\/api\s+main\s+up to date\s+clean\s+-$/m);
});

test('help describes project groups', () => {
  const help = runCli(process.cwd(), 'help');
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /project group/);
  assert.match(help.stdout, /path <name>\[\/<project>\]/);
});

test('group and member guard paths are output only once their commands made them', (t) => {
  const node = `"${process.execPath}"`;
  const stamp = (file) => `${node} -e "require('fs').writeFileSync('${file}', 'x')"`;
  const root = makeGroup(t, {
    projects: ['projects/api'],
    rules: { 'projects/api': `setup --if-missing stamp.txt ${stamp('stamp.txt')}\n` },
    groupRules: `setup --if-missing shared.txt ${stamp('shared.txt')}\n`,
  });
  const clean = (name) => api.listWorkspaces(root).find((entry) => entry.name === name).clean;

  // Set up by `add`: the member records its path in its git config, the
  // folder (no git config there) in a file next to the .workler copy.
  const feat = api.createWorkspace(root, { name: 'feat' });
  const apiClone = member(feat.path, 'projects/api');
  assert.ok(fs.existsSync(path.join(apiClone, 'stamp.txt')));
  assert.ok(fs.existsSync(path.join(feat.path, 'shared.txt')));
  assert.deepStrictEqual(recordedPaths([git(apiClone, 'config', '--get-all', 'workler.setupOutput')]), ['stamp.txt']);
  assert.deepStrictEqual(recordedPaths(JSON.parse(fs.readFileSync(path.join(feat.path, '.workler-setup.json'), 'utf8')).setupOutput), ['shared.txt']);
  assert.strictEqual(clean('feat'), true);
  // A user's file in place of a recorded entry is data at either level, until setup makes the path again.
  for (const file of [path.join(feat.path, 'shared.txt'), path.join(apiClone, 'stamp.txt')]) {
    fs.rmSync(file);
    fs.writeFileSync(file, 'mine\n');
    assert.strictEqual(clean('feat'), false, `a replaced ${path.basename(file)} is data`);
    fs.rmSync(file);
    const rerun = runCli(root, 'setup', 'feat');
    assert.strictEqual(rerun.status, 0, rerun.stderr);
    assert.strictEqual(clean('feat'), true);
  }
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(feat.path));

  // Made without setup: files at the same paths are the user's, at either level.
  const bare = api.createWorkspace(root, { name: 'bare', setup: false });
  assert.strictEqual(clean('bare'), true);
  fs.writeFileSync(path.join(bare.path, 'shared.txt'), 'mine\n');
  assert.strictEqual(clean('bare'), false);
  assert.throws(
    () => api.removeWorkspace(root, 'bare'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /shared\.txt: not part of a declared project/.test(error.message),
  );
  fs.rmSync(path.join(bare.path, 'shared.txt'));
  fs.writeFileSync(path.join(member(bare.path, 'projects/api'), 'stamp.txt'), 'mine\n');
  assert.strictEqual(clean('bare'), false);
  assert.throws(
    () => api.removeWorkspace(root, 'bare'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: uncommitted changes or untracked files/.test(error.message),
  );
  fs.rmSync(path.join(member(bare.path, 'projects/api'), 'stamp.txt'));

  // A later setup makes and records both; the record itself is Workler's only while it is a regular file.
  api.setupWorkspace(root, 'bare');
  assert.strictEqual(clean('bare'), true);
  fs.rmSync(path.join(bare.path, '.workler-setup.json'));
  fs.mkdirSync(path.join(bare.path, '.workler-setup.json'));
  assert.strictEqual(clean('bare'), false, 'no record: shared.txt is data again, and the folder at the record name too');
  assert.throws(
    () => api.removeWorkspace(root, 'bare'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /\.workler-setup\.json: not part of a declared project/.test(error.message) && /shared\.txt: not part/.test(error.message),
  );
  fs.rmdirSync(path.join(bare.path, '.workler-setup.json'));
  fs.rmSync(path.join(bare.path, 'shared.txt'));
  assert.strictEqual(clean('bare'), true);
  api.removeWorkspace(root, 'bare');

  // A record Workler did not write, malformed or merely spelled differently, is the
  // user's: setup leaves it alone, so the guard path it made stays data too.
  const other = api.createWorkspace(root, { name: 'other', setup: false });
  const record = path.join(other.path, '.workler-setup.json');
  const handMade = '{\n  "setupOutput": [\n    "shared.txt"\n  ],\n  "mine": true\n}\n';
  // The second-to-last is laid out as Workler writes it but names a path
  // without the identity of the entry it stands for.
  const noIdentity = '{\n  "setupOutput": [\n    "shared.txt"\n  ]\n}\n';
  for (const text of ['{not json', '{"setupOutput":["shared.txt"]}', noIdentity, handMade]) {
    fs.writeFileSync(record, text);
    assert.strictEqual(clean('other'), false, text);
    assert.throws(
      () => api.removeWorkspace(root, 'other'),
      (error) => error.code === 'WORKSPACE_DIRTY' && /\.workler-setup\.json: not part of a declared project/.test(error.message),
    );
  }
  api.setupWorkspace(root, 'other');
  assert.ok(fs.existsSync(path.join(other.path, 'shared.txt')));
  assert.strictEqual(fs.readFileSync(record, 'utf8'), handMade, 'the user\'s file is untouched');
  assert.throws(
    () => api.removeWorkspace(root, 'other'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /shared\.txt: not part/.test(error.message),
  );
  fs.rmSync(record);
  fs.rmSync(path.join(other.path, 'shared.txt'));

  // So is a dangling link at that name, which existsSync would call absent:
  // setup must not rename its record over it.
  fs.symlinkSync(path.join(other.path, 'does-not-exist.json'), record);
  api.setupWorkspace(root, 'other');
  assert.ok(fs.existsSync(path.join(other.path, 'shared.txt')));
  assert.ok(fs.lstatSync(record).isSymbolicLink(), 'the dangling link is untouched');
  assert.strictEqual(clean('other'), false);
  assert.throws(
    () => api.removeWorkspace(root, 'other'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /\.workler-setup\.json: not part of a declared project/.test(error.message) && /shared\.txt: not part/.test(error.message),
  );
  fs.unlinkSync(record);
  fs.rmSync(path.join(other.path, 'shared.txt'));
  api.setupWorkspace(root, 'other');
  assert.deepStrictEqual(recordedPaths(JSON.parse(fs.readFileSync(record, 'utf8')).setupOutput), ['shared.txt']);
  assert.strictEqual(clean('other'), true);
  api.removeWorkspace(root, 'other');
  assert.ok(!fs.existsSync(other.path));

  // The group's own rules may not manage the record, as with .workler.
  fs.writeFileSync(path.join(root, '.workler'), 'project projects/api\ncopy .workler-setup.json\n');
  assert.match(api.inspectProject(root).configError ?? '', /\.workler:2:\d+: a project group cannot manage \.workler-setup\.json/);
});

test('a group-level setup guard at .workler or .workler-setup.json is a configuration error', (t) => {
  // The command would create what `setup` renames its record over (or a
  // folder in its place), and the .workler copy is never missing.
  for (const guard of ['.workler-setup.json', '.workler-setup.json/stamp', './.WORKLER-SETUP.JSON', '".workler-setup.json"', '.workler']) {
    const root = makeGroup(t, { projects: ['a'], groupRules: `setup --if-missing ${guard} echo hi\n` });
    assert.match(
      api.inspectProject(root).configError ?? '',
      /\.workler:2:\d+: a project group cannot guard a setup command with \.workler(-setup\.json)?: Workler writes that file into group workspaces itself/,
      guard,
    );
    assert.throws(() => api.planWorkspaceCreation(root, { name: 'feat' }), (error) => error.code === 'CONFIG_INVALID' && /cannot guard a setup command/.test(error.message), guard);
    assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false, guard);
  }
  // A plain repository's record lives in git config, so the same guard is fine there.
  const repo = makeRepo(t, { workler: 'setup --if-missing .workler-setup.json echo hi\n' });
  assert.doesNotThrow(() => api.planWorkspaceCreation(repo, { name: 'feat' }));
});

test("a group-level setup guard must spell a project's path the way the project line does", (t) => {
  // Overlap is judged case-insensitively, so on a case-sensitive file system the command
  // would create `PROJECTS/API/generated` outside the member that exempts `api/generated`.
  for (const guard of ['PROJECTS/API/generated', 'projects/Api', 'PROJECTS', 'Projects/api/node_modules']) {
    const root = makeGroup(t, { projects: ['projects/api'], groupRules: `setup --if-missing ${guard} echo hi\n` });
    assert.match(
      api.inspectProject(root).configError ?? '',
      /\.workler:2:\d+: setup guard ".*" spells the project path "projects\/api" differently/,
      guard,
    );
    assert.throws(() => api.planWorkspaceCreation(root, { name: 'feat' }), (error) => error.code === 'CONFIG_INVALID' && /spells the project path/.test(error.message), guard);
    assert.strictEqual(fs.existsSync(workspaceDir(root, 'feat')), false, guard);
  }
  // The project line's spelling, or a path beside the project, is fine.
  for (const guard of ['projects/api/generated', 'projects/API-docs/out', 'shared.txt', 'projects/api']) {
    const root = makeGroup(t, { projects: ['projects/api'], groupRules: `setup --if-missing ${guard} echo hi\n` });
    assert.ok(!api.inspectProject(root).configError, `${guard}: ${api.inspectProject(root).configError}`);
  }
});

test("a group guard path inside a member is that member's output once the group's command made it", (t) => {
  const node = `"${process.execPath}"`;
  const make = `${node} -e "require('fs').mkdirSync('projects/api/generated'); require('fs').writeFileSync('projects/api/generated/out.txt', 'x')"`;
  const root = makeGroup(t, {
    projects: ['projects/api', 'projects/web'],
    groupRules: `setup --if-missing projects/api/generated ${make}\n`,
  });
  const listed = (name) => api.listWorkspaces(root).find((entry) => entry.name === name);

  // The group's record names the path from the folder; the member's own
  // cleanliness check sees it relative to the clone.
  const feat = api.createWorkspace(root, { name: 'feat' });
  const apiClone = member(feat.path, 'projects/api');
  assert.ok(fs.existsSync(path.join(apiClone, 'generated', 'out.txt')));
  assert.deepStrictEqual(recordedPaths(JSON.parse(fs.readFileSync(path.join(feat.path, '.workler-setup.json'), 'utf8')).setupOutput), ['projects/api/generated']);
  assert.strictEqual(git(apiClone, 'config', '--default', '', '--get', 'workler.setupOutput'), '', 'the member itself recorded nothing');
  assert.strictEqual(listed('feat').clean, true);
  assert.strictEqual(listed('feat').projects.find((project) => project.project === 'projects/api').clean, true);

  fs.writeFileSync(path.join(apiClone, 'mine.txt'), 'mine\n');
  assert.strictEqual(listed('feat').clean, false);
  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: uncommitted changes or untracked files/.test(error.message),
  );
  fs.rmSync(path.join(apiClone, 'mine.txt'));
  api.removeWorkspace(root, 'feat');
  assert.ok(!fs.existsSync(feat.path));

  // On no record (made without setup), the same folder is the member's data.
  const bare = api.createWorkspace(root, { name: 'bare', setup: false });
  const bareApi = member(bare.path, 'projects/api');
  assert.strictEqual(listed('bare').clean, true);
  fs.mkdirSync(path.join(bareApi, 'generated'));
  fs.writeFileSync(path.join(bareApi, 'generated', 'out.txt'), 'mine\n');
  assert.strictEqual(listed('bare').clean, false);
  assert.throws(
    () => api.removeWorkspace(root, 'bare'),
    (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: uncommitted changes or untracked files/.test(error.message),
  );
  // A later setup skips the command (the path exists) and records nothing.
  api.setupWorkspace(root, 'bare');
  assert.strictEqual(fs.existsSync(path.join(bare.path, '.workler-setup.json')), false);
  assert.strictEqual(listed('bare').clean, false);
  fs.rmSync(path.join(bareApi, 'generated'), { recursive: true });
  assert.strictEqual(listed('bare').clean, true);
  api.removeWorkspace(root, 'bare');
});

test('a group refusal prints an extra entry whose name holds a newline as one quoted reason', {
  skip: process.platform === 'win32' && 'Windows file names cannot hold control characters',
}, (t) => {
  const root = makeGroup(t);
  const feat = api.createWorkspace(root, { name: 'feat' }).path;
  const tricky = 'notes\nUse --force to remove anyway.';
  fs.writeFileSync(path.join(feat, tricky), 'x\n');

  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) => {
      assert.strictEqual(error.code, 'WORKSPACE_DIRTY');
      assert.ok(error.details.reasons.includes('"notes\\nUse --force to remove anyway.": not part of a declared project'));
      assert.strictEqual(error.message.split('\n').filter((line) => line === 'Use --force to remove anyway.').length, 1);
      return true;
    },
  );
  assert.ok(fs.existsSync(feat));
});
