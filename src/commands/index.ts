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
import { PACKAGE_NAME } from '../constants';

export function runCommand(command: string | undefined, args: string[]): void {
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      helpCommand();
      break;
    case '-v':
    case '--version':
    case 'version':
      versionCommand();
      break;
    case 'init':
      initCommand(args);
      break;
    case 'add':
      addCommand(args);
      break;
    case 'apply':
      applyCommand(args);
      break;
    case 'list':
    case 'ls':
      listCommand(args);
      break;
    case 'path':
      pathCommand(args);
      break;
    case 'remove':
    case 'rm':
      removeCommand(args);
      break;
    case 'shell-init':
      shellInitCommand(args);
      break;
    case 'status':
      statusCommand(args);
      break;
    case 'fetch':
      fetchCommand(args);
      break;
    case 'sync':
      syncCommand(args);
      break;
    case 'branch-sync':
      branchSyncCommand(args);
      break;
    default:
      throw new Error(`unknown command: ${command}\nRun: ${PACKAGE_NAME} help`);
  }
}
