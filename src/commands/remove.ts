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
    console.log(`usage: ${usage}`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  const result = removeWorkspace(root, parsed.positionals[0], { force: parsed.flags.force === true });
  console.log(`removed ${result.name}`);
}
