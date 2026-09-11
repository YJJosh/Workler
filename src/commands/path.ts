import { PACKAGE_NAME } from '../constants';
import { resolveWorkspacePath } from '../core/list';
import { findWorklerRoot } from '../workspaces';

export function pathCommand(args: string[]): void {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(`usage: ${PACKAGE_NAME} path <name>`);
    return;
  }
  if (args.length !== 1) {
    throw new Error(`usage: ${PACKAGE_NAME} path <name>`);
  }

  const root = findWorklerRoot(process.cwd());
  console.log(resolveWorkspacePath(root, args[0]));
}
