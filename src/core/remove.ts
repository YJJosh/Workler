import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { assertInside } from '../fs-utils';
import { hasIndependentGitDirectory, isGitWorkTreeCleanIncludingIgnored } from '../git';
import { groupWorkspaceExtras, memberPath } from '../groups';
import { withProjectLock } from '../lock';
import { findWorkspace, validateWorkspaceName } from '../workspaces';
import { requireProject } from './project';

export interface RemoveWorkspaceOptions {
  // Remove even when the workspace has uncommitted changes.
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

  return withProjectLock(info.root, `remove ${name}`, () => {
    const workspace = findWorkspace(info.root, name);

    if (options.force !== true) {
      if (info.isGroup) {
        const reasons = groupLocalData(workspace.path, info.root, info.projects);
        if (reasons.length > 0) {
          throw new WorklerError(
            'WORKSPACE_DIRTY',
            `workspace has local changes: ${workspace.path}\n` +
              reasons.map((reason) => `  ${reason}`).join('\n') +
              '\nUse --force to remove anyway.',
            { name, path: workspace.path, reasons },
          );
        }
      } else if (!isGitWorkTreeCleanIncludingIgnored(workspace.path)) {
        throw new WorklerError(
          'WORKSPACE_DIRTY',
          `workspace has local changes: ${workspace.path}\nUse --force to remove anyway.`,
          { name, path: workspace.path },
        );
      }
    }

    assertInside(path.join(info.root, WORKSPACES_DIR), workspace.path, 'refusing to remove path outside .worktrees');
    fs.rmSync(workspace.path, { recursive: true, force: true });
    return { name, path: workspace.path };
  });
}

// Everything in a group workspace that deletion would destroy: a member with
// uncommitted or untracked (including ignored) files, a member directory that
// is not a clone (unknown contents), and any entry no declared project
// accounts for, including the .workler copy once it no longer matches the
// group's file. A member that was never cloned holds nothing.
function groupLocalData(workspacePath: string, groupRoot: string, projects: string[]): string[] {
  const reasons: string[] = [];
  for (const project of projects) {
    const member = memberPath(workspacePath, project);
    if (!fs.existsSync(member)) {
      continue;
    }
    if (!hasIndependentGitDirectory(member)) {
      reasons.push(`${project}: not a Git clone (unknown contents)`);
      continue;
    }
    if (!isGitWorkTreeCleanIncludingIgnored(member)) {
      reasons.push(`${project}: uncommitted changes or untracked files`);
    }
  }
  for (const extra of groupWorkspaceExtras(workspacePath, groupRoot, projects)) {
    reasons.push(
      extra === CONFIG_FILE
        ? `${CONFIG_FILE}: differs from the group's ${CONFIG_FILE} (edited here, or the group's file changed after this workspace was created)`
        : `${extra}: not part of a declared project`,
    );
  }
  return reasons;
}
