import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACES_DIR } from './constants';
import { LockError } from './errors';
import type { LockHolder } from './errors';
import { assertSafeWorkspacesDirectory } from './workspaces';

// A JSON file created with O_EXCL in <root>/.worktrees/. listWorkspaces only
// reads directories, so it never shows up as a workspace.

const LOCK_FILE_NAME = '.workler.lock';
// A new lock is briefly empty or partial while its owner writes it, so
// malformed content is reclaimed only after this age.
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

// Stale only when the owner is provably dead. Another host's lock cannot be
// checked, so it is never stale.
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
  // init locks before .worktrees/ exists. Reject existing symlinks or junctions
  // before mkdir; checking again afterwards narrows the substitution race.
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

  // After reclaiming a stale lock, a second EEXIST means a live process won.
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
          // Never unlink a lock another process took after ours was removed.
          // A token, not the PID, since PIDs repeat across PID namespaces.
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

/** Takes the locks outermost first and releases them in reverse order. */
export function withProjectLocks<T>(roots: readonly string[], operation: string, fn: () => T): T {
  const first = roots[0];
  if (first === undefined) {
    return fn();
  }
  return withProjectLock(first, operation, () => withProjectLocks(roots.slice(1), operation, fn));
}
