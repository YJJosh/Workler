import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readSetupCommands } from './config';
import { PACKAGE_NAME } from './constants';
import { WorklerError } from './errors';
import { pathsReferToSameLocation } from './fs-utils';
import type { SetupCommand } from './types';

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
  // For 'skipped': the `--if-missing` path that exists.
  ifMissing?: string;
  // Exit code of the command; undefined when a signal ended it.
  exitCode?: number;
  // Signal that ended the command, when there was one.
  signal?: string;
}

export interface SetupOptions {
  // Called before each command starts so the CLI can print a heading.
  onSetupCommand?: (command: SetupCommand, index: number, total: number) => void;
  // Called instead for a command that is skipped because its `--if-missing`
  // path exists.
  onSetupSkip?: (command: SetupCommand, index: number, total: number) => void;
  // Where a command's stdout goes. 'inherit' (default) shares the caller's
  // stdout; 'stderr' keeps the caller's stdout free of command output, which
  // the CLI uses whenever its own stdout is not a terminal.
  setupStdout?: 'inherit' | 'stderr';
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
  for (const key of ['onSetupCommand', 'onSetupSkip'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw new WorklerError('INVALID_OPTIONS', `${key} must be a function when provided`);
    }
  }
  if (options.setupStdout !== undefined && options.setupStdout !== 'inherit' && options.setupStdout !== 'stderr') {
    throw new WorklerError('INVALID_OPTIONS', 'setupStdout must be "inherit" or "stderr" when provided');
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
// install into the wrong place or with the wrong settings.
const PACKAGE_MANAGER_VARIABLE = /^(npm_|pnpm_|yarn_)/i;
const INIT_CWD_VARIABLE = 'INIT_CWD';

function isPackageManagerVariable(name: string): boolean {
  return PACKAGE_MANAGER_VARIABLE.test(name) || name.toUpperCase() === INIT_CWD_VARIABLE;
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

export function runSetupCommands(target: SetupTarget, options: SetupOptions = {}): SetupOutcome {
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

    options.onSetupCommand?.(setup, index, commands.length);

    // The command is handed to the platform shell exactly as written in
    // .workler (sh -c on POSIX, cmd.exe on Windows), so committed setup lines
    // behave the same for every developer regardless of their login shell.
    const result = spawnSync(setup.command, {
      cwd: target.path,
      env,
      shell: true,
      stdio: ['inherit', options.setupStdout === 'stderr' ? process.stderr.fd : 'inherit', 'inherit'],
    });
    if (result.error) {
      throw new WorklerError(
        'SETUP_COMMAND_FAILED',
        `setup command could not be started in ${target.path}: ${setup.command}\n` +
          `  ${result.error.message}\n` +
          `the workspace was kept; ${retryHint(target.address ?? target.name)}`,
        { ...where, command: setup.command, index, commandCount: commands.length, results: outcome.results, cause: result.error.message },
      );
    }

    if (result.status === 0) {
      outcome.results.push({ command: setup.command, status: 'ok' });
      continue;
    }

    const exitCode = result.status ?? undefined;
    const signal = result.signal ?? undefined;
    outcome.results.push({ command: setup.command, status: 'failed', exitCode, signal });
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

  return outcome;
}

// `address` is what was run: a whole workspace, or one member of a group.
function retryHint(address: string): string {
  return `fix the problem and re-run \`${PACKAGE_NAME} setup ${address}\``;
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
