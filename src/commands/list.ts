import { assertNoArgs } from '../cli-utils';
import { listWorkspaceInfos } from '../core/list';
import { findWorklerRoot } from '../workspaces';
import type { CliContext } from '../types';

export function listCommand(args: string[], context: CliContext): void {
  if (assertNoArgs(args, 'list', context)) return;
  const root = findWorklerRoot(process.cwd(), context.cliName);
  const rows = listWorkspaceInfos(root)
    // Plain directories under .worktrees/ have never shown up in `list`;
    // clones stay listed even when git cannot read them (branch shows '?').
    .filter((info) => info.isClone)
    .map((info) => ({
      name: info.name,
      branch: info.branch ?? info.shortHead ?? '?',
      path: info.path,
    }));

  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const branchWidth = Math.max(6, ...rows.map((row) => row.branch.length));

  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.branch.padEnd(branchWidth)}  ${row.path}`);
  }
}
