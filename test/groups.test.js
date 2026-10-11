'use strict';
// Project groups: a plain folder whose .workler lists several repositories
// with `project <path>` lines. `add` there clones every one of them into
// .worktrees/<name>/<path>; each clone is an ordinary workspace of its
// source repository.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { addOrigin, api, git, makeRepo, makeTempDir, remotes, runCli } = require('./helpers');

// A repo on branch `main` with one commit at an explicit location (the
// shared makeRepo picks its own temp dir).
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

// A project group: a plain folder with repositories at the given relative
// paths and (unless declare is false) a .workler that lists them, followed by
// optional group-level rules. `rules` maps a project path to its own .workler.
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

  // The members are ordinary projects and know nothing about the group.
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

  // Quoted paths and comments work exactly like for rules.
  fs.writeFileSync(config, '# group\nproject "projects/api"  # the api\n');
  assert.deepStrictEqual(api.inspectProject(root).projects, ['projects/api']);
});

test('a Git repository cannot declare projects', (t) => {
  const repo = makeRepo(t, { workler: 'project sub\n' });
  makeRepoAt(path.join(repo, 'sub'));

  // Never a group, and add refuses rather than ignoring the line.
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

  // The same refusal `add` gives inside tools, named after the member.
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
  // It is the group's own .gitignore that hides the clone and the group-level
  // copy from the outer repository.
  assert.match(git(outer, 'check-ignore', '-v', 'services/.worktrees/feat/.env.shared'), /services\/\.gitignore:1:\.worktrees\//);

  // Idempotent, and a nested group workspace gets no .gitignore of its own: it
  // already lives under a .worktrees/ that the group ignores.
  api.createWorkspace(group, { name: 'feat2' });
  assert.strictEqual(fs.readFileSync(path.join(group, '.gitignore'), 'utf8'), '.worktrees/\n');
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
  // Only groups are concerned: Workler never pre-writes a plain repository's
  // .workler into its workspaces, so the same line still parses there.
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
  // Above the group it is still the outer repository.
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

  // A second init leaves the file alone and reports what it declares.
  const again = api.initProject(root);
  assert.strictEqual(again.configCreated, false);
  assert.deepStrictEqual(again.projects, DEFAULT_PROJECTS);

  // Repositories in the group do not get a .workler written for them.
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

  // A repository added later is pointed out, never silently included. The
  // suggested lines are quoted the way the file needs, so they paste as they
  // are (bare, `has # hash` would declare `has` and start a comment).
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

  // A plain subfolder of a repository is still the repository.
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

// --- add -----------------------------------------------------------------

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

  // The workspace describes itself (so it can host nested workspaces) and
  // carries the group's own rules next to the clones.
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
    // An ordinary workspace of its source repository that also knows its group.
    assert.strictEqual(git(clone, 'config', '--get', 'workler.root'), source);
    assert.strictEqual(git(clone, 'config', '--get', 'workler.name'), 'feat');
    assert.strictEqual(git(clone, 'config', '--get', 'workler.group'), root);
    assert.strictEqual(git(clone, 'config', '--get', 'workler.groupProject'), entry.project);
    assert.strictEqual(remotes(clone)['workler-root'], source);
    assert.strictEqual(fs.existsSync(path.join(clone, '.worktrees')), false);
  }

  // Each member's own rules apply inside its clone, with link targets in
  // its source repository.
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

  // [base] --branch: a new branch from a ref every member has.
  const based = api.createWorkspace(root, { name: 'based', base: 'main', branch: 'feature/x' });
  assert.strictEqual(based.branch, 'feature/x');

  // --checkout <tag>: detached everywhere, so the group is detached.
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

  // The same checks run for the plan (add --dry-run).
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

  // list/status flag the source, they do not hide it.
  const [main] = api.listWorkspaces(root);
  assert.strictEqual(main.projects.find((project) => project.project === 'tools').broken, 'not a Git repository top level');
  assert.match(main.broken, /tools: not a Git repository top level/);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^main\/tools\s+-\s+-\s+broken: not a Git repository top level$/m);

  fs.rmSync(path.join(root, 'projects', 'api'), { recursive: true });
  assert.match(runCli(root, 'status').stdout, /^main\/projects\/api\s+-\s+-\s+broken: missing$/m);
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

// --- list, status, path --------------------------------------------------

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
    assert.match(status.stdout, new RegExp(`^${name.replace(/\//g, '\\/')}\\s+(main|feat)\\s+no upstream\\s+clean$`, 'm'));
  }

  // Members on different branches: mixed. A member that is dirty: the
  // workspace is dirty.
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
  assert.match(runCli(root, 'status').stdout, /^feat\/projects\/web\s+-\s+-\s+broken: missing \(not cloned\)$/m);

  // A member directory that is not a clone, and a stray directory under
  // .worktrees/, are flagged too.
  fs.mkdirSync(member(feat, 'projects/web'));
  fs.writeFileSync(path.join(member(feat, 'projects/web'), 'x.txt'), 'x\n');
  fs.mkdirSync(path.join(root, '.worktrees', 'junk'));
  fs.writeFileSync(path.join(root, '.worktrees', 'junk', 'x.txt'), 'x\n');
  const status = runCli(root, 'status');
  assert.match(status.stdout, /^feat\/projects\/web\s+-\s+-\s+broken: missing .git \(not a clone\)$/m);
  assert.match(status.stdout, /^junk\s+-\s+-\s+broken: not a group workspace/m);
  assert.doesNotMatch(runCli(root, 'list').stdout, /^junk/m);
  assert.deepStrictEqual(api.listWorkspaces(root).map((info) => [info.name, info.isClone]), [['main', true], ['feat', true], ['junk', false]]);

  // The not-a-clone member holds unknown data: remove needs --force. The
  // never-cloned member alone would not.
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

  // A dangling link first, then a link straight at the source repository:
  // neither is a clone, and neither may be followed or quietly deleted.
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
    assert.match(runCli(root, 'status').stdout, /^feat\/projects\/api\s+-\s+-\s+broken: a symbolic link, not a clone$/m);
    assert.throws(() => api.removeWorkspace(root, 'feat'), (error) => error.code === 'WORKSPACE_DIRTY' && /projects\/api: a symbolic link, not a clone/.test(error.message));
    assert.strictEqual(fs.existsSync(feat), true);
  }

  // apply skips the link instead of following it into the source repository.
  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(a symbolic link, not a clone\)$/m);
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /projects\/api in workspace feat is a symbolic link, not a clone/);

  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  // Only the link went: the source repository it pointed at is untouched.
  assert.strictEqual(fs.lstatSync(path.join(source, '.git')).isDirectory(), true);
  assert.ok(fs.readdirSync(source).length > 1);
});

test('a source repository behind a symbolic link is refused: nothing reaches what the link points at', (t) => {
  const dirLinkType = process.platform === 'win32' ? 'junction' : undefined;
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const namespace = api.groupRefNamespace(root);

  // Move the real `projects` folder out of the group and leave a link behind:
  // `projects/api` now resolves to a repository outside the group.
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
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^main\/projects\/api\s+-\s+-\s+broken: behind a symbolic link at projects, not a repository$/m);

  // sync and branch-sync skip the source and every member that depends on
  // it: the repository behind the link is neither fast-forwarded nor given
  // any mirror refs. The real source (tools) is handled as usual.
  const synced = runCli(root, 'sync');
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /main\/projects\/api\s+skipped \(broken: behind a symbolic link at projects, not a repository\)/);
  const branchSync = runCli(root, 'branch-sync');
  assert.strictEqual(branchSync.status, 0, branchSync.stderr);
  assert.match(branchSync.stdout, /^  skipped \(source main\/projects\/api is broken: behind a symbolic link at projects, not a repository\)$/m);
  assert.deepStrictEqual(refs(externalApi, namespace), []);
  assert.ok(refs(path.join(root, 'tools'), namespace).includes(`${namespace}/feat/feat`));

  // apply skips the member whose source is behind the link, and refuses it
  // when addressed directly.
  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(source main\/projects\/api is behind a symbolic link at projects, not a repository\)$/m);
  assert.match(applied.stdout, /^project tools$/m);
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /source main\/projects\/api is behind a symbolic link at projects, not a repository/);

  // add refuses before anything is cloned.
  assert.throws(
    () => api.createWorkspace(root, { name: 'other' }),
    (error) => error.code === 'NOT_A_GIT_REPO' && error.details.project === 'projects/api'
      && /behind a symbolic link at projects, not a repository/.test(error.message),
  );
  assert.strictEqual(fs.existsSync(workspaceDir(root, 'other')), false);

  assert.deepStrictEqual(snapshot(), externalBefore);
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
  const before = { api: fs.readdirSync(sourceApi).sort(), web: fs.readdirSync(sourceWeb).sort() };

  // Swap the workspace's `projects` folder for a link to the group's own
  // `projects` folder: the source repositories now sit exactly where the
  // members projects/api and projects/web are expected, behind the link.
  fs.rmSync(path.join(feat, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(root, 'projects'), path.join(feat, 'projects'), dirLinkType);

  const workspace = api.listWorkspaces(root)[1];
  assert.strictEqual(workspace.name, 'feat');
  assert.match(workspace.broken, /projects\/api: behind a symbolic link at projects, not a clone/);
  assert.match(workspace.broken, /projects\/web: behind a symbolic link at projects, not a clone/);
  assert.strictEqual(workspace.clean, undefined);
  const status = runCli(root, 'status');
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^feat\/projects\/api\s+-\s+-\s+broken: behind a symbolic link at projects, not a clone$/m);
  assert.match(status.stdout, /^feat\/projects\/web\s+-\s+-\s+broken: behind a symbolic link at projects, not a clone$/m);
  assert.match(status.stdout, /^feat\/tools\s+feat\s/m);

  // apply skips both members; the one real clone (tools) is still applied.
  const applied = runCli(root, 'apply', 'feat');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /^project projects\/api: skipped \(behind a symbolic link at projects, not a clone\)$/m);
  assert.match(applied.stdout, /^project projects\/web: skipped \(behind a symbolic link at projects, not a clone\)$/m);
  assert.match(applied.stdout, /^project tools$/m);
  const one = runCli(root, 'apply', 'feat/projects/web');
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /projects\/web in workspace feat is behind a symbolic link at projects, not a clone/);

  // branch-sync mirrors the real clone only: nothing is written into the
  // source repositories behind the link, not even their own branches.
  const namespace = api.groupRefNamespace(root);
  runCli(root, 'branch-sync');
  const mirrored = refs(sourceTools, namespace).split('\n');
  assert.ok(mirrored.includes(`${namespace}/feat/feat`), mirrored.join(', '));
  assert.ok(mirrored.every((ref) => ref.startsWith(`${namespace}/feat/`)), mirrored.join(', '));
  assert.strictEqual(refs(sourceApi, 'refs/workler-group'), '');
  assert.strictEqual(refs(sourceWeb, 'refs/workler-group'), '');

  // remove names the link once per member behind it (not as a stray entry
  // on top), and --force deletes the link itself only.
  assert.throws(() => api.removeWorkspace(root, 'feat'), (error) =>
    error.code === 'WORKSPACE_DIRTY'
    && /projects\/api: behind a symbolic link at projects, not a clone/.test(error.message)
    && /projects\/web: behind a symbolic link at projects, not a clone/.test(error.message)
    && !/not part of a declared project/.test(error.message));
  assert.strictEqual(fs.existsSync(feat), true);
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  // branch-sync at the group root locks each usable source, which leaves the
  // empty lock directory behind; nothing else in the sources may have changed.
  const withoutLockDir = (dir) => fs.readdirSync(dir).filter((entry) => entry !== '.worktrees').sort();
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
  // What createWorkspace leaves behind when the very first member clone
  // fails: the workspace directory with the copied .workler and no clone.
  const feat = workspaceDir(root, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  fs.copyFileSync(path.join(root, '.workler'), path.join(feat, '.workler'));

  const workspace = api.listWorkspaces(root)[1];
  assert.strictEqual(workspace.name, 'feat');
  assert.strictEqual(workspace.isClone, true);
  assert.strictEqual(workspace.broken, 'projects/api: missing (not cloned); projects/web: missing (not cloned); tools: missing (not cloned)');
  assert.deepStrictEqual(workspace.projects.map((project) => project.isClone), [false, false, false]);
  assert.match(runCli(root, 'list').stdout, /^feat\s+incomplete\s+/m);

  // Nothing was cloned, so nothing can be dirty: remove cleans it up.
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
  // Link targets point at the immediate parent, the member clone.
  const link = path.join(sub.path, 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(path.resolve(path.dirname(link), fs.readlinkSync(link)), path.join(clone, 'node_modules'));

  assert.deepStrictEqual(api.listWorkspaces(clone).map((item) => item.name), ['main', 'sub']);
  assert.deepStrictEqual(api.listWorkspaces(root).map((item) => item.name), ['main', 'feat']);
  // The nested .worktrees/ inside the member makes the group workspace
  // dirty for remove, exactly like a nested workspace does for a clone.
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

  // Listings stay scoped to their own level.
  assert.deepStrictEqual(api.listWorkspaces(root).map((item) => item.name), ['main', 'feat']);
  assert.deepStrictEqual(api.listWorkspaces(feat).map((item) => item.name), ['main', 'feat2']);
  assert.strictEqual(api.resolveWorkspacePath(feat, 'feat2/tools'), member(nested.path, 'tools'));

  // The nested workspace is data the outer remove would destroy.
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

  // One member only.
  wipe();
  const one = runCli(root, 'apply', 'feat/projects/api');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.doesNotMatch(one.stdout, /group rules/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.existsSync(shared), false);

  // Bare apply inside a member refreshes it from its source repository.
  wipe();
  const inMember = runCli(path.join(feat, 'projects', 'api'), 'apply');
  assert.strictEqual(inMember.status, 0, inMember.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.existsSync(shared), false);

  // Bare apply inside the workspace folder refreshes all of it.
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

  // A member that was never cloned is skipped, not created.
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

  // One member goes back to symlinks: only its own mode changes.
  const one = runCli(root, 'apply', 'feat/projects/api', '--no-copy-links', '--force');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.ok(fs.lstatSync(memberCopy).isSymbolicLink());
  assert.throws(() => git(clone, 'config', '--get', 'workler.copyLinks'));
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');

  // A plain apply of the whole workspace still knows the group's destination
  // is a copy, instead of reporting it as a conflict with the link rule.
  const whole = runCli(root, 'apply', 'feat');
  assert.strictEqual(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /^ok {5}link shared \(destination matches source\)$/m);
  assert.ok(fs.lstatSync(groupCopy).isDirectory());

  // The group's own mode is switched at the group level, and that sticks.
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
  // A dry run never records anything.
  const dry = runCli(root, 'apply', 'feat', '--no-copy-links', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.strictEqual(git(clone, 'config', '--get', 'workler.groupCopyLinks'), 'true');

  // A group rule added later follows the recorded choice on a plain apply.
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

  // The group's lock blocks it: `remove feat` and `apply feat/projects/api`
  // take the same one, so none of them can race this apply.
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

  // The source repository's own lock does not: its workspaces are untouched.
  release = hold(member(root, 'projects/api'));
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

  // `remove feat` at the group root holds only the group's lock while it
  // deletes the member clones. A command that creates or removes inside the
  // clone must be blocked by that same lock, or `remove feat` could pass its
  // cleanliness check and then delete the workspace `add` is still cloning.
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

  // The clone's own lock still guards its .worktrees/, like any project's.
  release = hold(clone);
  try {
    assert.throws(() => api.createWorkspace(clone, { name: 'nested2' }), { code: 'LOCKED' });
    assert.throws(() => api.removeWorkspace(clone, 'nested', { force: true }), { code: 'LOCKED' });
  } finally {
    release();
  }

  // Unlocked, both run, and the group lock they took is released again.
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

  // `remove feat` at the outer root holds only the root's lock while it
  // deletes feat. A nested `add` run inside feat must be blocked by that same
  // lock, or remove could pass its check and then delete the clones being made.
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

  // The nested group's own lock still guards its .worktrees/.
  release = hold(feat);
  try {
    assert.throws(() => api.createWorkspace(feat, { name: 'feat2' }), { code: 'LOCKED' });
  } finally {
    release();
  }

  // The chain continues upwards: two levels down, the root's lock still applies.
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

  // Unlocked, it runs and releases every lock it took on the way.
  api.createWorkspace(feat2, { name: 'feat3' });
  for (const dir of [root, feat, feat2]) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.worktrees', '.workler.lock')), false, dir);
  }
});

test('fetch, sync and branch-sync at a group root also hold every usable source repository lock', (t) => {
  const root = makeGroup(t);
  api.createWorkspace(root, { name: 'feat' });
  const source = member(root, 'projects/api');
  // A declared source that does not exist is skipped by these commands, so it
  // must not be locked either: that would create .worktrees/ where Workler
  // has no business writing.
  fs.appendFileSync(path.join(root, '.workler'), 'project projects/missing\n');
  const hold = (dir) => {
    const lock = path.join(dir, '.worktrees', '.workler.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'test', createdAt: new Date().toISOString() }));
    return () => fs.rmSync(lock, { force: true });
  };

  // A `sync` run inside one source holds that source's lock. The group's
  // commands fetch into and fast-forward the very same checkout, so they must
  // be blocked by it rather than interleave with it.
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

  // Unlocked, the group command takes (and releases) each usable source's
  // lock and leaves the missing one alone.
  for (const dir of ['projects/web', 'tools']) {
    assert.strictEqual(fs.existsSync(path.join(member(root, dir), '.worktrees')), false, `${dir} had no .worktrees before`);
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
  // What createWorkspace leaves behind when the very first member clone fails.
  const feat = workspaceDir(root, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  fs.copyFileSync(path.join(root, '.workler'), path.join(feat, '.workler'));

  // The group's copy-links mode is recorded in the member clones. With none,
  // a copy made now could not be remembered, and the next plain apply would
  // expect a link and report a conflict. So nothing is materialized at all.
  const explicit = runCli(root, 'apply', 'feat', '--copy-links');
  assert.strictEqual(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /group rules: skipped \(workspace feat has no member clone; remove it and run add again\)/);
  assert.strictEqual(fs.existsSync(path.join(feat, 'shared')), false);

  const plain = runCli(root, 'apply', 'feat');
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /group rules: skipped/);
  assert.doesNotMatch(plain.stdout + plain.stderr, /conflict/i);
  assert.strictEqual(fs.existsSync(path.join(feat, 'shared')), false);

  // `apply --all` skips it the same way and still exits 0.
  const all = runCli(root, 'apply', '--all');
  assert.strictEqual(all.status, 0, all.stderr);
  assert.match(all.stdout, /group rules: skipped/);
});

test('remove needs every member clean and nothing but members in the workspace folder', (t) => {
  const root = makeGroup(t, { rules: { 'projects/api': 'copy .env\n' }, groupRules: 'copy .env.shared\n' });
  const feat = api.createWorkspace(root, { name: 'feat' }).path;

  assert.throws(
    () => api.removeWorkspace(root, 'feat'),
    (error) =>
      error.code === 'WORKSPACE_DIRTY' &&
      error.details.reasons.includes('projects/api: uncommitted changes or untracked files') &&
      error.details.reasons.includes('.env.shared: not part of a declared project') &&
      /Use --force/.test(error.message),
  );
  assert.ok(fs.existsSync(feat));
  const cli = runCli(root, 'remove', 'feat');
  assert.strictEqual(cli.status, 1);
  assert.match(cli.stderr, /\.env\.shared: not part of a declared project/);

  assert.deepStrictEqual(api.removeWorkspace(root, 'feat', { force: true }), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);
  // The sources are untouched.
  assert.strictEqual(fs.readFileSync(path.join(root, 'projects', 'api', '.env'), 'utf8'), 'SECRET=1\n');
  assert.strictEqual(fs.readFileSync(path.join(root, '.env.shared'), 'utf8'), 'SHARED=1\n');

  // Without rules the workspace is removable as soon as it is clean.
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

  // Configure this workspace for its own nested group workspaces.
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

  // Restoring the generated copy makes the workspace removable again.
  fs.copyFileSync(path.join(root, '.workler'), copy);
  assert.strictEqual(featInfo().clean, true);
  assert.deepStrictEqual(api.removeWorkspace(root, 'feat'), { name: 'feat', path: feat });
  assert.strictEqual(fs.existsSync(feat), false);

  // A group whose own .workler changed after the workspace was created is
  // reported the same way, and --force still removes it.
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

  // The outer group knows nothing about "other", but that workspace lives in
  // the inner group's namespace and survives the outer group's pruning.
  const again = runCli(outer, 'branch-sync');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /pruned/);
  assert.ok(refs(source, `${innerNs}/`).includes(`${innerNs}/other/other`));

  // Removing the inner workspace prunes the inner namespace only.
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

  // A commit that reaches origin from elsewhere: sync fast-forwards every
  // clean repository on main that tracks it.
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
  assert.match(status.stdout, /^main\/projects\/api\s+main\s+up to date\s+clean$/m);
});

test('help describes project groups', () => {
  const help = runCli(process.cwd(), 'help');
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /project group/);
  assert.match(help.stdout, /path <name>\[\/<project>\]/);
});
