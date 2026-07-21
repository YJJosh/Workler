import { WORKSPACES_DIR } from '../constants';
import { initProject } from '../core/project';
import { relativeToCwd } from '../fs-utils';
import { findGitTopLevel } from '../git';
import { assertNoArgs } from '../cli-utils';
import type { CliContext } from '../types';

export function initCommand(args: string[], context: CliContext): void {
  if (assertNoArgs(args, 'init', context)) return;

  const root = findGitTopLevel(process.cwd()) || process.cwd();
  const result = initProject(root);

  if (result.configCreated) {
    console.log(`created ${relativeToCwd(result.configPath)}`);
  } else {
    console.log(`exists  ${relativeToCwd(result.configPath)}`);
  }

  console.log(`ready   ${relativeToCwd(result.workspacesPath)}`);

  if (result.gitRepo && result.excludePath) {
    console.log(`ignored ${WORKSPACES_DIR}/ in ${relativeToCwd(result.excludePath)}`);
  } else {
    console.log('warning: current folder is not a git repo yet; wrote .gitignore instead of .git/info/exclude');
  }
}
