import { readSetupCommands } from '../config';
import { MAIN_WORKSPACE_NAME } from '../constants';
import { WorklerError } from '../errors';
import {
  forProject,
  inspectMember,
  memberPath,
  notACloneReason,
  requireDeclaredProject,
  sourceBrokenReason,
  splitWorkspaceAddress,
} from '../groups';
import { runSetupCommands, settleGuards, validateSetupOptions } from '../setup';
import type { PendingGuard, SetupOptions, SetupOutcome } from '../setup';
import type { Workspace } from '../types';
import { findWorkspace, validateWorkspaceName } from '../workspaces';
import { requireProject } from './project';
import type { ProjectInfo } from './project';

export interface WorkspaceSetupOptions extends SetupOptions {
  /** Project group only: called before a member's commands run, with its source's command count or why it is skipped. */
  onProjectSetup?: (project: string, commandCount: number, skipped?: string) => void;
  /** Project group only. Called before the group's own commands run. */
  onGroupSetup?: (commandCount: number) => void;
}

export interface MemberSetupResult {
  project: string;
  /** The source repository whose .workler supplied the commands. */
  root: string;
  /** The member clone the commands ran in. */
  path: string;
  /** Why nothing ran; `setup` is then absent. */
  skipped?: string;
  setup?: SetupOutcome;
}

export interface WorkspaceSetupOutcome {
  /** For a group workspace: the group's own commands, run after every member's. */
  setup: SetupOutcome;
  /** Project group only: one entry per declared project, in file order. */
  projects?: MemberSetupResult[];
}

export interface SetupWorkspaceResult extends WorkspaceSetupOutcome {
  name: string;
  path: string;
  root: string;
  /** Set when one member was addressed (`feat/projects/api`); `path` is the clone, `root` its source. */
  project?: string;
}

export function validateWorkspaceSetupOptions(options: WorkspaceSetupOptions): void {
  validateSetupOptions(options);
  for (const key of ['onProjectSetup', 'onGroupSetup'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw new WorklerError('INVALID_OPTIONS', `${key} must be a function when provided`);
    }
  }
}

export function setupCommandCount(outcome: WorkspaceSetupOutcome): number {
  return outcome.setup.commandCount + (outcome.projects ?? []).reduce((sum, member) => sum + (member.setup?.commandCount ?? 0), 0);
}

// What `add --no-setup` reports as skipped. Broken sources are not counted.
export function declaredSetupCommandCount(info: ProjectInfo): number {
  let count = readSetupCommands(info.root).length;
  if (info.isGroup) {
    for (const project of info.projects) {
      if (sourceBrokenReason(info.root, project) === undefined) {
        count += readSetupCommands(memberPath(info.root, project)).length;
      }
    }
  }
  return count;
}

// Nothing is followed or guessed: a broken source has no trustworthy .workler.
function memberSkipReason(groupRoot: string, workspacePath: string, project: string): { reason: string; sourceBroken: boolean } | undefined {
  const check = inspectMember(workspacePath, project);
  if (check.state !== 'clone') {
    return { reason: notACloneReason(check, project), sourceBroken: false };
  }
  const unusable = sourceBrokenReason(groupRoot, project);
  if (unusable !== undefined) {
    return { reason: `source ${MAIN_WORKSPACE_NAME}/${project} is ${unusable}`, sourceBroken: true };
  }
  return undefined;
}

/**
 * For a group: every cloned member's commands in file order, then the group's; the first failure throws
 * SETUP_COMMAND_FAILED. Takes no lock: commands can run for minutes and must not block siblings.
 */
export function runWorkspaceSetup(info: ProjectInfo, workspace: Workspace, options: WorkspaceSetupOptions = {}): WorkspaceSetupOutcome {
  if (!info.isGroup) {
    return { setup: runSetupCommands({ root: info.root, path: workspace.path, name: workspace.name }, options) };
  }

  const group = { root: info.root, workspacePath: workspace.path };
  const projects: MemberSetupResult[] = [];
  // Guards are judged at the end: a group line may create a member's guard path.
  const pending: PendingGuard[] = [];
  for (const project of info.projects) {
    const source = memberPath(info.root, project);
    const member = memberPath(workspace.path, project);
    const skipped = memberSkipReason(info.root, workspace.path, project);
    if (skipped !== undefined) {
      options.onProjectSetup?.(project, 0, skipped.reason);
      projects.push({ project, root: source, path: member, skipped: skipped.reason });
      continue;
    }
    const setup = forProject(project, () => {
      options.onProjectSetup?.(project, readSetupCommands(source).length);
      return runSetupCommands({ root: source, path: member, name: workspace.name, group: { ...group, project } }, options, pending);
    });
    projects.push({ project, root: source, path: member, setup });
  }

  options.onGroupSetup?.(readSetupCommands(info.root).length);
  const setup = runSetupCommands({ root: info.root, path: workspace.path, name: workspace.name, group }, options, pending);
  settleGuards(pending, options);
  return { setup, projects };
}

/** Re-runs the `setup` commands in an existing workspace; under a group, `<name>/<project path>` runs one member's only. */
export function setupWorkspace(rootInput: string, name: string, options: WorkspaceSetupOptions = {}): SetupWorkspaceResult {
  if (typeof name !== 'string') {
    throw new WorklerError('INVALID_NAME', 'workspace name must be a string');
  }
  if (!options || typeof options !== 'object') {
    throw new WorklerError('INVALID_OPTIONS', 'setupWorkspace options must be an object');
  }
  validateWorkspaceSetupOptions(options);

  const info = requireProject(rootInput);
  const address = info.isGroup ? splitWorkspaceAddress(name) : { workspace: name, project: undefined };
  if (address.workspace === MAIN_WORKSPACE_NAME) {
    throw new WorklerError('MAIN_WORKSPACE', 'refusing to run setup commands in the main workspace');
  }
  validateWorkspaceName(address.workspace);
  const workspace = findWorkspace(info.root, address.workspace);

  if (address.project === undefined) {
    return { name: workspace.name, path: workspace.path, root: info.root, ...runWorkspaceSetup(info, workspace, options) };
  }

  const project = requireDeclaredProject(info.projects, address.project);
  const member = memberPath(workspace.path, project);
  const source = memberPath(info.root, project);
  const skipped = memberSkipReason(info.root, workspace.path, project);
  if (skipped !== undefined) {
    throw skipped.sourceBroken
      ? new WorklerError('NOT_A_GIT_REPO', `${skipped.reason}: ${source}`, { name: workspace.name, project, path: source })
      : new WorklerError('WORKSPACE_NOT_FOUND', `project ${project} in workspace ${workspace.name} is ${skipped.reason}: ${member}`, {
          name: workspace.name,
          project,
          path: member,
        });
  }
  const setup = forProject(project, () => {
    options.onProjectSetup?.(project, readSetupCommands(source).length);
    return runSetupCommands(
      {
        root: source,
        path: member,
        name: workspace.name,
        group: { root: info.root, workspacePath: workspace.path, project },
        // The retry must not widen one member's run into the whole group's.
        address: `${workspace.name}/${project}`,
      },
      options,
    );
  });
  return { name: workspace.name, path: member, root: source, project, setup };
}
