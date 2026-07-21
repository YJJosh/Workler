import path from 'node:path';
import { parseCommandArgs } from '../cli-utils';
import { MAIN_WORKSPACE_NAME } from '../constants';
import { withProjectLock } from '../lock';
import { applyRules } from '../rules';
import { findWorklerRoot, findWorkspace, listWorkspaces, parentProject } from '../workspaces';
import { printRuleResult, printRuleSummary } from './rule-output';
import type { CliContext } from '../types';

function applyAndPrint(root: string, workspacePath: string, force: boolean, dryRun: boolean): void {
  const outcome = applyRules(root, workspacePath, { force, dryRun, onResult: printRuleResult });
  printRuleSummary(outcome);
}

export function applyCommand(args: string[], context: CliContext): void {
  const usage = `${context.cliName} apply [name] [--all] [--force] [--dry-run]`;
  const parsed = parseCommandArgs(args, {
    command: 'apply',
    usage,
    booleanFlags: ['--all', '--force', '--dry-run'],
    minPositionals: 0,
    maxPositionals: 1,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}`);
    return;
  }

  const all = parsed.flags.all === true;
  const force = parsed.flags.force === true;
  const dryRun = parsed.flags['dry-run'] === true;
  if (all && parsed.positionals.length > 0) {
    throw new Error('apply cannot combine a name with --all');
  }

  const root = findWorklerRoot(process.cwd(), context.cliName);
  if (dryRun) {
    console.log('dry run: nothing will be changed');
  }

  if (all) {
    runWithOptionalLock(root, 'apply --all', dryRun, () => {
      const workspaces = listWorkspaces(root).filter((workspace) => workspace.name !== MAIN_WORKSPACE_NAME);
      if (workspaces.length === 0) {
        console.log('no workspaces found');
        return;
      }
      for (const workspace of workspaces) {
        console.log(`applying ${workspace.name}`);
        applyAndPrint(root, workspace.path, force, dryRun);
      }
    });
    return;
  }

  const name = parsed.positionals[0];
  if (!name) {
    // Bare `apply` inside a managed workspace refreshes the workspace itself
    // from its immediate parent's rules (nested workspaces refresh from the
    // enclosing workspace, not the outermost root).
    const parent = parentProject(root);
    if (parent) {
      runWithOptionalLock(parent, `apply ${path.basename(root)}`, dryRun, () => {
        applyAndPrint(parent, root, force, dryRun);
      });
      return;
    }
  }
  if (!name || name === MAIN_WORKSPACE_NAME) {
    throw new Error('apply needs a workspace name when run from the main project, or use --all');
  }

  runWithOptionalLock(root, `apply ${name}`, dryRun, () => {
    const workspace = findWorkspace(root, name);
    applyAndPrint(root, workspace.path, force, dryRun);
  });
}

function runWithOptionalLock(root: string, operation: string, dryRun: boolean, fn: () => void): void {
  if (dryRun) {
    fn();
  } else {
    withProjectLock(root, operation, fn);
  }
}
