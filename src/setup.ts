import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readSetupCommands } from './config';
import { PACKAGE_NAME, SETUP_OUTPUT_KEY, SETUP_RECORD_FILE } from './constants';
import { WorklerError } from './errors';
import { pathsReferToSameLocation } from './fs-utils';
import { git, gitConfigUnset, gitMaybeUntrimmed, hasIndependentGitDirectory } from './git';
import type { SetupCommand } from './types';

// Per stream, with `setupStdio: 'pipe'`.
const OUTPUT_BUFFER_LIMIT = 64 * 1024 * 1024;

// Commands run in file order through the platform shell. The first failure
// throws SETUP_COMMAND_FAILED; the workspace is not rolled back, so it can be
// inspected and `workler setup` re-runs the commands.

/** 'failed' appears only as the last entry of the error details; otherwise the run throws. */
export interface SetupCommandResult {
  command: string;
  /** 'skipped': the `--if-missing` path already existed. */
  status: 'ok' | 'skipped' | 'failed';
  /** The `--if-missing` path that existed, or that the command did not create. */
  ifMissing?: string;
  /** 'ok' only: the guard path is still missing, so the command runs on every setup. */
  guardMissing?: true;
  /** Undefined when a signal ended the command. */
  exitCode?: number;
  signal?: string;
  /** With `setupStdio: 'pipe'` only; possibly ''. */
  stdout?: string;
  stderr?: string;
}

export interface SetupOptions {
  /** Called before each command starts. */
  onSetupCommand?: (command: SetupCommand, index: number, total: number) => void;
  /** Called instead of onSetupCommand when the `--if-missing` path exists. */
  onSetupSkip?: (command: SetupCommand, index: number, total: number) => void;
  /** Called when a guarded command exited 0 without creating its path. */
  onSetupGuardMissing?: (command: SetupCommand, index: number, total: number, project?: string) => void;
  /**
   * Default 'inherit'. 'stderr' keeps the caller's stdout free of command
   * output. Only with setupStdio 'inherit'.
   */
  setupStdout?: 'inherit' | 'stderr';
  /**
   * Default 'inherit': shares stdin, stdout and stderr. 'pipe' closes stdin
   * and captures output, delivered to onSetupOutput and the result after
   * each command exits.
   */
  setupStdio?: 'inherit' | 'pipe';
  /** setupStdio 'pipe' only. Called once per stream with output, before any failure is thrown. */
  onSetupOutput?: (chunk: string, stream: 'stdout' | 'stderr', command: SetupCommand, index: number) => void;
}

export interface SetupOutcome {
  /** 0 when none are declared. */
  commandCount: number;
  results: SetupCommandResult[];
}

export interface SetupTarget {
  /** The project whose .workler lists the commands. */
  root: string;
  /** The directory the commands run in. */
  path: string;
  /** The workspace name (WORKLER_WORKSPACE). */
  name: string;
  /** Set for a group's own commands, and for a member's with `project`. */
  group?: { root: string; workspacePath: string; project?: string };
  /** What `workler setup` needs to repeat this run; default `name`. */
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
  // Would silently lose output or ignore an option.
  if (options.onSetupOutput !== undefined && options.setupStdio !== 'pipe') {
    throw new WorklerError('INVALID_OPTIONS', 'onSetupOutput needs setupStdio "pipe"');
  }
  if (options.setupStdio === 'pipe' && options.setupStdout === 'stderr') {
    throw new WorklerError('INVALID_OPTIONS', 'setupStdout "stderr" cannot be combined with setupStdio "pipe"');
  }
}

/**
 * Makes `add` act as with --no-setup. "0" and empty mean off. An explicit
 * `workler setup` ignores it.
 */
export const NO_SETUP_VARIABLE = 'WORKLER_NO_SETUP';

export function setupDisabledByEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[NO_SETUP_VARIABLE];
  return value !== undefined && value !== '' && value !== '0';
}

// Set by npm, pnpm and yarn for the scripts they run; inherited, they would
// make a setup `pnpm install` act on the caller's package. Case-sensitive:
// uppercase ones like NPM_CONFIG_REGISTRY or PNPM_HOME are user settings.
const PACKAGE_MANAGER_VARIABLE = /^(npm_|pnpm_|yarn_)/;
const INIT_CWD_VARIABLE = 'INIT_CWD';

function isPackageManagerVariable(name: string): boolean {
  return PACKAGE_MANAGER_VARIABLE.test(name) || name === INIT_CWD_VARIABLE;
}

/** The caller's environment without package-manager variables, plus WORKLER_*. */
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
  // Workler can be the caller (a member's command running `workler add`);
  // its group context must not leak into this run.
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

/**
 * A guard cannot tell the command's output from a user's folder at the same
 * path, so only paths a successful command left behind are recorded and
 * exempt from remove's local-data check. 'clone': git config; 'folder': a
 * file in a group workspace folder, which has no git config.
 */
export type SetupRecordKind = 'clone' | 'folder';

function recordKind(target: Pick<SetupTarget, 'group'>): SetupRecordKind {
  return target.group !== undefined && target.group.project === undefined ? 'folder' : 'clone';
}

/**
 * `id` is the lstat identity (device, inode, creation time) of what the
 * command left, so a later replacement by the user is not exempt. Stored as
 * `<id> <path>`, split at the first space so the path keeps its whitespace.
 */
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

// Of the link itself, not its target. Creation time tells a reused inode
// apart where the file system reports it (0 where not).
function entryIdentity(p: string): string | undefined {
  try {
    const stat = fs.lstatSync(p, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

/**
 * Recorded guard paths whose entry is still the one the command made. An
 * unreadable or foreign record, or a replaced entry, names nothing, so those
 * paths count as local data.
 */
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

/**
 * Undefined unless the file is a regular file with exactly the text Workler
 * writes; anything else there is the user's local data.
 */
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

function recordSetupOutput(target: SetupTarget, ifMissing: string, guardPath: string): void {
  const id = entryIdentity(guardPath);
  if (id === undefined) {
    return;
  }
  const kind = recordKind(target);
  // A .git file would reach some other repository's config.
  if (kind === 'clone' && !hasIndependentGitDirectory(target.path)) {
    return;
  }
  if (kind === 'folder' && entryExists(path.join(target.path, SETUP_RECORD_FILE)) && readSetupRecordFile(target.path) === undefined) {
    // The user's file (or dangling link) stays; the path goes unrecorded.
    return;
  }
  const recorded = readSetupRecord(target.path, kind);
  if (recorded.some((entry) => entry.path === ifMissing && entry.id === id)) {
    return;
  }
  writeRecord(target, kind, [...recorded.filter((entry) => entry.path !== ifMissing), { id, path: ifMissing }]);
}

// Called before a guarded command re-runs, so a run that fails half-way
// leaves no record for `remove` to trust. Success records the path again.
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

// Staged and renamed, so an interrupted write never leaves half a record.
function writeSetupRecord(dir: string, values: string[]): void {
  const file = path.join(dir, SETUP_RECORD_FILE);
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, serializeSetupRecord(values));
  fs.renameSync(staging, file);
}

/**
 * A guarded command that exited 0. Whether its path exists is judged once
 * every setup line has run, since a later or group line may change it.
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
 * Runs the workspace's setup lines. Pass `pending` to collect the guarded
 * commands that succeeded instead of settling them here, when more setup lines
 * run afterwards (see settleGuards).
 */
export function runSetupCommands(target: SetupTarget, options: SetupOptions = {}, pending?: PendingGuard[]): SetupOutcome {
  if (pathsReferToSameLocation(target.root, target.path)) {
    throw new WorklerError('INVALID_OPTIONS', 'refusing to run setup commands in the main workspace');
  }

  const commands = readSetupCommands(target.root);
  const outcome: SetupOutcome = { commandCount: commands.length, results: [] };
  const env = setupEnvironment(target);
  // core/setup.ts prefixes a member's message with its project path.
  const project = target.group?.project;
  const where = { name: target.name, path: target.path, ...(project === undefined ? {} : { project }) };
  const guards = pending ?? [];

  for (const [index, setup] of commands.entries()) {
    // Checked here, not by the shell, so the guard means the same everywhere.
    const guardPath = setup.ifMissing === undefined ? undefined : path.join(target.path, ...setup.ifMissing.split('/'));
    if (guardPath !== undefined && fs.existsSync(guardPath)) {
      options.onSetupSkip?.(setup, index, commands.length);
      outcome.results.push({ command: setup.command, status: 'skipped', ifMissing: setup.ifMissing });
      continue;
    }
    // A dangling link is absent to existsSync, but the command would collide
    // with it (pnpm fails on mkdir).
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

    if (setup.ifMissing !== undefined) {
      forgetSetupOutput(target, setup.ifMissing);
    }

    options.onSetupCommand?.(setup, index, commands.length);

    // sh -c on POSIX, cmd.exe on Windows, whatever the user's login shell.
    const piped = options.setupStdio === 'pipe';
    const result = spawnSync(setup.command, {
      cwd: target.path,
      env,
      shell: true,
      encoding: 'utf8',
      // Piped only. Past this Node kills the command (ENOBUFS), a failure.
      maxBuffer: OUTPUT_BUFFER_LIMIT,
      stdio: piped ? ['ignore', 'pipe', 'pipe'] : ['inherit', options.setupStdout === 'stderr' ? process.stderr.fd : 'inherit', 'inherit'],
    });
    // Handed over before any failure is thrown, so the caller can show why.
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
      // No result entry: the command never ran to an exit.
      throw new WorklerError(
        'SETUP_COMMAND_FAILED',
        `setup command ${overflow ? 'was stopped' : 'could not be started'} in ${target.path}: ${setup.command}\n` +
          `  ${cause}\n` +
          `the workspace was kept; ${retryHint(target.address ?? target.name)}`,
        { ...where, command: setup.command, index, commandCount: commands.length, results: outcome.results, cause },
      );
    }

    if (result.status === 0) {
      const done: SetupCommandResult = { command: setup.command, status: 'ok', ...output };
      outcome.results.push(done);
      if (setup.ifMissing !== undefined && guardPath !== undefined) {
        // Recorded so `remove` can tell it from something the user put there.
        if (fs.existsSync(guardPath)) {
          recordSetupOutput(target, setup.ifMissing, guardPath);
        }
        guards.push({ result: done, setup, index, total: commands.length, guardPath, ...(project === undefined ? {} : { project }) });
      }
      continue;
    }

    const exitCode = result.status ?? undefined;
    const signal = result.signal ?? undefined;
    outcome.results.push({ command: setup.command, status: 'failed', exitCode, signal, ...output });
    const reason = signal ? `terminated by signal ${signal}` : `exit code ${exitCode}`;
    // A plain re-run would skip a command that created its path, then died.
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

function retryHint(address: string): string {
  return `fix the problem and re-run \`${PACKAGE_NAME} setup ${address}\``;
}

// Dangling links included.
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// A symlink or Windows junction whose target is gone.
function isDanglingLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p);
  } catch {
    return false;
  }
}

export function formatSetupHeading(command: SetupCommand): string {
  return `setup  ${command.command}`;
}

export function formatSetupGuardMissing(command: SetupCommand, project?: string): string {
  return `warning: ${project === undefined ? '' : `in ${project}, `}${command.ifMissing} is still missing after \`${command.command}\` succeeded, so it will run again on every setup; the guard and the command both start from the folder the command runs in`;
}

export function formatSetupSkip(command: SetupCommand): string {
  return `skip   setup ${command.command} (${command.ifMissing} exists)`;
}

// `reason` names --no-setup or WORKLER_NO_SETUP.
export function formatSetupSkipped(count: number, reason: string): string {
  return `skip   setup (${count} command${count === 1 ? '' : 's'}, ${reason})`;
}

export function formatSetupPlan(command: SetupCommand): string {
  const guard = command.ifMissing === undefined ? '' : ` (only if ${command.ifMissing} is missing)`;
  return `would  setup ${command.command}${guard}`;
}
