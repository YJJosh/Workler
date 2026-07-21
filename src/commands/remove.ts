import { parseCommandArgs } from '../cli-utils';
import { removeWorkspace } from '../core/remove';
import { findWorklerRoot } from '../workspaces';
import type { CliContext } from '../types';

export function removeCommand(args: string[], context: CliContext): void {
  const usage = `${context.cliName} remove <name> [--force]`;
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

  const root = findWorklerRoot(process.cwd(), context.cliName);
  const result = removeWorkspace(root, parsed.positionals[0], { force: parsed.flags.force === true });
  console.log(`removed ${result.name}`);
}
