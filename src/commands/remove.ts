import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { removeWorkspace } from '../core/remove';
import { findWorklerRoot } from '../workspaces';

export function removeCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} remove <name> [--force]`;
  const parsed = parseCommandArgs(args, {
    command: 'remove',
    usage,
    booleanFlags: ['--force'],
    minPositionals: 1,
    maxPositionals: 1,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Deletes a workspace only after file checks and an offline commit-preservation
proof against its source repository. Checks all refs, HEAD and reflogs, not
just the current branch. Source local branches/tags and detached HEAD count;
remote-tracking refs and branch-sync mirrors do not. Unknown blocks removal.
Run workler status for commit IDs and exact-commit import advice. Importing
history does not back up dirty, untracked or ignored files. Groups preflight
all members before deletion. Nonempty nested workspaces remain protected.
--force is destructive: bypasses file/history checks and saves nothing.`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  const result = removeWorkspace(root, parsed.positionals[0], { force: parsed.flags.force === true });
  console.log(`removed ${result.name}`);
}
