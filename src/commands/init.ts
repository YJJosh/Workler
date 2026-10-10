import { quoteConfigPath } from '../config';
import { CONFIG_FILE, WORKSPACES_DIR } from '../constants';
import { discoverProjects, initProject } from '../core/project';
import { relativeToCwd } from '../fs-utils';
import { findGitTopLevel, isGitTopLevel } from '../git';
import { hasGroupConfig } from '../groups';
import { assertNoArgs } from '../cli-utils';

export function initCommand(args: string[]): void {
  if (assertNoArgs(args, 'init')) return;

  const cwd = process.cwd();
  // Inside a repository, init the repository. A plain folder that holds
  // repositories (or already declares them) is a project group of its own,
  // even when some unrelated outer repository encloses it.
  const gitRoot = findGitTopLevel(cwd);
  const groupFolder = !isGitTopLevel(cwd) && (hasGroupConfig(cwd) || discoverProjects(cwd).length > 0);
  const root = gitRoot && !groupFolder ? gitRoot : cwd;
  const result = initProject(root);

  if (result.configCreated) {
    console.log(`created ${relativeToCwd(result.configPath)}`);
  } else {
    console.log(`exists  ${relativeToCwd(result.configPath)}`);
  }
  for (const project of result.projects) {
    console.log(`project ${quoteConfigPath(project)}`);
  }
  for (const project of result.unwritableProjects) {
    console.log(`skipped ${project}: cannot be written to ${CONFIG_FILE} (a path may not hold both " and ', or a line break); rename it to declare it`);
  }
  const undeclared = result.discoveredProjects.filter((project) => !result.projects.includes(project));
  if (!result.configCreated && undeclared.length > 0) {
    // Quoted exactly as the file needs them, so the lines paste as they are.
    console.log(`hint: Git repositories below this folder are not declared in ${CONFIG_FILE}; add these lines to manage them as a group:`);
    for (const project of undeclared) {
      console.log(`  project ${quoteConfigPath(project)}`);
    }
  }

  console.log(`ready   ${relativeToCwd(result.workspacesPath)}`);

  if (result.gitRepo && result.excludePath) {
    console.log(`ignored ${WORKSPACES_DIR}/ in ${relativeToCwd(result.excludePath)}`);
  } else if (result.projects.length > 0 && result.gitignorePath) {
    console.log(`ignored ${WORKSPACES_DIR}/ in ${relativeToCwd(result.gitignorePath)}`);
  } else {
    console.log('warning: current folder is not a git repo yet; wrote .gitignore instead of .git/info/exclude');
  }
}
