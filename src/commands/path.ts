import { resolveWorkspacePath } from '../core/list';
import { findWorklerRoot } from '../workspaces';
import type { CliContext } from '../types';

export function pathCommand(args: string[], context: CliContext): void {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(`usage: ${context.cliName} path <name>`);
    return;
  }
  if (args.length !== 1) {
    throw new Error(`usage: ${context.cliName} path <name>`);
  }

  const root = findWorklerRoot(process.cwd(), context.cliName);
  console.log(resolveWorkspacePath(root, args[0]));
}
