import path from 'node:path';
import { parseCommandArgs } from '../cli-utils';
import { MAIN_WORKSPACE_NAME, PACKAGE_NAME } from '../constants';
import { withProjectLock } from '../lock';
import { applyRules } from '../rules';
import {
  findWorklerRoot,
  findWorkspace,
  listWorkspaces,
  parentProject,
  setWorkspaceCopiesLinks,
  workspaceCopiesLinks,
} from '../workspaces';
import { printRuleResult, printRuleSummary } from './rule-output';

interface ApplyFlags {
  force: boolean;
  dryRun: boolean;
  // --copy-links / --no-copy-links; undefined keeps the workspace's own mode.
  copyLinks?: boolean;
}

function applyAndPrint(root: string, workspacePath: string, flags: ApplyFlags): void {
  const { force, dryRun } = flags;
  const copyLinks = flags.copyLinks ?? workspaceCopiesLinks(workspacePath);
  // Record the mode BEFORE applying: rules are not one transaction, and after
  // a conflict halfway through a plain re-run must keep converting instead of
  // tripping over the destinations that were already switched.
  if (flags.copyLinks !== undefined && !dryRun) {
    setWorkspaceCopiesLinks(workspacePath, flags.copyLinks);
  }
  const outcome = applyRules(root, workspacePath, { force, dryRun, copyLinks, onResult: printRuleResult });
  printRuleSummary(outcome);
}

export function applyCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} apply [name] [--all] [--copy-links | --no-copy-links] [--force] [--dry-run]`;
  const parsed = parseCommandArgs(args, {
    command: 'apply',
    usage,
    booleanFlags: ['--all', '--copy-links', '--no-copy-links', '--force', '--dry-run'],
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
  if (parsed.flags['copy-links'] === true && parsed.flags['no-copy-links'] === true) {
    throw new Error('apply cannot combine --copy-links with --no-copy-links');
  }
  const flags: ApplyFlags = {
    force,
    dryRun,
    copyLinks: parsed.flags['copy-links'] === true ? true : parsed.flags['no-copy-links'] === true ? false : undefined,
  };

  const root = findWorklerRoot(process.cwd());
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
        applyAndPrint(root, workspace.path, flags);
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
        applyAndPrint(parent, root, flags);
      });
      return;
    }
  }
  if (!name || name === MAIN_WORKSPACE_NAME) {
    throw new Error('apply needs a workspace name when run from the main project, or use --all');
  }

  runWithOptionalLock(root, `apply ${name}`, dryRun, () => {
    const workspace = findWorkspace(root, name);
    applyAndPrint(root, workspace.path, flags);
  });
}

function runWithOptionalLock(root: string, operation: string, dryRun: boolean, fn: () => void): void {
  if (dryRun) {
    fn();
  } else {
    withProjectLock(root, operation, fn);
  }
}
