// Structured errors for the programmatic API. The CLI prints `error.message`
// unchanged, so messages here must stay identical to what the commands
// printed before the API existed; `code` (and `details`) are the contract
// programmatic callers should branch on.

export type WorklerErrorCode =
  | 'ROOT_NOT_FOUND'
  | 'NOT_INITIALIZED'
  | 'NOT_A_GIT_REPO'
  | 'INVALID_NAME'
  | 'INVALID_OPTIONS'
  | 'WORKSPACE_EXISTS'
  | 'WORKSPACE_NOT_FOUND'
  | 'MAIN_WORKSPACE'
  | 'WORKSPACE_DIRTY'
  | 'BRANCH_EXISTS'
  | 'BAD_REF'
  | 'CONFIG_INVALID'
  | 'RULE_CONFLICT'
  | 'SETUP_FAILED'
  | 'LOCKED';

export class WorklerError extends Error {
  readonly code: WorklerErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorklerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorklerError';
    this.code = code;
    this.details = details;
  }
}

// Contents of the lock file: who is holding the per-project lock.
export interface LockHolder {
  pid: number;
  hostname: string;
  operation: string;
  createdAt: string;
  /** Unique ownership token. Older lock files may omit it. */
  token?: string;
}

export class LockError extends WorklerError {
  readonly lockPath: string;
  // Undefined when the lock file exists but cannot be read or parsed.
  readonly holder?: LockHolder;

  constructor(lockPath: string, holder: LockHolder | undefined) {
    const who = holder
      ? `"${holder.operation}" (pid ${holder.pid} on ${holder.hostname}, started ${holder.createdAt})`
      : 'an unknown process (lock file is unreadable)';
    super(
      'LOCKED',
      `another workler operation is in progress: ${who}\n` +
        `lock file: ${lockPath}\n` +
        'if that process is gone, delete the lock file and retry',
      { lockPath, holder },
    );
    this.name = 'LockError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}
