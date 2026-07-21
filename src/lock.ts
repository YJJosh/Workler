import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACES_DIR } from './constants';
import { LockError } from './errors';
import type { LockHolder } from './errors';
import { assertSafeWorkspacesDirectory } from './workspaces';

// Per-project mutual exclusion for mutating API and CLI operations.
// The lock is a JSON file created with O_EXCL inside <root>/.worktrees/;
// listWorkspaces only looks at directories there, so the file never shows up
// as a (broken) workspace. Locking is per project root, which is exactly the
// scope a mutation touches: nested projects lock their own .worktrees.

const LOCK_FILE_NAME = '.workler.lock';
// A newly-created lock can briefly be empty or partial while its owner writes
// the JSON payload. Never reclaim malformed content until it has remained
// unchanged for long enough to rule out that creation window.
const MALFORMED_LOCK_STALE_MS = 30_000;

export function projectLockPath(root: string): string {
  return path.join(root, WORKSPACES_DIR, LOCK_FILE_NAME);
}

export interface ProjectLock {
  path: string;
  release(): void;
}

function readLockHolder(lockPath: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (typeof parsed?.pid === 'number' && typeof parsed?.hostname === 'string') {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        operation: typeof parsed.operation === 'string' ? parsed.operation : 'unknown',
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : 'unknown',
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
      };
    }
  } catch (_) {
    // Unreadable or torn lock file: treated as stale below.
  }
  return undefined;
}

// A lock is stale when its owner can be proven dead. A malformed lock may be
// a process that has created the file but not finished writing it, so reclaim
// it only after a conservative age threshold. A lock from another host cannot
// be liveness-checked, so it is NOT stale.
function isStale(lockPath: string, holder: LockHolder | undefined): boolean {
  if (!holder) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs >= MALFORMED_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (holder.hostname !== os.hostname()) {
    return false;
  }
  try {
    // Signal 0 probes for existence without sending anything.
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process. EPERM: exists but owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function acquireProjectLock(root: string, operation: string): ProjectLock {
  const lockPath = projectLockPath(root);
  // init acquires the lock before it creates .worktrees/, so make sure the
  // directory exists (init creates it anyway; for add/remove it must exist).
  // Check both sides of mkdir: a pre-existing symlink/junction must never be
  // followed, and the second check narrows the race where one is substituted
  // while the directory is being created.
  assertSafeWorkspacesDirectory(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  assertSafeWorkspacesDirectory(root);

  const holder: LockHolder = {
    pid: process.pid,
    hostname: os.hostname(),
    operation,
    createdAt: new Date().toISOString(),
    token: randomUUID(),
  };

  // Two attempts: the first EEXIST may be a stale lock left by a dead
  // process; after reclaiming it, a second EEXIST means a live process won
  // the re-acquire race and the contention is real.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(holder, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        release() {
          // Never unlink a lock that another process acquired after ours was
          // externally removed or reclaimed. Ownership is token-based rather
          // than PID-based so nested processes sharing a PID namespace cannot
          // be confused.
          const current = readLockHolder(lockPath);
          if (current?.token === holder.token) {
            fs.rmSync(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = readLockHolder(lockPath);
      if (attempt === 0 && isStale(lockPath, existing)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      throw new LockError(lockPath, existing);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new LockError(lockPath, readLockHolder(lockPath));
}

export function withProjectLock<T>(root: string, operation: string, fn: () => T): T {
  const lock = acquireProjectLock(root, operation);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
