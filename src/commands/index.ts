import { addCommand } from './add';
import { applyCommand } from './apply';
import { branchSyncCommand } from './branch-sync';
import { fetchCommand } from './fetch';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { syncCommand } from './sync';
import { initCommand } from './init';
import { listCommand } from './list';
import { pathCommand } from './path';
import { removeCommand } from './remove';
import { shellInitCommand } from './shell-init';
import { versionCommand } from './version';
import type { CliContext } from '../types';

export function runCommand(command: string | undefined, args: string[], context: CliContext): void {
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      helpCommand(context);
      break;
    case '-v':
    case '--version':
    case 'version':
      versionCommand();
      break;
    case 'init':
      initCommand(args, context);
      break;
    case 'add':
      addCommand(args, context);
      break;
    case 'apply':
      applyCommand(args, context);
      break;
    case 'list':
    case 'ls':
      listCommand(args, context);
      break;
    case 'path':
      pathCommand(args, context);
      break;
    case 'remove':
    case 'rm':
      removeCommand(args, context);
      break;
    case 'shell-init':
      shellInitCommand(args, context);
      break;
    case 'status':
      statusCommand(args, context);
      break;
    case 'fetch':
      fetchCommand(args, context);
      break;
    case 'sync':
      syncCommand(args, context);
      break;
    case 'branch-sync':
      branchSyncCommand(args, context);
      break;
    default:
      throw new Error(`unknown command: ${command}\nRun: ${context.cliName} help`);
  }
}
