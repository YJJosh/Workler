import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathsReferToSameLocation } from './fs-utils';
import { displayPath } from './git';
import { memberPath, sourceBrokenReason } from './groups';
import type { SyncTarget } from './multi-git';

/** Commit preservation, NOT working-tree cleanliness or a backup guarantee. */
export interface HistoryAssessment {
  state: 'safe' | 'unsafe' | 'unknown';
  // Exact count, with at most five full commit IDs as actionable examples.
  unpreservedCount?: number;
  commits?: string[];
  reason?: string;
}

const OUTPUT_LIMIT = 32 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Independent of Git environment overrides, with no network, replacements or
// optional writes. A timeout/output limit is an inspection failure, not proof.
function inspect(repo: string, args: string[], input?: string, allowed = [0]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.commitGraph=false', ...args], {
    cwd: repo,
    env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', input, maxBuffer: OUTPUT_LIMIT, timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Git can return success while warning that pruned reflog commits were
  // omitted. Any diagnostic makes this proof incomplete; never call it safe.
  if (result.error || result.signal || result.stderr.trim() || result.status === null || !allowed.includes(result.status)) {
    throw new Error('Git inspection failed (or exceeded the 30s / 32 MiB per-command limit)');
  }
  return result.stdout.trim();
}

function realDirectory(dir: string): boolean {
  const stat = fs.lstatSync(dir);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

// A source ref/object reached through a symlink into the workspace would
// disappear on deletion despite looking reachable today. Refuse linked Git
// history metadata, without following it. Bound filesystem inspection too.
function unlinkedMetadata(dotGit: string): void {
  const started = Date.now();
  let entries = 0;
  const pending = ['objects', 'refs', 'logs', 'HEAD', 'packed-refs', 'reftable'].map((entry) => path.join(dotGit, entry));
  while (pending.length) {
    if (++entries > 1_000_000 || Date.now() - started > 30_000) throw new Error('Git metadata inspection exceeded its 30s / one million entries limit');
    const current = pending.pop()!;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('linked Git history metadata cannot be assessed');
    if (stat.isDirectory()) {
      const dir = fs.opendirSync(current);
      try {
        let entry: fs.Dirent | null;
        while ((entry = dir.readSync()) !== null) {
          if (++entries > 1_000_000 || Date.now() - started > 30_000) throw new Error('Git metadata inspection exceeded its 30s / one million entries limit');
          if (entry.isSymbolicLink()) throw new Error('linked Git history metadata cannot be assessed');
          if (entry.isDirectory()) pending.push(path.join(current, entry.name));
        }
      } finally { dir.closeSync(); }
    }
  }
  // Git accepts paths in reftable's tables.list. Reject indirections
  // outside this directory even when every metadata entry is a regular file.
  const tables = path.join(dotGit, 'reftable', 'tables.list');
  let stat: fs.Stats;
  try { stat = fs.lstatSync(tables); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.size > OUTPUT_LIMIT) throw new Error('reftable table list cannot be inspected safely');
  if (/[\\/]/.test(fs.readFileSync(tables, 'utf8'))) throw new Error('external reftable table paths cannot be assessed');
}

function inspectRepository(repo: string): string[] {
  const dotGit = path.join(repo, '.git');
  if (!realDirectory(repo) || !realDirectory(dotGit) || !realDirectory(path.join(dotGit, 'objects')) ||
      !pathsReferToSameLocation(inspect(repo, ['rev-parse', '--show-toplevel']), repo)) {
    throw new Error('source and workspace must be independent repository directories, not linked checkouts');
  }
  for (const entry of ['commondir', 'shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    // lstat catches dangling links too. An unreadable path fails closed.
    try {
      fs.lstatSync(path.join(dotGit, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('shallow, grafted, shared or alternate object stores are not supported by the history proof');
  }
  if (inspect(repo, ['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('shallow history cannot be assessed');
  }
  unlinkedMetadata(dotGit);
  // Parse config record boundaries and let Git interpret its boolean
  // syntax: a valueless promisor means true, while an explicit false is not a
  // partial clone. Newline-delimited --list missed the former and blocked the latter.
  const config = inspect(repo, ['config', '--null', '--list', '--includes']).split('\0');
  const hasPromisor = config.some((entry) => /^remote\.[\s\S]*\.promisor(?:\n|$)/i.test(entry));
  const promisors = new Map<string, string>();
  if (hasPromisor) {
    const records = inspect(repo,
      ['config', '--includes', '--null', '--bool', '--get-regexp', '^remote\\..*\\.promisor$'], undefined, [0, 1]);
    for (const record of records.split('\0').filter(Boolean)) {
      const separator = record.lastIndexOf('\n');
      promisors.set(record.slice(0, separator), record.slice(separator + 1));
    }
  }
  const enabledPromisor = [...promisors.values()].includes('true');
  if (enabledPromisor || config.some((entry) => /^extensions\.partialclone(?:\n|$)/i.test(entry))) {
    throw new Error('partial clones cannot be assessed offline');
  }
  const refs = inspect(repo, ['for-each-ref', '--format=%(refname) %(symref)']).split('\n').filter(Boolean);
  if (refs.some((ref) => ref.startsWith('refs/replace/'))) {
    throw new Error('replace refs cannot be assessed');
  }
  return refs;
}

function ids(output: string): string[] {
  if (!output) return [];
  const lines = output.split('\n');
  if (!lines.every((line) => OID.test(line))) throw new Error('missing objects or unexpected Git history output');
  return lines;
}

function walk(repo: string, revisions: string[]): string[] {
  const input = revisions.join('\n') + '\n';
  // Check the reachable objects too: missing trees/blobs must not produce a
  // reassuring answer merely because their commit headers are readable.
  // Quiet traversal verifies connectivity without printing every object ID.
  inspect(repo, ['rev-list', '--objects', '--quiet', '--stdin'], input);
  return ids(inspect(repo, ['rev-list', '--stdin'], input));
}

/** Read-only, offline proof against refs that survive workspace deletion.
 * Source policy: direct local branches/tags, plus detached HEAD. No remote
 * refs, stash/reflogs, symbolic aliases or Workler synchronization mirrors.
 */
export function assessHistory(source: string, workspace: string): HistoryAssessment {
  try {
    const sourceRefs = inspectRepository(source);
    inspectRepository(workspace);
    // Ref names cannot contain spaces. A nonempty second field is a symbolic
    // alias, not an independent durable ref. trim() also handles the last row.
    const revisions = sourceRefs.filter((ref) => !ref.trim().includes(' ') && /^(refs\/heads\/|refs\/tags\/)/.test(ref)).map((ref) => ref.trim());
    const symbolic = inspect(source, ['symbolic-ref', '-q', 'HEAD'], undefined, [0, 1]);
    if (!symbolic) revisions.push('HEAD');
    const preserved = new Set(revisions.length === 0 ? [] : walk(source, revisions));
    // --all includes HEAD, all namespaces and tags; --reflog adds old stash
    // entries and commits orphaned by reset/amend, including old reflog OIDs.
    const candidates = ids(inspect(workspace, ['rev-list', '--all', '--reflog']));
    inspect(workspace, ['rev-list', '--objects', '--quiet', '--all', '--reflog']);
    const missing = candidates.filter((commit) => !preserved.has(commit));
    return missing.length === 0 ? { state: 'safe' } : { state: 'unsafe', unpreservedCount: missing.length, commits: missing.slice(0, 5) };
  } catch (error) {
    // Never include raw stderr, config, ref names or paths in this diagnostic.
    const reason = error instanceof Error && !('code' in error) ? error.message : 'repository files could not be inspected';
    return { state: 'unknown', reason };
  }
}

export function targetHistory(root: string, target: SyncTarget): HistoryAssessment | undefined {
  // An absent member holds no repository/history to delete; remove skips it
  // too. This is not an inspection success and must not be labeled safe.
  if (target.name === 'main' || (target.project !== undefined && target.broken === 'missing (not cloned)')) return undefined;
  if (target.broken) return { state: 'unknown', reason: 'workspace repository is missing or broken' };
  if (target.project !== undefined && sourceBrokenReason(root, target.project) !== undefined) {
    return { state: 'unknown', reason: 'source repository is missing, broken or linked' };
  }
  return assessHistory(target.project === undefined ? root : memberPath(root, target.project), target.path);
}

export function describeHistory(history: HistoryAssessment): string {
  if (history.state === 'safe') return 'preserved in source';
  if (history.state === 'unknown') return `unknown: ${history.reason}`;
  return `${history.unpreservedCount} commit(s) not preserved in source`;
}

// A single terminal-safe, copyable Bash/Git Bash word, including control and
// bidi characters. ANSI-C quoting is intentional; not PowerShell/cmd syntax.
function bashWord(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (char === "'" || char === '\\') escaped += `\\${char}`;
    else if (/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(char)) {
      escaped += [...Buffer.from(char)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    } else escaped += char;
  }
  return `$'${escaped}'`;
}

export function historyAdvice(source: string, workspace: string, history: HistoryAssessment): string[] {
  const commit = history.commits?.[0];
  if (!commit) return ['Inspect/repair the repositories and rerun workler status; history preservation is unknown.'];
  if (source.length + workspace.length > 4000) return ['Import the listed commits into durable source branches (see workler remove documentation), then rerun status.'];
  return [
    `Example: preserve ${commit} in an unused source branch (choose another branch name if needed). Bash / Git Bash:`,
    `git -C ${bashWord(source)} fetch --no-tags -- ${bashWord(workspace)} ${bashWord(`${commit}:refs/heads/keep-${commit.slice(0, 12)}`)}`,
    'Rerun workler status for remaining commits. Importing history does NOT back up dirty, untracked or ignored files.',
  ];
}

export function historyLabel(value: string): string {
  return displayPath(value.length > 200 ? value.slice(0, 200) + '...' : value);
}
