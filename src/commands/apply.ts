import path from 'node:path';
import { parseCommandArgs } from '../cli-utils';
import { readRules } from '../config';
import { MAIN_WORKSPACE_NAME, PACKAGE_NAME } from '../constants';
import { inspectProject, requireProject } from '../core/project';
import type { ProjectInfo } from '../core/project';
import { hasIndependentGitDirectory } from '../git';
import { memberPath, requireDeclaredProject, splitWorkspaceAddress } from '../groups';
import { withProjectLock } from '../lock';
import { applyRules } from '../rules';
import type { Workspace } from '../types';
import {
  findWorklerRoot,
  findWorkspace,
  groupWorkspaceParent,
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

interface ApplyTarget {
  // The workspace is a Git clone that remembers its copy-links mode. A group
  // workspace directory is not; it follows its members (copyLinksDefault).
  isRepo: boolean;
  copyLinksDefault?: boolean;
}

function applyAndPrint(root: string, workspacePath: string, flags: ApplyFlags, target: ApplyTarget): void {
  const { force, dryRun } = flags;
  const remembered = target.isRepo ? workspaceCopiesLinks(workspacePath) : target.copyLinksDefault === true;
  const copyLinks = flags.copyLinks ?? remembered;
  // Record the mode BEFORE applying: rules are not one transaction, and after
  // a conflict halfway through a plain re-run must keep converting instead of
  // tripping over the destinations that were already switched.
  if (target.isRepo && flags.copyLinks !== undefined && !dryRun) {
    setWorkspaceCopiesLinks(workspacePath, flags.copyLinks);
  }
  const outcome = applyRules(root, workspacePath, { force, dryRun, copyLinks, onResult: printRuleResult });
  printRuleSummary(outcome);
}

// Applies one workspace of `info`: the repository's rules for a plain
// project; for a group, every cloned member from its source repository and
// then the group's own rules into the workspace directory.
function applyWorkspace(info: ProjectInfo, workspace: Workspace, flags: ApplyFlags): void {
  if (!info.isGroup) {
    applyAndPrint(info.root, workspace.path, flags, { isRepo: true });
    return;
  }

  const cloned: string[] = [];
  for (const project of info.projects) {
    const member = memberPath(workspace.path, project);
    if (!hasIndependentGitDirectory(member)) {
      console.log(`project ${project}: skipped (not cloned)`);
      continue;
    }
    cloned.push(member);
    console.log(`project ${project}`);
    applyAndPrint(memberPath(info.root, project), member, flags, { isRepo: true });
  }

  if (readRules(info.root).length === 0) {
    return;
  }
  console.log('group rules');
  const copyLinksDefault = cloned.length > 0 && cloned.every((member) => workspaceCopiesLinks(member));
  applyAndPrint(info.root, workspace.path, flags, { isRepo: false, copyLinksDefault });
}

export function applyCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} apply [name[/<project>]] [--all] [--copy-links | --no-copy-links] [--force] [--dry-run]`;
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
    const info = requireProject(root);
    runWithOptionalLock(root, 'apply --all', dryRun, () => {
      const workspaces = listWorkspaces(root).filter((workspace) => workspace.name !== MAIN_WORKSPACE_NAME);
      if (workspaces.length === 0) {
        console.log('no workspaces found');
        return;
      }
      for (const workspace of workspaces) {
        console.log(`applying ${workspace.name}`);
        applyWorkspace(info, workspace, flags);
      }
    });
    return;
  }

  const name = parsed.positionals[0];
  if (!name) {
    // Bare `apply` inside a managed workspace refreshes the workspace itself
    // from its immediate parent's rules (nested workspaces refresh from the
    // enclosing workspace, not the outermost root). A member clone of a group
    // workspace refreshes from its source repository; the group workspace
    // directory itself refreshes every member and the group's rules.
    const info = inspectProject(root);
    if (info.gitRepo) {
      const parent = parentProject(root);
      if (parent) {
        runWithOptionalLock(parent, `apply ${path.basename(root)}`, dryRun, () => {
          applyAndPrint(parent, root, flags, { isRepo: true });
        });
        return;
      }
    } else {
      const location = groupWorkspaceParent(root);
      if (location) {
        const group = requireProject(location.group);
        runWithOptionalLock(group.root, `apply ${location.name}`, dryRun, () => {
          applyWorkspace(group, { name: location.name, path: location.path }, flags);
        });
        return;
      }
    }
  }

  const info = name ? requireProject(root) : undefined;
  const address = info?.isGroup ? splitWorkspaceAddress(name) : { workspace: name, project: undefined };
  if (!info || !address.workspace || address.workspace === MAIN_WORKSPACE_NAME) {
    throw new Error('apply needs a workspace name when run from the main project, or use --all');
  }

  runWithOptionalLock(root, `apply ${name}`, dryRun, () => {
    const workspace = findWorkspace(root, address.workspace);
    if (address.project === undefined) {
      applyWorkspace(info, workspace, flags);
      return;
    }
    const project = requireDeclaredProject(info.projects, address.project);
    const member = memberPath(workspace.path, project);
    if (!hasIndependentGitDirectory(member)) {
      throw new Error(`project ${project} is not cloned in workspace ${address.workspace}: ${member}`);
    }
    applyAndPrint(memberPath(root, project), member, flags, { isRepo: true });
  });
}

function runWithOptionalLock(root: string, operation: string, dryRun: boolean, fn: () => void): void {
  if (dryRun) {
    fn();
  } else {
    withProjectLock(root, operation, fn);
  }
}
