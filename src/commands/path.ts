import { PACKAGE_NAME } from '../constants';
import { resolveWorkspacePath } from '../core/list';
import { findWorklerRoot } from '../workspaces';

export function pathCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} path <name>[/<project>]`;
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(`usage: ${usage}

Prints the absolute path of a workspace ("main" is the project itself).
Under a project group, <name>/<project path> prints one member of the
workspace, for example "feat/projects/api" or "main/projects/api".`);
    return;
  }
  if (args.length !== 1) {
    throw new Error(`usage: ${usage}`);
  }

  const root = findWorklerRoot(process.cwd());
  console.log(resolveWorkspacePath(root, args[0]));
}
