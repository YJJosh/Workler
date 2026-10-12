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
import { memberManagedPaths } from './remove';

// One member clone of a group workspace (or one source repository of the
// group itself, for the "main" entry).
export interface MemberInfo {
  // The declared project path (`projects/api`).
  project: string;
  path: string;
  isClone: boolean;
  broken?: string;
  branch?: string;
  head?: string;
  shortHead?: string;
  detached: boolean;
  clean?: boolean;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  // The main project itself (always the first entry).
  isMain: boolean;
  // The directory has a .git entry (false for leftovers under .worktrees/
  // that are not clones at all). For a group workspace: the directory is
  // recognized as one (its copied .workler or any cloned member), even while
  // every member is still missing.
  isClone: boolean;
  // Set when the directory is not a usable clone; human-readable reason. For
  // a group workspace: the reasons of every broken or missing member.
  broken?: string;
  // Current branch; undefined when detached, unborn, or broken. For a group
  // workspace: set only when every member is on that same branch.
  branch?: string;
  // Full and abbreviated HEAD commit sha; undefined when unborn or broken,
  // and for group workspaces (see `projects`).
  head?: string;
  shortHead?: string;
  detached: boolean;
  // No local changes: nothing modified, staged, untracked or ignored beyond
  // what the project's .workler rules produce (copy/link destinations,
  // `setup --if-missing` paths) and an empty .worktrees/. Matches the guard
  // `remove` uses, so for non-main workspaces clean === removable without
  // force. Undefined when broken.
  clean?: boolean;
  // Per-member details; only present under a project group root.
  projects?: MemberInfo[];
}

// Structured listing for the API: the main project, every workspace, and
// broken entries under .worktrees/ (flagged, not hidden).
export function listWorkspaceInfos(rootInput: string): WorkspaceInfo[] {
  const info = requireProject(rootInput);
  const targets = listSyncTargets(info.root);

  if (!info.isGroup) {
    return targets.map((target) => {
      const isMain = target.path === info.root;
      // The main checkout holds the rules' sources, not their outputs: nothing is exempt there.
      const managed = isMain ? [] : managedWorkspacePaths(info.root, recordedSetupOutputs(target.path, 'clone'));
      return { name: target.name, isMain, ...inspectTarget(target, isMain, managed) };
    });
  }

  // Under a group root every target is one member of one workspace; fold the
  // members back into one entry per workspace, in the order they were listed
  // (main first, then workspaces by name).
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
    for (const member of members) {
      if (member.project === undefined) {
        // A directory under .worktrees/ that is not a group workspace at all.
        brokenReasons.push(member.broken ?? 'not a group workspace');
        continue;
      }
      const details = inspectTarget(member, false, isMain ? [] : memberManagedPaths(info.root, member.project, member.path));
      // A member is a clone only when it is the member's usable clone: a
      // repository that is not the recorded one, or a .git reached through a
      // link, is local data (see broken), not the member.
      const memberInfo: MemberInfo = { project: member.project, ...details, isClone: details.isClone && details.broken === undefined };
      projects.push(memberInfo);
      if (memberInfo.broken) {
        brokenReasons.push(`${member.project}: ${memberInfo.broken}`);
      }
    }

    const usable = projects.length > 0 && projects.every((project) => !project.broken);
    const branches = new Set(projects.map((project) => (project.detached ? undefined : project.branch)));
    const sameBranch = usable && branches.size === 1 && !projects[0].detached;
    const extras = isMain || !usable ? [] : groupWorkspaceExtras(workspacePath, info.root, info.projects, managedWorkspacePaths(info.root, recordedSetupOutputs(workspacePath, 'folder')));
    const strayClone = projects.length === 0 && fs.existsSync(path.join(workspacePath, '.git'));

    return {
      name,
      path: workspacePath,
      isMain,
      // A recognized group workspace is listed even when no member has been
      // cloned yet (creation failed during the first clone): it still holds
      // the copied .workler, and `list` shows it as incomplete. Only entries
      // under .worktrees/ that are no group workspace at all are hidden.
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

// Absolute path of a workspace by name; "main" resolves to the root itself.
// Under a project group, `<name>/<project path>` resolves to one member of
// the workspace (`main/projects/api` is the source repository).
export function resolveWorkspacePath(rootInput: string, name: string): string {
  const info = requireProject(rootInput);
  const address = info.isGroup ? splitWorkspaceAddress(name) : { workspace: name, project: undefined };
  const base = address.workspace === MAIN_WORKSPACE_NAME ? info.root : findWorkspace(info.root, address.workspace).path;
  if (address.project === undefined) {
    return base;
  }
  return memberPath(base, requireDeclaredProject(info.projects, address.project));
}
