import { assertNoArgs } from '../cli-utils';
import { listWorkspaceInfos } from '../core/list';
import type { WorkspaceInfo } from '../core/list';
import { findWorklerRoot } from '../workspaces';

export function listCommand(args: string[]): void {
  if (assertNoArgs(args, 'list')) return;
  const root = findWorklerRoot(process.cwd());
  const rows = listWorkspaceInfos(root)
    // Plain directories are hidden; clones git cannot read still show, with '?'.
    .filter((info) => info.isClone)
    .map((info) => ({
      name: info.name,
      branch: branchColumn(info),
      path: info.path,
    }));

  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const branchWidth = Math.max(6, ...rows.map((row) => row.branch.length));

  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.branch.padEnd(branchWidth)}  ${row.path}`);
  }
}

// A group workspace gets one line; `status` shows the members.
function branchColumn(info: WorkspaceInfo): string {
  if (!info.projects) {
    return info.branch ?? info.shortHead ?? '?';
  }
  if (info.broken) {
    return 'incomplete';
  }
  if (info.detached) {
    return 'detached';
  }
  return info.branch ?? (info.projects.length > 0 ? 'mixed' : '?');
}
