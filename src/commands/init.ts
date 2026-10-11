import { quoteConfigPath } from '../config';
import { CONFIG_FILE, WORKSPACES_DIR } from '../constants';
import { discoverProjects, initProject } from '../core/project';
import { WorklerError } from '../errors';
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
  const groupFolder = Boolean(gitRoot) && !isGitTopLevel(cwd) && (declaresProjects(cwd) || discoverProjects(cwd).length > 0);
  const root = gitRoot && !groupFolder ? gitRoot : cwd;
  const result = initProject(root);

  if (result.configCreated) {
    console.log(`created ${relativeToCwd(result.configPath)}`);
  } else {
    console.log(`exists  ${relativeToCwd(result.configPath)}`);
    if (result.configError) {
      console.log(`warning: ${relativeToCwd(result.configPath)} does not parse and was left as is: ${result.configError}`);
    }
  }
  for (const project of result.projects) {
    console.log(`project ${quoteConfigPath(project)}`);
  }
  for (const project of result.unwritableProjects) {
    console.log(`skipped ${project}: cannot be written to ${CONFIG_FILE} (a path may not hold both " and ', a backslash, or a line break); rename it to declare it`);
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

// Whether an existing .workler declares projects. One that does not parse is
// not a declaration: `initProject` leaves it alone and reports why, as it
// always has, instead of this lookup failing before any setup happens.
function declaresProjects(dir: string): boolean {
  try {
    return hasGroupConfig(dir);
  } catch (error) {
    if (error instanceof WorklerError && error.code === 'CONFIG_INVALID') return false;
    throw error;
  }
}
