import { parseCommandArgs } from '../cli-utils';
import { MAIN_WORKSPACE_NAME, PACKAGE_NAME } from '../constants';
import { inspectProject } from '../core/project';
import { setupCommandCount, setupWorkspace } from '../core/setup';
import { memberPath, sourceBrokenReason } from '../groups';
import { findWorklerRoot, groupWorkspaceParent, parentProject, workspaceName } from '../workspaces';
import { printSetupSummary, setupCallbacks } from './rule-output';

function setupAndPrint(root: string, name: string): void {
  const outcome = setupWorkspace(root, name, setupCallbacks());
  printSetupSummary(outcome);
  if (setupCommandCount(outcome) > 0) {
    console.log(`done   ${name}`);
  }
}

export function setupCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} setup [name[/<project>]]`;
  const parsed = parseCommandArgs(args, {
    command: 'setup',
    usage,
    minPositionals: 0,
    maxPositionals: 1,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}`);
    return;
  }

  const root = findWorklerRoot(process.cwd());
  const name = parsed.positionals[0];
  if (name) {
    setupAndPrint(root, name);
    return;
  }

  // Bare `setup` inside a workspace uses its parent's .workler, like bare
  // `apply`. A group workspace folder runs every member's and the group's.
  const info = inspectProject(root);
  if (info.gitRepo) {
    const parent = parentProject(root);
    if (parent) {
      if (info.memberOf) {
        setupAndPrint(info.memberOf.group, `${info.memberOf.workspace}/${info.memberOf.project}`);
      } else {
        setupAndPrint(parent, workspaceName(root));
      }
      return;
    }
    if (info.memberOf) {
      // Refuse rather than run whatever .workler sits at a broken source path.
      const { group, project } = info.memberOf;
      const unusable = sourceBrokenReason(group, project) ?? 'not a usable repository';
      throw new Error(`source ${MAIN_WORKSPACE_NAME}/${project} is ${unusable}: ${memberPath(group, project)}`);
    }
  } else {
    const location = groupWorkspaceParent(root);
    if (location) {
      setupAndPrint(location.group, location.name);
      return;
    }
  }
  throw new Error('setup needs a workspace name when run from the main project');
}
