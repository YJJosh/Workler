import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pathsReferToSameLocation } from './fs-utils';
import { WORKSPACES_DIR } from './constants';

function runGit(repo: string | null, args: string[], stdio: 'pipe' | 'quiet' | 'inherit'): SpawnSyncReturns<string> {
  // cwd, not `git -C`: Git for Windows can treat an 8.3 short path and the
  // long-form cwd as different working trees.
  return spawnSync('git', args, {
    cwd: repo ?? undefined,
    encoding: 'utf8',
    // Node's default is too small for large repositories; ENOBUFS is a failure.
    maxBuffer: 64 * 1024 * 1024,
    stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : stdio === 'quiet' ? ['ignore', 'pipe', 'ignore'] : 'inherit',
  });
}

function gitProcessFailure(result: SpawnSyncReturns<string>): string | undefined {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `terminated by signal ${result.signal}`;
  }
  return undefined;
}

export function git(repo: string | null, args: string[]): string {
  const result = runGit(repo, args, 'pipe');

  if (result.status !== 0) {
    const processFailure = gitProcessFailure(result);
    const stderr = result.stderr?.trim() ?? '';
    const stdout = result.stdout?.trim() ?? '';
    const detail = processFailure || stderr || stdout;
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  return result.stdout?.trim() ?? '';
}

/** Undefined only when git fails; empty output is ''. */
export function gitMaybe(repo: string | null, args: string[]): string | undefined {
  const result = runGit(repo, args, 'quiet');
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout?.trim() ?? '';
}

/** For `-z` output, where edge whitespace belongs to a value (`" leading.txt"`). */
export function gitMaybeUntrimmed(repo: string | null, args: string[]): string | undefined {
  const result = runGit(repo, args, 'quiet');
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout ?? '';
}

// `git config --unset-all` exits 5 when the key is already absent. Any other
// failure (stale config.lock, read-only config) must surface.
export function gitConfigUnset(repo: string, key: string): void {
  const args = ['config', '--local', '--unset-all', key];
  const result = runGit(repo, args, 'pipe');
  if (result.status !== 0 && result.status !== 5) {
    const detail = gitProcessFailure(result) || (result.stderr?.trim() ?? '');
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

export function gitInherit(repo: string | null, args: string[]): void {
  const result = runGit(repo, args, 'inherit');
  if (result.status !== 0) {
    const detail = gitProcessFailure(result);
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

export function localBranchExists(repo: string, branch: string): boolean {
  // --quiet prints nothing, so success is '' and failure is undefined.
  return gitMaybe(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) !== undefined;
}

export function gitBranch(repo: string): string {
  const branch = gitMaybe(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) {
    return '?';
  }
  if (branch !== 'HEAD') {
    return branch;
  }
  return gitMaybe(repo, ['rev-parse', '--short', 'HEAD']) || 'detached';
}

export function isGitRepo(dir: string): boolean {
  const detected = gitMaybe(dir, ['rev-parse', '--is-inside-work-tree']);
  if (detected === 'true') return true;

  // Git for Windows sometimes rejects `rev-parse` when a path has long and 8.3
  // forms. Mutating paths run a real Git command next, which reports a broken repo.
  return fs.existsSync(path.join(dir, '.git'));
}

export function ensureGitRepo(dir: string, command: string): void {
  if (!isGitRepo(dir)) {
    throw new Error(`workler ${command} needs a git repository`);
  }
}

export function findGitTopLevel(start: string): string | undefined {
  const topLevel = gitMaybe(start, ['rev-parse', '--show-toplevel']);
  return topLevel ? path.resolve(topLevel) : undefined;
}

export function isGitTopLevel(dir: string): boolean {
  const topLevel = findGitTopLevel(dir);
  return topLevel !== undefined && pathsReferToSameLocation(topLevel, dir);
}

/** A .git directory, not a linked `git worktree`'s file. Filesystem only: `git rev-parse` would answer for an enclosing repo. */
export function hasIndependentGitDirectory(repo: string): boolean {
  try {
    return fs.lstatSync(path.join(repo, '.git')).isDirectory();
  } catch (_) {
    return false;
  }
}

export function gitInfoExcludePath(repo: string): string {
  // --git-path output is relative to git's cwd, which is `repo`.
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']));
}

export function isGitWorkTreeClean(repo: string): boolean {
  // For add's "uncommitted changes" warning. Untracked .worktrees/ is the lock directory, unexcluded before `init`;
  // --untracked-files=normal and the prefix match cover status.showUntrackedFiles=all. A Git failure is not clean.
  const status = gitMaybe(repo, ['status', '--porcelain', '--untracked-files=normal']);
  return status !== undefined && status.split('\n').every((line) => line === '' || line.startsWith(`?? ${WORKSPACES_DIR}/`));
}

/** An entry deletion would destroy, in Git's spelling (a folder ends in `/`). */
export interface LocalDataEntry {
  path: string;
  kind: 'uncommitted' | 'untracked' | 'ignored';
}

/**
 * Remove's data-loss guard: tracked/staged changes and untracked or ignored entries (a hand-made .env counts),
 * except `managedPaths` (forward-slash, relative to `repo`) and an empty .worktrees/ left by the lock.
 * Stops after `limit` entries. Undefined when Git fails, which must never read as clean.
 */
export function gitWorkTreeLocalData(repo: string, managedPaths: readonly string[] = [], limit = Infinity): LocalDataEntry[] | undefined {
  // -z: one NUL-terminated record per path, never quoted, whatever the name.
  const result = runGit(repo, ['status', '--porcelain', '-z', '--ignored=matching'], 'quiet');
  if (result.status !== 0 || gitProcessFailure(result) !== undefined) {
    return undefined;
  }
  const records = (result.stdout ?? '').split('\0');
  const entries: LocalDataEntry[] = [];
  for (let i = 0; i < records.length && entries.length < limit; i += 1) {
    const record = records[i];
    if (record === '') {
      continue;
    }
    const code = record.slice(0, 2);
    if (code !== '??' && code !== '!!') {
      entries.push({ path: record.slice(3), kind: 'uncommitted' });
      // A rename or copy is followed by a record holding the old name.
      if (code.includes('R') || code.includes('C')) {
        i += 1;
      }
      continue;
    }
    const kind = code === '??' ? 'untracked' : 'ignored';
    const isDirectory = record.endsWith('/');
    const entryPath = isDirectory ? record.slice(3, -1) : record.slice(3);
    if (entryPath === WORKSPACES_DIR) {
      // Git lists an excluded directory without looking inside.
      if (!isEmptyDirectory(path.join(repo, WORKSPACES_DIR))) {
        entries.push({ path: record.slice(3), kind });
      }
      continue;
    }
    if (!isManagedEntry(repo, entryPath, isDirectory, managedPaths)) {
      entries.push({ path: record.slice(3), kind });
    }
  }
  return entries;
}

export function isGitWorkTreeFreeOfLocalData(repo: string, managedPaths: readonly string[] = []): boolean {
  const entries = gitWorkTreeLocalData(repo, managedPaths, 1);
  return entries !== undefined && entries.length === 0;
}

/** Entries a refusal lists. Fetch one more to know whether there are more. */
export const LOCAL_DATA_SHOWN = 10;

export function describeLocalData(entries: readonly LocalDataEntry[] | undefined): string[] {
  if (entries === undefined) {
    return ['(git status failed, so Workler cannot tell what is there)'];
  }
  const lines = entries.slice(0, LOCAL_DATA_SHOWN).map((entry) => `${entry.kind}: ${displayPath(entry.path)}`);
  if (entries.length > LOCAL_DATA_SHOWN) {
    lines.push('... and more (git status --ignored lists everything)');
  }
  return lines;
}

// git status -z and readdir return names verbatim: a newline, terminal escape or bidi control could forge or
// reorder message text, so such names get C-style escapes, the way git quotes paths.
const UNSAFE_IN_DISPLAY = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}"\\]/u;

export function displayPath(path: string): string {
  if (!UNSAFE_IN_DISPLAY.test(path)) {
    return path;
  }
  let quoted = '"';
  for (const char of path) {
    if (char === '"' || char === '\\') {
      quoted += `\\${char}`;
    } else if (char === '\n') {
      quoted += '\\n';
    } else if (char === '\t') {
      quoted += '\\t';
    } else if (char === '\r') {
      quoted += '\\r';
    } else if (UNSAFE_IN_DISPLAY.test(char)) {
      const code = char.codePointAt(0) ?? 0;
      quoted += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      quoted += char;
    }
  }
  return `${quoted}"`;
}

function isUnderManagedPath(entryPath: string, managedPaths: readonly string[]): boolean {
  return managedPaths.some((managed) => entryPath === managed || entryPath.startsWith(`${managed}/`));
}

// Git folds an untracked directory into one record, so a folder above a managed path
// (`config/` holding `config/local.json`) is managed only when everything inside it is.
function isManagedEntry(repo: string, entryPath: string, isDirectory: boolean, managedPaths: readonly string[]): boolean {
  if (isUnderManagedPath(entryPath, managedPaths)) {
    return true;
  }
  if (!isDirectory || !managedPaths.some((managed) => managed.startsWith(`${entryPath}/`))) {
    return false;
  }
  return holdsOnlyManagedPaths(path.join(repo, ...entryPath.split('/')), entryPath, managedPaths);
}

function holdsOnlyManagedPaths(dir: string, relative: string, managedPaths: readonly string[]): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return false;
  }
  return entries.every((entry) => {
    const entryPath = `${relative}/${entry.name}`;
    if (isUnderManagedPath(entryPath, managedPaths)) {
      return true;
    }
    return (
      entry.isDirectory() &&
      managedPaths.some((managed) => managed.startsWith(`${entryPath}/`)) &&
      holdsOnlyManagedPaths(path.join(dir, entry.name), entryPath, managedPaths)
    );
  });
}

function isEmptyDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (_) {
    return false;
  }
}
