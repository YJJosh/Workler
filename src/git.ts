import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pathsReferToSameLocation } from './fs-utils';
import { WORKSPACES_DIR } from './constants';

function runGit(repo: string | null, args: string[], stdio: 'pipe' | 'quiet' | 'inherit'): SpawnSyncReturns<string> {
  // Use the subprocess cwd instead of `git -C <repo>`. Besides producing
  // simpler diagnostics, this avoids Git-for-Windows treating an 8.3 short
  // path and the process's long-form cwd as different working trees.
  return spawnSync('git', args, {
    cwd: repo ?? undefined,
    encoding: 'utf8',
    // Large repositories can easily exceed Node's small default subprocess
    // buffer with status/ref output. A hard limit still prevents unbounded
    // memory use; callers treat ENOBUFS as a Git failure, never as success.
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

// Returns undefined only when git fails; a successful command with empty
// output returns '' so callers can tell "failed" from "empty" (see
// isGitWorkTreeClean and localBranchExists).
export function gitMaybe(repo: string | null, args: string[]): string | undefined {
  const result = runGit(repo, args, 'quiet');
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout?.trim() ?? '';
}

// gitMaybe without the trim, for NUL-delimited output (`-z`), where
// whitespace at either end belongs to a value: a guard path can be spelled
// `" leading.txt"`.
export function gitMaybeUntrimmed(repo: string | null, args: string[]): string | undefined {
  const result = runGit(repo, args, 'quiet');
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout ?? '';
}

// `git config --unset-all` exits 5 when the key is already absent, which is
// the desired state. Every other failure (a stale config.lock, a read-only
// config) must surface: the caller is about to act on the key being gone.
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

  // Git for Windows can report the same temp path in long and 8.3 forms and
  // occasionally reject `rev-parse` during that transition. A .git directory
  // or file is still a reliable working-tree marker; every mutating path runs
  // a real Git command immediately afterwards and will surface a genuine
  // malformed-repository error.
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

// Workler creates independent clones whose .git is a directory. A linked
// `git worktree` uses a .git file and is never one of Workler's own clones.
// This is a pure filesystem check: `git rev-parse` would walk up from a plain
// directory and answer for the enclosing repository instead.
export function hasIndependentGitDirectory(repo: string): boolean {
  try {
    return fs.lstatSync(path.join(repo, '.git')).isDirectory();
  } catch (_) {
    return false;
  }
}

export function gitInfoExcludePath(repo: string): string {
  // --git-path output is relative to the git process cwd (repo, via -C), so
  // resolve it against repo rather than our own cwd.
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']));
}

export function isGitWorkTreeClean(repo: string): boolean {
  // Used for add's "uncommitted changes do not clone" warning. Ordinary
  // porcelain includes tracked and untracked (but not ignored) entries.
  // The lock directory is Workler's own, not the user's changes: every
  // locked operation creates .worktrees/ (a group command does so in each
  // member it locks), and a repository that never ran `init` has no exclude
  // line for it, so Git lists it as untracked. Nothing in there is cloned
  // either way. undefined means Git failed and must not read as clean.
  // `--untracked-files=normal` pins the collapsed form: with
  // status.showUntrackedFiles=all in the user's config, Git would list
  // `?? .worktrees/.workler.lock` instead of the directory. The match is by
  // prefix for the same reason. Tracked files under .worktrees/ use another
  // status letter and are still reported.
  const status = gitMaybe(repo, ['status', '--porcelain', '--untracked-files=normal']);
  return status !== undefined && status.split('\n').every((line) => line === '' || line.startsWith(`?? ${WORKSPACES_DIR}/`));
}

// One entry that deletion would destroy, in Git's spelling (a folder ends in
// `/`): a tracked file with uncommitted or staged changes, or an untracked or
// ignored entry that is not what .workler produces.
export interface LocalDataEntry {
  path: string;
  kind: 'uncommitted' | 'untracked' | 'ignored';
}

// Remove's data-loss guard (the listing's `clean` uses it too). Lists what
// the working tree holds that deletion would destroy: changes to tracked
// files, staged changes, and untracked or ignored entries, with two
// exceptions.
//  - `managedPaths`: what the project's .workler produces in the workspace
//    (copy and link destinations, `setup --if-missing` guard paths), in the
//    rules' portable spelling, relative to `repo`. `workler apply` and
//    `workler setup` regenerate them, so a copied .env or an installed
//    node_modules is not local data, ignored or not. Every other ignored
//    entry still is: an ignored database or a hand-made .env is data that
//    deletion would destroy, and deletion is forever.
//  - An EMPTY .worktrees/: Workler's lock lives there, so any locked
//    operation leaves it behind (a nested workspace since removed, a group
//    command that locked this repository as one of its sources). A non-empty
//    one holds nested workspaces and counts. Git lists the excluded directory
//    itself without looking inside, so check.
// Stops after `limit` entries. undefined means Git failed, which must never
// read as clean.
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

// What a refusal shows of gitWorkTreeLocalData's answer, one line each,
// fetched with LOCAL_DATA_SHOWN + 1 so that "more" is known without walking
// everything.
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

// A file name as it can be printed on one line of a message. git status -z and
// readdir hand back names verbatim, so a newline or an escape sequence in a
// name could add lines to the message or reach the terminal. A name with none
// of the characters below prints as it is; any other is quoted with C-style
// escapes, the way git quotes paths.
const UNSAFE_IN_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069"\\]/u;

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

// An untracked or ignored entry is managed when it is a managed path or sits
// below one. Git folds an untracked directory into one record, so a folder on
// the way to a managed path (an untracked `config/` holding the copied
// `config/local.json`) is managed only when everything inside it is.
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
