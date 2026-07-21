import fs from 'node:fs';
import path from 'node:path';
import { MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { assertInside } from '../fs-utils';
import { isGitWorkTreeCleanIncludingIgnored } from '../git';
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

    if (options.force !== true && !isGitWorkTreeCleanIncludingIgnored(workspace.path)) {
      throw new WorklerError(
        'WORKSPACE_DIRTY',
        `workspace has local changes: ${workspace.path}\nUse --force to remove anyway.`,
        { name, path: workspace.path },
      );
    }

    assertInside(path.join(info.root, WORKSPACES_DIR), workspace.path, 'refusing to remove path outside .worktrees');
    fs.rmSync(workspace.path, { recursive: true, force: true });
    return { name, path: workspace.path };
  });
}
