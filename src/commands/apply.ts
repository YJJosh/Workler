import path from 'node:path';
import { parseCommandArgs } from '../cli-utils';
import { readRules } from '../config';
import { MAIN_WORKSPACE_NAME, PACKAGE_NAME } from '../constants';
import { inspectProject, lockRootsOf, lockRootsWithSourcesOf, mergeLockRoots, requireProject } from '../core/project';
import type { ProjectInfo } from '../core/project';
import { inspectMember, memberPath, notACloneReason, requireDeclaredProject, sourceBrokenReason, splitWorkspaceAddress, workspaceProjects } from '../groups';
import { withProjectLocks } from '../lock';
import { applyRules } from '../rules';
import type { Workspace } from '../types';
import {
  findWorklerRoot,
  findWorkspace,
  groupWorkspaceCopiesLinks,
  groupWorkspaceParent,
  listWorkspaces,
  parentProject,
  setGroupWorkspaceCopiesLinks,
  setWorkspaceCopiesLinks,
  workspaceCopiesLinks,
} from '../workspaces';
import { printRuleResult, printRuleSummary } from './rule-output';

interface ApplyFlags {
  force: boolean;
  dryRun: boolean;
  // Undefined keeps the workspace's remembered mode.
  copyLinks?: boolean;
}

type ApplyTarget =
  | { isRepo: true }
  // A group workspace folder has no git config; its mode lives in the
  // member clones (workler.groupCopyLinks).
  | { isRepo: false; members: string[] };

function applyAndPrint(root: string, workspacePath: string, flags: ApplyFlags, target: ApplyTarget): void {
  const { force, dryRun } = flags;
  const remembered = target.isRepo ? workspaceCopiesLinks(workspacePath) : groupWorkspaceCopiesLinks(target.members);
  const copyLinks = flags.copyLinks ?? remembered;
  // Record the mode before applying: rules are not one transaction, so a
  // re-run after a conflict halfway must keep converting.
  if (flags.copyLinks !== undefined && !dryRun) {
    if (target.isRepo) {
      setWorkspaceCopiesLinks(workspacePath, flags.copyLinks);
    } else {
      setGroupWorkspaceCopiesLinks(target.members, flags.copyLinks);
    }
  }
  const outcome = applyRules(root, workspacePath, { force, dryRun, copyLinks, onResult: printRuleResult });
  printRuleSummary(outcome);
}

// For a group: every cloned member from its source, then the group's rules.
function applyWorkspace(info: ProjectInfo, workspace: Workspace, flags: ApplyFlags): void {
  if (!info.isGroup) {
    applyAndPrint(info.root, workspace.path, flags, { isRepo: true });
    return;
  }

  const cloned: string[] = [];
  for (const project of workspaceProjects(workspace.path, info.projects)) {
    const member = memberPath(workspace.path, project);
    const check = inspectMember(workspace.path, project);
    if (check.state !== 'clone') {
      console.log(`project ${project}: skipped (${notACloneReason(check, project)})`);
      continue;
    }
    cloned.push(member);
    const unusable = sourceBrokenReason(info.root, project);
    if (unusable !== undefined) {
      console.log(`project ${project}: skipped (source ${MAIN_WORKSPACE_NAME}/${project} is ${unusable})`);
      continue;
    }
    console.log(`project ${project}`);
    applyAndPrint(memberPath(info.root, project), member, flags, { isRepo: true });
  }

  if (cloned.length === 0) {
    // With no member clone there is nowhere to record the copy-links mode,
    // and `add` never reuses this folder.
    console.log(`group rules: skipped (workspace ${workspace.name} has no member clone; remove it and run add again)`);
    return;
  }

  if (readRules(info.root).length === 0) {
    // Still record an explicit mode for group rules added later.
    if (flags.copyLinks !== undefined && !flags.dryRun) {
      setGroupWorkspaceCopiesLinks(cloned, flags.copyLinks);
    }
    return;
  }
  console.log('group rules');
  applyAndPrint(info.root, workspace.path, flags, { isRepo: false, members: cloned });
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
    runWithOptionalLock(lockRootsWithSourcesOf(info), 'apply --all', dryRun, () => {
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
    // Bare `apply` inside a workspace refreshes it from its immediate parent
    // (a nested workspace from the enclosing workspace, not the root).
    const info = inspectProject(root);
    if (info.gitRepo) {
      const parent = parentProject(root);
      if (parent) {
        // A member clone takes the group's locks, as `apply <name>/<project>` and `remove` do, plus the
        // source's, so a `sync` there cannot rewrite a file while it is copied.
        const lockRoots = info.memberOf
          ? mergeLockRoots(lockRootsOf(inspectProject(info.memberOf.group)), lockRootsOf(inspectProject(parent)))
          : lockRootsOf(inspectProject(parent));
        const label = info.memberOf ? `apply ${info.memberOf.workspace}/${info.memberOf.project}` : `apply ${path.basename(root)}`;
        runWithOptionalLock(lockRoots, label, dryRun, () => {
          applyAndPrint(parent, root, flags, { isRepo: true });
        });
        return;
      }
      if (info.memberOf) {
        // The source is missing, not a repository, or behind a symlink.
        // Refuse rather than apply whatever rules now sit at that path.
        const { group, project } = info.memberOf;
        const unusable = sourceBrokenReason(group, project) ?? 'not a usable repository';
        throw new Error(`source ${MAIN_WORKSPACE_NAME}/${project} is ${unusable}: ${memberPath(group, project)}`);
      }
    } else {
      const location = groupWorkspaceParent(root);
      if (location) {
        const group = requireProject(location.group);
        runWithOptionalLock(lockRootsWithSourcesOf(group), `apply ${location.name}`, dryRun, () => {
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

  runWithOptionalLock(lockRootsWithSourcesOf(info), `apply ${name}`, dryRun, () => {
    const workspace = findWorkspace(root, address.workspace);
    if (address.project === undefined) {
      applyWorkspace(info, workspace, flags);
      return;
    }
    const project = requireDeclaredProject(workspaceProjects(workspace.path, info.projects), address.project);
    const member = memberPath(workspace.path, project);
    const check = inspectMember(workspace.path, project);
    if (check.state !== 'clone') {
      throw new Error(`project ${project} in workspace ${address.workspace} is ${notACloneReason(check, project)}: ${member}`);
    }
    const source = memberPath(root, project);
    const unusable = sourceBrokenReason(root, project);
    if (unusable !== undefined) {
      throw new Error(`source ${MAIN_WORKSPACE_NAME}/${project} is ${unusable}: ${source}`);
    }
    applyAndPrint(source, member, flags, { isRepo: true });
  });
}

function runWithOptionalLock(roots: readonly string[], operation: string, dryRun: boolean, fn: () => void): void {
  if (dryRun) {
    fn();
  } else {
    withProjectLocks(roots, operation, fn);
  }
}
