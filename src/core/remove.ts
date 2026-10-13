import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { assertInside } from '../fs-utils';
import { managedWorkspacePaths, pathBelow } from '../config';
import { describeLocalData, displayPath, gitWorkTreeLocalData, LOCAL_DATA_SHOWN, type LocalDataEntry } from '../git';
import { ancestorReason, foreignMemberReason, groupWorkspaceExtras, inspectMember, memberPath, sourceBrokenReason } from '../groups';
import { withProjectLocks } from '../lock';
import { recordedSetupOutputs } from '../setup';
import { findWorkspace, validateWorkspaceName } from '../workspaces';
import { lockRootsOf, requireProject } from './project';

export interface RemoveWorkspaceOptions {
  // Remove even when the workspace has local changes.
  force?: boolean;
}

export interface RemoveWorkspaceResult {
  name: string;
  // The path that was removed.
  path: string;
}

export function removeWorkspace(
  rootInput: string,
  name: string,
  options: RemoveWorkspaceOptions = {},
): RemoveWorkspaceResult {
  if (typeof name !== 'string') {
    throw new WorklerError('INVALID_NAME', 'workspace name must be a string');
  }
  if (!options || typeof options !== 'object' || (options.force !== undefined && typeof options.force !== 'boolean')) {
    throw new WorklerError('INVALID_OPTIONS', 'removeWorkspace options must be an object with an optional boolean force');
  }
  // Before validateWorkspaceName, whose generic reserved-name error would
  // otherwise shadow this intent-specific message.
  if (name === MAIN_WORKSPACE_NAME) {
    throw new WorklerError('MAIN_WORKSPACE', 'refusing to remove main workspace');
  }
  validateWorkspaceName(name);

  const info = requireProject(rootInput);

  return withProjectLocks(lockRootsOf(info), `remove ${name}`, () => {
    const workspace = findWorkspace(info.root, name);

    if (options.force !== true) {
      if (info.isGroup) {
        const found = groupLocalData(workspace.path, info.root, info.projects);
        if (found.length > 0) {
          const lines = found.flatMap((item) => [`  ${item.reason}`, ...('entries' in item ? describeLocalData(item.entries).map((line) => `    ${line}`) : [])]);
          throw new WorklerError(
            'WORKSPACE_DIRTY',
            `workspace has local changes: ${workspace.path}\n` + lines.join('\n') + '\nUse --force to remove anyway.',
            { name, path: workspace.path, reasons: found.map((item) => item.reason) },
          );
        }
      } else {
        const managed = managedWorkspacePaths(info.root, workspace.path, recordedSetupOutputs(workspace.path, 'clone'));
        const entries = gitWorkTreeLocalData(workspace.path, managed, LOCAL_DATA_SHOWN + 1);
        if (entries === undefined || entries.length > 0) {
          throw new WorklerError(
            'WORKSPACE_DIRTY',
            `workspace has local changes: ${workspace.path}\n` +
              describeLocalData(entries).map((line) => `  ${line}`).join('\n') +
              '\nUse --force to remove anyway.',
            { name, path: workspace.path, ...(entries === undefined ? {} : { entries }) },
          );
        }
      }
    }

    assertInside(path.join(info.root, WORKSPACES_DIR), workspace.path, 'refusing to remove path outside .worktrees');
    fs.rmSync(workspace.path, { recursive: true, force: true });
    return { name, path: workspace.path };
  });
}

// Everything in a group workspace that deletion would destroy: a member with
// uncommitted, untracked or ignored files beyond what its source's rules
// produce, a member directory that is not a clone (unknown contents), and any
// entry neither a declared project nor the group's own rules account for,
// including the .workler copy once it no longer matches the group's file. A
// member that was never cloned holds nothing.
interface GroupLocalData {
  reason: string;
  // For a member clone with local data: what its working tree holds
  // (undefined inside when Git failed). Absent for the other reasons.
  entries?: LocalDataEntry[] | undefined;
}

function groupLocalData(workspacePath: string, groupRoot: string, projects: string[]): GroupLocalData[] {
  const reasons: GroupLocalData[] = [];
  // Entries the member loop explains: a link or file at a member path, or at
  // a folder on the way to one. The extras walk reports them too; skip those.
  const covered = new Set<string>();
  // What the group's own .workler produces in the folder: its rule outputs
  // and the guard paths its setup recorded, some of which may lie inside a
  // member.
  const groupManaged = managedWorkspacePaths(groupRoot, workspacePath, recordedSetupOutputs(workspacePath, 'folder'));
  for (const project of projects) {
    const member = memberPath(workspacePath, project);
    const check = inspectMember(workspacePath, project);
    if (check.state === 'missing') {
      continue;
    }
    covered.add(check.ancestor ?? project);
    if (check.state === 'link') {
      reasons.push({ reason: `${project}: ${ancestorReason(check) ?? 'a symbolic link, not a clone'}` });
      continue;
    }
    if (check.state === 'foreign') {
      reasons.push({ reason: `${project}: ${foreignMemberReason(project)}` });
      continue;
    }
    if (check.state !== 'clone') {
      reasons.push({ reason: `${project}: ${ancestorReason(check) ?? 'not a Git clone (unknown contents)'}` });
      continue;
    }
    const entries = gitWorkTreeLocalData(member, memberManagedPaths(groupRoot, project, member, groupManaged), LOCAL_DATA_SHOWN + 1);
    if (entries === undefined || entries.length > 0) {
      reasons.push({ reason: `${project}: uncommitted changes or untracked files`, entries });
    }
  }
  for (const extra of groupWorkspaceExtras(workspacePath, groupRoot, projects, groupManaged)) {
    if (covered.has(extra)) {
      continue;
    }
    reasons.push({ reason: extra === CONFIG_FILE ? configCopyReason(workspacePath) : `${displayPath(extra)}: not part of a declared project` });
  }
  return reasons;
}

// What a member clone's rules produce, read from its source repository, and
// what its guarded setup commands made, read from the clone's own record. A
// source that is missing, not a repository, or behind a symbolic link has no
// trustworthy .workler to read (nothing is followed), so none of that is
// exempt. `groupManaged` is what the group's own .workler produces in the
// workspace folder (see managedWorkspacePaths); a group guard path that
// lies inside this member (`projects/api/generated`, recorded by the group's
// setup) is the member's output too, relative to the clone (`generated`).
export function memberManagedPaths(groupRoot: string, project: string, member: string, groupManaged: readonly string[] = []): string[] {
  const own =
    sourceBrokenReason(groupRoot, project) === undefined
      ? managedWorkspacePaths(memberPath(groupRoot, project), member, recordedSetupOutputs(member, 'clone'))
      : [];
  const fromGroup = groupManaged.flatMap((managed) => {
    const below = pathBelow(managed, project);
    return below === undefined ? [] : [below];
  });
  return [...new Set([...own, ...fromGroup])];
}

// Why the workspace's .workler is local data rather than the generated copy
// (groupWorkspaceExtras already decided that it is).
function configCopyReason(workspacePath: string): string {
  try {
    const stat = fs.lstatSync(path.join(workspacePath, CONFIG_FILE));
    if (stat.isSymbolicLink()) {
      return `${CONFIG_FILE}: a symbolic link, not the generated copy of the group's ${CONFIG_FILE}`;
    }
    if (!stat.isFile()) {
      return `${CONFIG_FILE}: not a regular file, so not the generated copy of the group's ${CONFIG_FILE}`;
    }
  } catch (_) {
    // Unreadable: the generic wording below still holds.
  }
  return `${CONFIG_FILE}: differs from the group's ${CONFIG_FILE} (edited here, or the group's file changed after this workspace was created)`;
}
