import fs from 'node:fs';
import path from 'node:path';
import { MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { managedWorkspacePaths } from '../config';
import { gitMaybe, isGitWorkTreeFreeOfLocalData } from '../git';
import { groupWorkspaceExtras, memberPath, requireDeclaredProject, splitWorkspaceAddress } from '../groups';
import { listSyncTargets } from '../multi-git';
import { recordedSetupOutputs } from '../setup';
import type { SyncTarget } from '../multi-git';
import { findWorkspace } from '../workspaces';
import { requireProject } from './project';
import { WorklerError } from '../errors';
import { memberManagedPaths } from './remove';
import { targetHistory, type HistoryAssessment } from '../history';

/** A member clone of a group workspace, or a source repository for "main". */
export interface MemberInfo {
  /** The declared project path (`projects/api`). */
  project: string;
  path: string;
  isClone: boolean;
  broken?: string;
  branch?: string;
  head?: string;
  shortHead?: string;
  detached: boolean;
  clean?: boolean;
  /** Absent on main and un-cloned members; separate from `clean`. */
  history?: HistoryAssessment;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  /** The main project itself, always the first entry. */
  isMain: boolean;
  /** The directory has a .git entry; a group workspace counts once recognized (copied .workler or a cloned member). */
  isClone: boolean;
  /** Why the directory is not a usable clone; for a group, every broken member's reason. */
  broken?: string;
  /** Undefined when detached, unborn or broken; for a group, set only when all members agree. */
  branch?: string;
  /** Undefined when unborn or broken, and for group workspaces (see `projects`). */
  head?: string;
  shortHead?: string;
  detached: boolean;
  /**
   * Nothing modified, staged, untracked or ignored beyond what .workler rules and `setup --if-missing`
   * produce. File safety only: remove also needs `history.state === 'safe'`. Undefined when broken.
   */
  clean?: boolean;
  /** Absent on main and group folders (see `projects[].history`). */
  history?: HistoryAssessment;
  /** Only under a project group root. */
  projects?: MemberInfo[];
}

export interface ListWorkspacesOptions {
  /** Run the read-only history proofs, which can be slow. Default false. */
  history?: boolean;
}

/** The main project, every workspace, and broken entries (flagged, not hidden). */
export function listWorkspaceInfos(rootInput: string, options: ListWorkspacesOptions = {}): WorkspaceInfo[] {
  if (!options || typeof options !== 'object' || (options.history !== undefined && typeof options.history !== 'boolean')) {
    throw new WorklerError('INVALID_OPTIONS', 'listWorkspaces options must be an object with an optional boolean history');
  }
  const info = requireProject(rootInput);
  const targets = listSyncTargets(info.root);

  if (!info.isGroup) {
    return targets.map((target) => {
      const isMain = target.path === info.root;
      // The main checkout holds the rules' sources, not their outputs: nothing is exempt there.
      const managed = isMain ? [] : managedWorkspacePaths(info.root, target.path, recordedSetupOutputs(target.path, 'clone'));
      const history = options.history === true ? targetHistory(info.root, target) : undefined;
      return { name: target.name, isMain, ...inspectTarget(target, isMain, managed),
        ...(history === undefined ? {} : { history }) };
    });
  }

  // Under a group root each target is one member; fold them per workspace.
  const byName = new Map<string, SyncTarget[]>();
  for (const target of targets) {
    const members = byName.get(target.name) ?? [];
    members.push(target);
    byName.set(target.name, members);
  }

  return [...byName].map(([name, members]) => {
    const isMain = name === MAIN_WORKSPACE_NAME;
    const workspacePath = isMain ? info.root : path.join(info.root, WORKSPACES_DIR, name);
    const projects: MemberInfo[] = [];
    const brokenReasons: string[] = [];
    const groupManaged = isMain ? [] : managedWorkspacePaths(info.root, workspacePath, recordedSetupOutputs(workspacePath, 'folder'));
    for (const member of members) {
      if (member.project === undefined) {
        // A directory under .worktrees/ that is not a group workspace at all.
        brokenReasons.push(member.broken ?? 'not a group workspace');
        continue;
      }
      const details = inspectTarget(member, false, isMain ? [] : memberManagedPaths(info.root, member.project, member.path, groupManaged));
      // A foreign repository or a .git reached through a link is local data,
      // not the member clone.
      const history = options.history === true ? targetHistory(info.root, member) : undefined;
      const memberInfo: MemberInfo = { project: member.project, ...details, isClone: details.isClone && details.broken === undefined,
        ...(history === undefined ? {} : { history }) };
      projects.push(memberInfo);
      if (memberInfo.broken) {
        brokenReasons.push(`${member.project}: ${memberInfo.broken}`);
      }
    }

    const usable = projects.length > 0 && projects.every((project) => !project.broken);
    const branches = new Set(projects.map((project) => (project.detached ? undefined : project.branch)));
    const sameBranch = usable && branches.size === 1 && !projects[0].detached;
    const extras = isMain || !usable ? [] : groupWorkspaceExtras(workspacePath, info.root, info.projects, groupManaged);
    const strayClone = projects.length === 0 && fs.existsSync(path.join(workspacePath, '.git'));

    return {
      name,
      path: workspacePath,
      isMain,
      // Listed even with no member cloned (the first clone failed), so `list`
      // shows it as incomplete.
      isClone: isMain || strayClone || projects.length > 0,
      broken: brokenReasons.length > 0 ? brokenReasons.join('; ') : undefined,
      branch: sameBranch ? projects[0].branch : undefined,
      detached: usable && projects.every((project) => project.detached),
      clean: usable ? projects.every((project) => project.clean === true) && extras.length === 0 : undefined,
      projects,
    };
  });
}

type TargetDetails = Omit<WorkspaceInfo, 'name' | 'isMain' | 'projects'>;

function inspectTarget(target: SyncTarget, isMain: boolean, managedPaths: readonly string[]): TargetDetails {
  const isClone = isMain || fs.existsSync(path.join(target.path, '.git'));

  if (target.broken) {
    return { path: target.path, isClone, broken: target.broken, detached: false };
  }

  const abbrev = gitMaybe(target.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detached = !abbrev || abbrev === 'HEAD';
  return {
    path: target.path,
    isClone,
    branch: detached ? undefined : abbrev,
    head: gitMaybe(target.path, ['rev-parse', 'HEAD']),
    shortHead: gitMaybe(target.path, ['rev-parse', '--short', 'HEAD']),
    detached,
    clean: isGitWorkTreeFreeOfLocalData(target.path, managedPaths),
  };
}

/** "main" resolves to the root; under a group, `<name>/<project path>` is one member (`main/projects/api` is the source). */
export function resolveWorkspacePath(rootInput: string, name: string): string {
  const info = requireProject(rootInput);
  const address = info.isGroup ? splitWorkspaceAddress(name) : { workspace: name, project: undefined };
  const base = address.workspace === MAIN_WORKSPACE_NAME ? info.root : findWorkspace(info.root, address.workspace).path;
  if (address.project === undefined) {
    return base;
  }
  return memberPath(base, requireDeclaredProject(info.projects, address.project));
}
