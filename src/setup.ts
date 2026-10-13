import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readSetupCommands } from './config';
import { PACKAGE_NAME, SETUP_OUTPUT_KEY, SETUP_RECORD_FILE } from './constants';
import { WorklerError } from './errors';
import { pathsReferToSameLocation } from './fs-utils';
import { git, gitConfigUnset, gitMaybeUntrimmed, hasIndependentGitDirectory } from './git';
import type { SetupCommand } from './types';

// How much of a command's output `setupStdio: 'pipe'` keeps per stream.
const OUTPUT_BUFFER_LIMIT = 64 * 1024 * 1024;

// Runs the `setup <command>` lines of a project's .workler inside one of its
// workspaces: sequentially, in file order, through the platform shell, with
// the workspace as the working directory. The first failure stops the run and
// throws SETUP_COMMAND_FAILED; the workspace is never rolled back, since a
// half-installed workspace is still worth inspecting and `workler setup`
// re-runs the commands.

// One command's outcome. 'failed' only appears as the last entry, and only in
// the error details: outside that the run throws instead of returning.
export interface SetupCommandResult {
  command: string;
  // 'skipped': the command's `--if-missing` path already existed.
  status: 'ok' | 'skipped' | 'failed';
  // For 'skipped': the `--if-missing` path that exists. For 'ok' with
  // guardMissing: the path the command was expected to create.
  ifMissing?: string;
  // 'ok' only: the command succeeded but its `--if-missing` path still does
  // not exist, so it runs again on every setup and nothing is recorded.
  guardMissing?: true;
  // Exit code of the command; undefined when a signal ended it.
  exitCode?: number;
  // Signal that ended the command, when there was one.
  signal?: string;
  // With `setupStdio: 'pipe'`: everything the command wrote to each stream
  // (possibly ''). Absent when the streams were inherited.
  stdout?: string;
  stderr?: string;
}

export interface SetupOptions {
  // Called before each command starts so the CLI can print a heading.
  onSetupCommand?: (command: SetupCommand, index: number, total: number) => void;
  // Called instead for a command that is skipped because its `--if-missing`
  // path exists.
  onSetupSkip?: (command: SetupCommand, index: number, total: number) => void;
  // Called after a guarded command that exited 0 without creating its
  // `--if-missing` path (usually a guard that names another folder than the
  // command writes to).
  onSetupGuardMissing?: (command: SetupCommand, index: number, total: number, project?: string) => void;
  // Where a command's stdout goes. 'inherit' (default) shares the caller's
  // stdout; 'stderr' keeps the caller's stdout free of command output, which
  // the CLI uses whenever its own stdout is not a terminal. Only with
  // setupStdio 'inherit'.
  setupStdout?: 'inherit' | 'stderr';
  // How a command's streams are wired. 'inherit' (default) shares the
  // caller's stdin, stdout and stderr, as the CLI does. 'pipe' captures
  // stdout and stderr instead (stdin is closed): each command's output is
  // handed to onSetupOutput and kept on its result, and nothing reaches the
  // caller's own streams. The API is synchronous, so a command's output
  // arrives once the command has exited, not while it runs.
  setupStdio?: 'inherit' | 'pipe';
  // With setupStdio 'pipe': called after a command exits with what it wrote
  // to each stream (once per stream that produced output), before the
  // failure, if any, is thrown.
  onSetupOutput?: (chunk: string, stream: 'stdout' | 'stderr', command: SetupCommand, index: number) => void;
}

export interface SetupOutcome {
  // Total setup lines parsed from .workler (0 means none were declared).
  commandCount: number;
  results: SetupCommandResult[];
}

// Where one run of setup commands happens.
export interface SetupTarget {
  // The project whose .workler lists the commands: the parent a workspace
  // was cloned from, a member clone's source repository, or the group root.
  root: string;
  // The directory the commands run in: the workspace, or a member clone.
  path: string;
  // The workspace name (WORKLER_WORKSPACE).
  name: string;
  // Set when a project group is involved: for the group's own commands (run
  // in the workspace folder) and for every member's (then `project` names
  // the member).
  group?: { root: string; workspacePath: string; project?: string };
  // What to hand `workler setup` to repeat this run: the workspace name
  // (default) or `<name>/<project>` when one member was addressed directly.
  address?: string;
}

export function validateSetupOptions(options: SetupOptions): void {
  for (const key of ['onSetupCommand', 'onSetupSkip', 'onSetupGuardMissing'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw new WorklerError('INVALID_OPTIONS', `${key} must be a function when provided`);
    }
  }
  if (options.setupStdout !== undefined && options.setupStdout !== 'inherit' && options.setupStdout !== 'stderr') {
    throw new WorklerError('INVALID_OPTIONS', 'setupStdout must be "inherit" or "stderr" when provided');
  }
  if (options.setupStdio !== undefined && options.setupStdio !== 'inherit' && options.setupStdio !== 'pipe') {
    throw new WorklerError('INVALID_OPTIONS', 'setupStdio must be "inherit" or "pipe" when provided');
  }
  if (options.onSetupOutput !== undefined && typeof options.onSetupOutput !== 'function') {
    throw new WorklerError('INVALID_OPTIONS', 'onSetupOutput must be a function when provided');
  }
  // Misuse that would silently lose output or silently ignore an option.
  if (options.onSetupOutput !== undefined && options.setupStdio !== 'pipe') {
    throw new WorklerError('INVALID_OPTIONS', 'onSetupOutput needs setupStdio "pipe"');
  }
  if (options.setupStdio === 'pipe' && options.setupStdout === 'stderr') {
    throw new WorklerError('INVALID_OPTIONS', 'setupStdout "stderr" cannot be combined with setupStdio "pipe"');
  }
}

// `WORKLER_NO_SETUP` in the environment makes `add` skip the setup commands
// the way --no-setup does, for a shell or CI job that never wants a clone to
// run commands from the repository. "0" and the empty value mean off; any
// other value means on. Only `add` honors it: an explicit `workler setup`
// asked for the commands.
export const NO_SETUP_VARIABLE = 'WORKLER_NO_SETUP';

export function setupDisabledByEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[NO_SETUP_VARIABLE];
  return value !== undefined && value !== '' && value !== '0';
}

// Variables a package manager sets for the scripts it runs (`npm run`, `pnpm
// exec`, `yarn`): npm_config_*, npm_package_*, npm_lifecycle_*, pnpm_*,
// yarn_* and INIT_CWD. Workler is often started from such a script, and a
// setup command that runs `pnpm install` would otherwise inherit the caller's
// view of its own package (its cwd, its config, its lifecycle event) and
// install into the wrong place or with the wrong settings. The match is
// case-sensitive on purpose: the injected variables are lowercase, while
// NPM_CONFIG_REGISTRY, YARN_ENABLE_IMMUTABLE_INSTALLS or PNPM_HOME are
// settings a user exports for the installer, and pass through.
const PACKAGE_MANAGER_VARIABLE = /^(npm_|pnpm_|yarn_)/;
const INIT_CWD_VARIABLE = 'INIT_CWD';

function isPackageManagerVariable(name: string): boolean {
  return PACKAGE_MANAGER_VARIABLE.test(name) || name === INIT_CWD_VARIABLE;
}

// Variables every command sees in addition to the caller's environment, so a
// script can tell workspaces apart or reach back to the parent project. In a
// project group the group root, the group workspace folder and (for a
// member's commands) the declared project path come along too. The caller's
// package-manager variables are dropped (see isPackageManagerVariable);
// everything else is passed through.
export function setupEnvironment(target: SetupTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    WORKLER_WORKSPACE: target.name,
    WORKLER_WORKSPACE_PATH: target.path,
    WORKLER_ROOT: target.root,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (!isPackageManagerVariable(name) && !(name in env)) {
      env[name] = value;
    }
  }
  // Only this run's group variables may be present. Workler itself can be
  // the caller (a member's command running `workler add` for another
  // project, say), and its group context must not leak into a plain
  // workspace or into the group's own commands.
  delete env.WORKLER_GROUP;
  delete env.WORKLER_GROUP_WORKSPACE_PATH;
  delete env.WORKLER_PROJECT;
  if (target.group) {
    env.WORKLER_GROUP = target.group.root;
    env.WORKLER_GROUP_WORKSPACE_PATH = target.group.workspacePath;
    if (target.group.project !== undefined) {
      env.WORKLER_PROJECT = target.group.project;
    }
  }
  return env;
}

// A guard only asks whether its path exists: it cannot tell the command's
// work from a folder the user made at the same path (in a workspace created
// with --no-setup, say), and a later `setup` skips such a path rather than
// regenerating it. So a run records the guard paths whose command ran to
// success and left the path behind, and only those are exempt from the
// local-data guard of `remove` and the listing's `clean` (see
// managedWorkspacePaths). The record lives where the workspace does: in the
// git config of a repository workspace or member clone, and in a file next
// to the .workler copy for a group workspace folder, which has no git config.
export type SetupRecordKind = 'clone' | 'folder';

function recordKind(target: Pick<SetupTarget, 'group'>): SetupRecordKind {
  return target.group !== undefined && target.group.project === undefined ? 'folder' : 'clone';
}

// One recorded guard path: the path in the .workler's portable spelling, and
// the entry the command left there as `lstat` identifies it (device, inode,
// creation time). The identity tells the command's entry from one that took
// its place later: the user deleting the output and putting their own file
// there. Stored as `<identity> <path>`, split at the first space, so a path
// keeps any whitespace it is spelled with.
export interface SetupRecordEntry {
  id: string;
  path: string;
}

const RECORD_VALUE = /^(\d+:\d+:\d+) (.+)$/s;

function parseRecordValues(values: string[]): SetupRecordEntry[] | undefined {
  const entries: SetupRecordEntry[] = [];
  for (const value of values) {
    const match = RECORD_VALUE.exec(value);
    if (match === null) {
      return undefined;
    }
    entries.push({ id: match[1], path: match[2] });
  }
  return entries;
}

function formatRecordValue(entry: SetupRecordEntry): string {
  return `${entry.id} ${entry.path}`;
}

// The identity of whatever sits at the path, a link itself rather than its
// target, or undefined when nothing does. The creation time tells a reused
// inode apart where the file system reports one (0 where it does not).
function entryIdentity(p: string): string | undefined {
  try {
    const stat = fs.lstatSync(p, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

// The guard paths recorded for a workspace whose entry is still the one the
// command made, in the .workler's portable spelling. A record that cannot be
// read, or is not one Workler wrote, names nothing, and neither does an entry
// that has been replaced since: those paths count as local data, which errs on
// the safe side.
export function recordedSetupOutputs(dir: string, kind: SetupRecordKind): string[] {
  return readSetupRecord(dir, kind)
    .filter((entry) => entryIdentity(path.join(dir, ...entry.path.split('/'))) === entry.id)
    .map((entry) => entry.path);
}

function readSetupRecord(dir: string, kind: SetupRecordKind): SetupRecordEntry[] {
  if (kind === 'clone') {
    if (!hasIndependentGitDirectory(dir)) {
      return [];
    }
    const listed = gitMaybeUntrimmed(dir, ['config', '--local', '-z', '--get-all', SETUP_OUTPUT_KEY]);
    if (listed === undefined) {
      return [];
    }
    // A value Workler cannot read names nothing; the others still count.
    return listed
      .split('\0')
      .filter((value) => value !== '')
      .flatMap((value) => parseRecordValues([value]) ?? []);
  }
  return readSetupRecordFile(dir) ?? [];
}

// A group folder's record, or undefined when the file at that name is not one
// Workler wrote: only a regular file whose text is exactly what
// writeSetupRecord writes counts. Anything else there (malformed, edited by
// hand, a link or a directory) is the user's, names no outputs, and is local
// data for `remove`.
export function readSetupRecordFile(dir: string): SetupRecordEntry[] | undefined {
  try {
    const file = path.join(dir, SETUP_RECORD_FILE);
    if (!fs.lstatSync(file).isFile()) {
      return undefined;
    }
    const text = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(text);
    const values = (parsed as { setupOutput?: unknown } | null)?.setupOutput;
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
      return undefined;
    }
    if (text !== serializeSetupRecord(values)) {
      return undefined;
    }
    return parseRecordValues(values);
  } catch (_) {
    return undefined;
  }
}

function serializeSetupRecord(values: string[]): string {
  return `${JSON.stringify({ setupOutput: values }, null, 2)}\n`;
}

// Records the entry a guarded command just made at its path, replacing any
// earlier record of that path.
function recordSetupOutput(target: SetupTarget, ifMissing: string, guardPath: string): void {
  const id = entryIdentity(guardPath);
  if (id === undefined) {
    return;
  }
  const kind = recordKind(target);
  // Only a clone of Workler's own making has a config of its own to write
  // to; a .git file would reach some other repository's.
  if (kind === 'clone' && !hasIndependentGitDirectory(target.path)) {
    return;
  }
  if (kind === 'folder' && entryExists(path.join(target.path, SETUP_RECORD_FILE)) && readSetupRecordFile(target.path) === undefined) {
    // Something of the user's sits at the record's name (a dangling link
    // included): leave it alone. The path then goes unrecorded and counts as
    // local data, the safe side.
    return;
  }
  const recorded = readSetupRecord(target.path, kind);
  if (recorded.some((entry) => entry.path === ifMissing && entry.id === id)) {
    return;
  }
  writeRecord(target, kind, [...recorded.filter((entry) => entry.path !== ifMissing), { id, path: ifMissing }]);
}

// Drops a guard path from the record. The runner calls it when it finds the
// path missing and is about to run the command again: from then on whatever
// turns up at the path is the new run's doing, and a run that fails after
// creating it (the half-way install the failure message warns about) must
// not leave `remove` trusting the old record. Success records it again.
function forgetSetupOutput(target: SetupTarget, ifMissing: string): void {
  const kind = recordKind(target);
  const recorded = readSetupRecord(target.path, kind);
  if (!recorded.some((entry) => entry.path === ifMissing)) {
    return;
  }
  writeRecord(target, kind, recorded.filter((entry) => entry.path !== ifMissing));
}

function writeRecord(target: SetupTarget, kind: SetupRecordKind, entries: SetupRecordEntry[]): void {
  if (kind === 'clone') {
    // Clear the key and write the rest back (`--fixed-value` needs git 2.30).
    gitConfigUnset(target.path, SETUP_OUTPUT_KEY);
    for (const entry of entries) {
      git(target.path, ['config', '--local', '--add', SETUP_OUTPUT_KEY, formatRecordValue(entry)]);
    }
    return;
  }
  writeSetupRecord(target.path, entries.map(formatRecordValue));
}

// Written whole and moved into place, so an interrupted write never leaves
// half a record behind.
function writeSetupRecord(dir: string, values: string[]): void {
  const file = path.join(dir, SETUP_RECORD_FILE);
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, serializeSetupRecord(values));
  fs.renameSync(staging, file);
}

/**
 * A guarded command that exited 0 without creating its path. Whether it will
 * run again is only known once every setup line has run: a later line (or the
 * group's own lines, which run after its members') may create the path.
 */
export interface PendingGuard {
  result: SetupCommandResult;
  setup: SetupCommand;
  index: number;
  total: number;
  guardPath: string;
  /** The member's project path, for a group member's setup line. */
  project?: string;
}

/** Warns for each pending guard whose path is still missing now that setup has finished. */
export function settleGuards(pending: PendingGuard[], options: SetupOptions = {}): void {
  for (const guard of pending) {
    if (entryExists(guard.guardPath)) {
      continue;
    }
    Object.assign(guard.result, { ifMissing: guard.setup.ifMissing, guardMissing: true });
    options.onSetupGuardMissing?.(guard.setup, guard.index, guard.total, guard.project);
  }
}

/**
 * Runs the workspace's setup lines. Pass `pending` to collect guarded commands
 * whose path is still missing instead of settling them here, when more setup
 * lines run afterwards (see settleGuards).
 */
export function runSetupCommands(target: SetupTarget, options: SetupOptions = {}, pending?: PendingGuard[]): SetupOutcome {
  if (pathsReferToSameLocation(target.root, target.path)) {
    throw new WorklerError('INVALID_OPTIONS', 'refusing to run setup commands in the main workspace');
  }

  const commands = readSetupCommands(target.root);
  const outcome: SetupOutcome = { commandCount: commands.length, results: [] };
  const env = setupEnvironment(target);
  // A member's failure is prefixed with its project path by the group-aware
  // caller (core/setup.ts); the details carry it either way.
  const project = target.group?.project;
  const where = { name: target.name, path: target.path, ...(project === undefined ? {} : { project }) };
  const guards = pending ?? [];

  for (const [index, setup] of commands.entries()) {
    // `--if-missing <path>`: the path is checked here, not by the shell, so
    // the guard means the same on every platform. Whatever is there counts,
    // including a link made by a `link` rule whose target exists.
    const guardPath = setup.ifMissing === undefined ? undefined : path.join(target.path, ...setup.ifMissing.split('/'));
    if (guardPath !== undefined && fs.existsSync(guardPath)) {
      options.onSetupSkip?.(setup, index, commands.length);
      outcome.results.push({ command: setup.command, status: 'skipped', ifMissing: setup.ifMissing });
      continue;
    }
    // A link whose target is gone is "absent" to existsSync, but the command
    // would collide with the stale entry (pnpm fails on mkdir). Stop and name
    // it instead of running into that.
    if (guardPath !== undefined && isDanglingLink(guardPath)) {
      outcome.results.push({ command: setup.command, status: 'failed' });
      throw new WorklerError(
        'SETUP_COMMAND_FAILED',
        `setup command not run in ${target.path}: ${setup.command}\n` +
          `  ${setup.ifMissing} is a link whose target no longer exists, so the command would collide with it\n` +
          `the workspace was kept; remove the link or restore its target, then re-run \`${PACKAGE_NAME} setup ${target.address ?? target.name}\``,
        { ...where, command: setup.command, index, commandCount: commands.length, results: outcome.results, ifMissing: setup.ifMissing, cause: 'dangling link' },
      );
    }

    // The path is missing, so the command runs: an earlier run's record for
    // it says nothing about what this run leaves there.
    if (setup.ifMissing !== undefined) {
      forgetSetupOutput(target, setup.ifMissing);
    }

    options.onSetupCommand?.(setup, index, commands.length);

    // The command is handed to the platform shell exactly as written in
    // .workler (sh -c on POSIX, cmd.exe on Windows), so committed setup lines
    // behave the same for every developer regardless of their login shell.
    const piped = options.setupStdio === 'pipe';
    const result = spawnSync(setup.command, {
      cwd: target.path,
      env,
      shell: true,
      encoding: 'utf8',
      // Only read when piped. An install's output can be large; past this
      // the command is killed and reported below (ENOBUFS), never as success.
      maxBuffer: OUTPUT_BUFFER_LIMIT,
      stdio: piped ? ['ignore', 'pipe', 'pipe'] : ['inherit', options.setupStdout === 'stderr' ? process.stderr.fd : 'inherit', 'inherit'],
    });
    // Whatever was captured is handed over before a failure is thrown, so a
    // consumer can show why the command failed.
    const output = piped ? { stdout: result.stdout ?? '', stderr: result.stderr ?? '' } : {};
    if (piped) {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (result[stream]) {
          options.onSetupOutput?.(result[stream], stream, setup, index);
        }
      }
    }
    if (result.error) {
      const overflow = (result.error as NodeJS.ErrnoException).code === 'ENOBUFS';
      const cause = overflow ? `it wrote more than the ${OUTPUT_BUFFER_LIMIT / (1024 * 1024)} MiB Workler captures with setupStdio "pipe"` : result.error.message;
      // No result for this command: it never ran to an exit (the results
      // list what did run, for the retry hint).
      throw new WorklerError(
        'SETUP_COMMAND_FAILED',
        `setup command ${overflow ? 'was stopped' : 'could not be started'} in ${target.path}: ${setup.command}\n` +
          `  ${cause}\n` +
          `the workspace was kept; ${retryHint(target.address ?? target.name)}`,
        { ...where, command: setup.command, index, commandCount: commands.length, results: outcome.results, cause },
      );
    }

    if (result.status === 0) {
      if (setup.ifMissing !== undefined && guardPath !== undefined && !entryExists(guardPath)) {
        // The command did its job but not the guard's, and there is nothing
        // to record. Unless a later setup line creates the path, it will run
        // again on every setup: most often the guard names another folder
        // than the one the command writes to. Settled once setup has finished.
        const result: SetupCommandResult = { command: setup.command, status: 'ok', ...output };
        outcome.results.push(result);
        guards.push({ result, setup, index, total: commands.length, guardPath, ...(project === undefined ? {} : { project }) });
        continue;
      }
      outcome.results.push({ command: setup.command, status: 'ok', ...output });
      // From now on the guard finds the command's work there: remember it, so
      // `remove` can tell it from something the user put at that path.
      if (setup.ifMissing !== undefined && guardPath !== undefined && fs.existsSync(guardPath)) {
        recordSetupOutput(target, setup.ifMissing, guardPath);
      }
      continue;
    }

    const exitCode = result.status ?? undefined;
    const signal = result.signal ?? undefined;
    outcome.results.push({ command: setup.command, status: 'failed', exitCode, signal, ...output });
    const reason = signal ? `terminated by signal ${signal}` : `exit code ${exitCode}`;
    // The guard only asks whether the path exists. A command that created its
    // path and then died (an install that stopped half-way) would be skipped
    // by a plain re-run, which would exit 0 and look fine. Say so here.
    const leftBehind = guardPath !== undefined && fs.existsSync(guardPath);
    const leftover = leftBehind
      ? `\n  ${setup.ifMissing} now exists, so \`${PACKAGE_NAME} setup\` would skip this command; remove it before re-running`
      : '';
    throw new WorklerError(
      'SETUP_COMMAND_FAILED',
      `setup command failed in ${target.path}: ${setup.command} (${reason})${leftover}\n` +
        `the workspace was kept; ${retryHint(target.address ?? target.name)}`,
      { ...where, command: setup.command, exitCode, signal, index, commandCount: commands.length, results: outcome.results, ...(leftBehind ? { leftBehind: setup.ifMissing } : {}) },
    );
  }

  if (pending === undefined) {
    settleGuards(guards, options);
  }
  return outcome;
}

// `address` is what was run: a whole workspace, or one member of a group.
function retryHint(address: string): string {
  return `fix the problem and re-run \`${PACKAGE_NAME} setup ${address}\``;
}

// True when anything sits at the path, a link whose target is gone included.
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// True for a symbolic link (or Windows junction) whose target is gone.
// existsSync follows links, so it reports such a path as absent.
function isDanglingLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p);
  } catch {
    return false;
  }
}

// Renders the heading the CLI prints before each command, aligned with the
// other status words (`linked `, `copied `, `done   `).
export function formatSetupHeading(command: SetupCommand): string {
  return `setup  ${command.command}`;
}

// The warning for a guarded command that succeeded without creating its
// `--if-missing` path. The guard is resolved from the folder the command runs
// in: the clone for a member's or a project's line, the workspace folder for a
// group's line.
export function formatSetupGuardMissing(command: SetupCommand, project?: string): string {
  return `warning: ${project === undefined ? '' : `in ${project}, `}${command.ifMissing} is still missing after \`${command.command}\` succeeded, so it will run again on every setup; the guard and the command both start from the folder the command runs in`;
}

// The line for a command whose `--if-missing` path exists.
export function formatSetupSkip(command: SetupCommand): string {
  return `skip   setup ${command.command} (${command.ifMissing} exists)`;
}

// The line `add` prints instead of running anything when --no-setup or
// WORKLER_NO_SETUP skipped `count` declared commands (`reason` names which).
export function formatSetupSkipped(count: number, reason: string): string {
  return `skip   setup (${count} command${count === 1 ? '' : 's'}, ${reason})`;
}

// The `add --dry-run` line for a command.
export function formatSetupPlan(command: SetupCommand): string {
  const guard = command.ifMissing === undefined ? '' : ` (only if ${command.ifMissing} is missing)`;
  return `would  setup ${command.command}${guard}`;
}
