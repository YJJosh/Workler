import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pathsReferToSameLocation } from './fs-utils';

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

export function gitInfoExcludePath(repo: string): string {
  // --git-path output is relative to the git process cwd (repo, via -C), so
  // resolve it against repo rather than our own cwd.
  return path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']));
}

export function isGitWorkTreeClean(repo: string): boolean {
  // Used for add's "uncommitted changes do not clone" warning. Ordinary
  // porcelain includes tracked and untracked (but not ignored) entries.
  return gitMaybe(repo, ['status', '--porcelain']) === '';
}

export function isGitWorkTreeCleanIncludingIgnored(repo: string): boolean {
  // Remove uses this stricter data-loss guard: an ignored .env, database, or
  // nested .worktrees/ is still data that deletion would destroy. '' means
  // clean; undefined means Git failed and must not read as clean.
  return gitMaybe(repo, ['status', '--porcelain', '--ignored=matching']) === '';
}
