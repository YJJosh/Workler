'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { api, git, makeRepo, makeTempDir } = require('./helpers');

test('an unmarked clone under .worktrees resolves to its plain Git parent and ignores global markers', (t) => {
  const root = makeRepo(t, { includeWorkler: false });
  const partial = path.join(root, '.worktrees', 'partial');
  fs.mkdirSync(path.dirname(partial));
  git(root, 'clone', '-q', '--local', root, partial);

  const globalConfig = path.join(makeTempDir(t), 'global.gitconfig');
  git(root, 'config', '--file', globalConfig, 'workler.name', 'global-marker-must-not-count');
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    assert.strictEqual(api.inspectProject(root).marked, false);
    assert.strictEqual(api.findWorklerRoot(partial), root);
    assert.deepStrictEqual(api.listWorkspaces(root).map((workspace) => workspace.name), ['main', 'partial']);
  } finally {
    if (previousGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
  }
});

test('a linked git worktree under .worktrees remains a separate project', (t) => {
  const root = makeRepo(t, { includeWorkler: false });
  git(root, 'branch', 'linked');
  const linked = path.join(root, '.worktrees', 'linked');
  git(root, 'worktree', 'add', '-q', linked, 'linked');

  assert.ok(fs.lstatSync(path.join(linked, '.git')).isFile());
  assert.strictEqual(api.findWorklerRoot(linked), linked);
  assert.deepStrictEqual(api.listWorkspaces(root).map((workspace) => workspace.name), ['main']);
  assert.throws(() => api.removeWorkspace(root, 'linked'), (error) => error.code === 'WORKSPACE_NOT_FOUND');
});

test('a managed workspace without .workler resolves to itself', (t) => {
  const root = makeRepo(t, { includeWorkler: false });
  const workspace = api.createWorkspace(root, { name: 'feature' });
  const child = path.join(workspace.path, 'src');
  fs.mkdirSync(child);

  assert.strictEqual(api.findWorklerRoot(child), workspace.path);
  assert.strictEqual(api.inspectProject(workspace.path).parent, root);
});

test('workspaces nest: each project manages its own .worktrees', (t) => {
  // .workler is COMMITTED so nested workspaces inherit the rules from the
  // checkout, exactly as the docs describe.
  const root = makeRepo(t, { workler: 'link node_modules\n' });
  api.initProject(root);

  const featureA = api.createWorkspace(root, { name: 'feature-a' });
  assert.strictEqual(featureA.path, path.join(root, '.worktrees', 'feature-a'));

  // The workspace is itself a project (marked by add), no init needed.
  assert.strictEqual(api.inspectProject(featureA.path).initialized, true);
  assert.strictEqual(api.inspectProject(featureA.path).parent, root);

  const agent1 = api.createWorkspace(featureA.path, { name: 'agent-1' });
  assert.strictEqual(agent1.path, path.join(featureA.path, '.worktrees', 'agent-1'));
  assert.strictEqual(git(agent1.path, 'config', '--get', 'workler.root'), featureA.path);

  // Listings stay scoped to their own level.
  assert.deepStrictEqual(api.listWorkspaces(root).map((w) => w.name), ['main', 'feature-a']);
  assert.deepStrictEqual(api.listWorkspaces(featureA.path).map((w) => w.name), ['main', 'agent-1']);
  assert.strictEqual(api.resolveWorkspacePath(featureA.path, 'agent-1'), agent1.path);
  assert.strictEqual(api.resolveWorkspacePath(featureA.path, 'main'), featureA.path);

  // Link targets resolve to the IMMEDIATE parent: agent-1/node_modules points
  // at feature-a/node_modules (itself a link back to the root).
  const nestedLink = path.join(agent1.path, 'node_modules');
  assert.ok(fs.lstatSync(nestedLink).isSymbolicLink());
  const directTarget = path.resolve(path.dirname(nestedLink), fs.readlinkSync(nestedLink));
  assert.strictEqual(directTarget, path.join(featureA.path, 'node_modules'));
  assert.strictEqual(fs.realpathSync(nestedLink), fs.realpathSync(path.join(root, 'node_modules')));

  // Nested removal only touches the nested level.
  api.removeWorkspace(featureA.path, 'agent-1', { force: true });
  assert.deepStrictEqual(api.listWorkspaces(root).map((w) => w.name), ['main', 'feature-a']);
});
