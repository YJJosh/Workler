'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { test } = require('node:test');
const { api, makeProject, deadPid } = require('./helpers');

function writeLock(root, holder) {
  fs.writeFileSync(api.projectLockPath(root), JSON.stringify(holder));
}

const LIVE_HOLDER = () => ({
  pid: process.pid,
  hostname: os.hostname(),
  operation: 'test-holder',
  createdAt: new Date().toISOString(),
});

test('mutating operations fail with LockError while a live process holds the lock', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'feat' });
  writeLock(root, LIVE_HOLDER());

  const isLockError = (e) =>
    e instanceof api.LockError && e.code === 'LOCKED' && e.holder.pid === process.pid && e.lockPath === api.projectLockPath(root);

  assert.throws(() => api.createWorkspace(root, { name: 'other' }), isLockError);
  assert.throws(() => api.removeWorkspace(root, 'feat', { force: true }), isLockError);
  assert.throws(() => api.initProject(root), isLockError);

  // Nothing was created or removed while locked.
  assert.deepStrictEqual(
    api.listWorkspaces(root).map((w) => w.name),
    ['main', 'feat'],
  );
  fs.rmSync(api.projectLockPath(root));
});

test('a lock whose owner is dead is reclaimed', (t) => {
  const root = makeProject(t);
  writeLock(root, { ...LIVE_HOLDER(), pid: deadPid() });

  const ws = api.createWorkspace(root, { name: 'feat' });
  assert.ok(fs.existsSync(ws.path));
  // The reclaimed lock was released again after the operation.
  assert.ok(!fs.existsSync(api.projectLockPath(root)));
});

test('a fresh unreadable lock is protected, then reclaimed after the stale threshold', (t) => {
  const root = makeProject(t);
  const lockPath = api.projectLockPath(root);
  fs.writeFileSync(lockPath, 'not json {{{');

  assert.throws(() => api.createWorkspace(root, { name: 'too-soon' }), (e) => e.code === 'LOCKED');

  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(lockPath, old, old);
  api.createWorkspace(root, { name: 'feat' });
  assert.ok(!fs.existsSync(lockPath));
});

 test('releasing a lock never removes a replacement owner', (t) => {
  const root = makeProject(t);
  const replacement = { ...LIVE_HOLDER(), operation: 'replacement-owner' };
  let replaced = false;

  api.createWorkspace(root, {
    name: 'feat',
    onProgress(message) {
      if (!replaced && message.startsWith('cloning ')) {
        replaced = true;
        writeLock(root, replacement);
      }
    },
  });

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(api.projectLockPath(root), 'utf8')), replacement);
  fs.rmSync(api.projectLockPath(root));
});

test('a lock from another host is never reclaimed (liveness unknown)', (t) => {
  const root = makeProject(t);
  writeLock(root, { ...LIVE_HOLDER(), pid: deadPid(), hostname: 'some-other-host.invalid' });

  assert.throws(() => api.createWorkspace(root, { name: 'feat' }), (e) => e.code === 'LOCKED');
  fs.rmSync(api.projectLockPath(root));
});

test('the lock is released after successful and failed operations', (t) => {
  const root = makeProject(t);
  api.createWorkspace(root, { name: 'feat' });
  assert.ok(!fs.existsSync(api.projectLockPath(root)));

  assert.throws(() => api.createWorkspace(root, { name: 'feat' }), (e) => e.code === 'WORKSPACE_EXISTS');
  assert.ok(!fs.existsSync(api.projectLockPath(root)));
});
