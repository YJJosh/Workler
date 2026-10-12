import path from 'node:path';
import { parseCommandArgs } from '../cli-utils';
import { readRules } from '../config';
import { MAIN_WORKSPACE_NAME, PACKAGE_NAME } from '../constants';
import { inspectProject, lockRootsOf, lockRootsWithSourcesOf, mergeLockRoots, requireProject } from '../core/project';
import type { ProjectInfo } from '../core/project';
import { inspectMember, memberPath, notACloneReason, requireDeclaredProject, sourceBrokenReason, splitWorkspaceAddress } from '../groups';
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
  // --copy-links / --no-copy-links; undefined keeps the workspace's own mode.
  copyLinks?: boolean;
}

type ApplyTarget =
  // A Git clone remembers its own copy-links mode.
  | { isRepo: true }
  // A group workspace folder is not a clone; the mode of the group's own
  // rules is remembered in its cloned members (workler.groupCopyLinks).
  | { isRepo: false; members: string[] };

function applyAndPrint(root: string, workspacePath: string, flags: ApplyFlags, target: ApplyTarget): void {
  const { force, dryRun } = flags;
  const remembered = target.isRepo ? workspaceCopiesLinks(workspacePath) : groupWorkspaceCopiesLinks(target.members);
  const copyLinks = flags.copyLinks ?? remembered;
  // Record the mode BEFORE applying: rules are not one transaction, and after
  // a conflict halfway through a plain re-run must keep converting instead of
  // tripping over the destinations that were already switched.
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
    // The group's copy-links mode lives in the member clones, so with none
    // there is nowhere to record the mode the next apply must honour, and add
    // never reuses this folder, so the workspace can never gain a clone.
    console.log(`group rules: skipped (workspace ${workspace.name} has no member clone; remove it and run add again)`);
    return;
  }

  if (readRules(info.root).length === 0) {
    // No group-level rules yet: an explicit mode is still recorded, so a
    // group rule added later is materialized the way the user last asked.
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
    // Bare `apply` inside a managed workspace refreshes the workspace itself
    // from its immediate parent's rules (nested workspaces refresh from the
    // enclosing workspace, not the outermost root). A member clone of a group
    // workspace refreshes from its source repository; the group workspace
    // directory itself refreshes every member and the group's rules.
    const info = inspectProject(root);
    if (info.gitRepo) {
      const parent = parentProject(root);
      if (parent) {
        // A member clone of a group workspace changes under the group's locks
        // (the group's own and every enclosing group's), the ones
        // `apply <name>/<project>` and `remove <name>` take, so no two
        // group-level commands touch the clone at once. Its rules and copied
        // files come from the source repository, so that is locked too, as
        // an ordinary workspace's apply locks the repository it refreshes
        // from: a `sync` inside the source cannot then rewrite a file while
        // it is being copied. A workspace nested inside a member clone
        // changes under that clone's locks, which include the group's.
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
        // A member whose source is no longer a usable repository: missing,
        // not a repository, or behind a symbolic link (resolveParent then
        // leaves parent unset). Refreshing from whatever now sits at the
        // source path would apply a stranger's rules and copy its files into
        // the clone, so refuse, exactly as `apply <name>/<project>` does.
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
    const project = requireDeclaredProject(info.projects, address.project);
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
