import fs from 'node:fs';
import path from 'node:path';
import { readConfig, readRules, readSetupCommands } from '../config';
import { CONFIG_FILE, PACKAGE_NAME, ROOT_REMOTE, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { addLineIfMissing, assertInside, canonicalPath } from '../fs-utils';
import { git, gitInfoExcludePath, gitMaybe, hasIndependentGitDirectory, isGitWorkTreeClean, localBranchExists } from '../git';
import { forProject, memberPath, sourceBrokenReason } from '../groups';
import { withProjectLocks } from '../lock';
import { validateBranchName, validateNewWorkspaceName, validateStartRef, validateWorkspaceRefName } from '../names';
import { applyRules } from '../rules';
import type { ApplyRulesOutcome, RuleApplyResult } from '../rules';
import type { SetupOutcome } from '../setup';
import type { SetupCommand } from '../types';
import { groupWorkspaceParent, setGroupWorkspaceCopiesLinks, setWorkspaceCopiesLinks } from '../workspaces';
import { lockRootsWithSourcesOf, requireProject } from './project';
import type { ProjectInfo } from './project';
import { runWorkspaceSetup, validateWorkspaceSetupOptions } from './setup';
import type { WorkspaceSetupOptions } from './setup';

export interface CreateWorkspaceOptions extends WorkspaceSetupOptions {
  name: string;
  /** Start of a new branch named `branch` or the workspace name: branch, tag or commit; origin/* also sets upstream. Not with `checkout`. */
  base?: string;
  /** Without `base`, an existing branch is reused or a new one starts at HEAD; with `base` it must be new. Not with `checkout`. */
  branch?: string;
  /** Existing ref to check out; tags and commits are detached. Not with `base` or `branch`. */
  checkout?: string;
  /** Replace conflicting rule destinations, like `add --force`. */
  force?: boolean;
  /** Copy what `link` rules would symlink; remembered for later `apply` runs. */
  copyLinks?: boolean;
  /** Run the .workler `setup` commands at the end (default true). A failure throws SETUP_COMMAND_FAILED and keeps the workspace. */
  setup?: boolean;
  /** Human-readable progress lines. */
  onProgress?: (message: string) => void;
  /** Called as each rule resolves. */
  onRuleResult?: (result: RuleApplyResult) => void;
}

/** Planned against the main project, so refs mean what the user sees there; run in the clone, where its branches are origin/*. */
export type CheckoutPlan =
  // startPoint: a sha resolved in the main project; absent means HEAD.
  // startPointLabel: the name the user typed.
  | { kind: 'create-branch'; branch: string; startPoint?: string; startPointLabel?: string; upstream?: string }
  // Upstream is copied only when the root's origin has the same branch.
  | { kind: 'checkout-branch'; branch: string; sha: string; upstream?: string; upstreamSha?: string }
  | { kind: 'detach'; sha: string; ref: string };

export interface MemberPlan {
  /** The declared project path (`projects/api`). */
  project: string;
  /** The source repository, <group>/<project>. */
  root: string;
  /** <group>/.worktrees/<name>/<project>. */
  target: string;
  checkout: CheckoutPlan;
  setup: SetupCommand[];
}

export interface WorkspacePlan {
  root: string;
  name: string;
  /** <root>/.worktrees/<name>. */
  target: string;
  /** Absent for a project group; see `projects`. */
  checkout?: CheckoutPlan;
  /** Project group only: one plan per declared project, in file order. */
  projects?: MemberPlan[];
  /** For a group: the group's own commands, which run after every member's. */
  setup: SetupCommand[];
  warnings: string[];
}

export interface MemberCreateResult {
  project: string;
  /** The source repository the member was cloned from. */
  root: string;
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
  rules: ApplyRulesOutcome;
  /** Undefined when `setup: false`. */
  setup?: SetupOutcome;
}

export interface CreateWorkspaceResult {
  name: string;
  path: string;
  root: string;
  /** Undefined when detached; for a group, set only when all members agree. */
  branch?: string;
  /** Full HEAD sha; absent for a group workspace. */
  head?: string;
  /** For a group: every member is detached. */
  detached: boolean;
  copyLinks: boolean;
  /** For a group: the group's own rules; members' rules are in `projects`. */
  rules: ApplyRulesOutcome;
  /** Project group only: one result per declared project, in file order. */
  projects?: MemberCreateResult[];
  /** For a group: the group's own commands. Undefined when `setup: false`. */
  setup?: SetupOutcome;
}

/** `details.workspace` on SETUP_COMMAND_FAILED: the created workspace without setup outcomes, for a retry with `setupWorkspace`. */
export type CreatedWorkspace = Omit<CreateWorkspaceResult, 'setup' | 'projects'> & {
  projects?: Omit<MemberCreateResult, 'setup'>[];
};

function createdWorkspace(result: CreateWorkspaceResult): CreatedWorkspace {
  const { setup: _setup, projects, ...rest } = result;
  if (projects === undefined) {
    return rest;
  }
  return { ...rest, projects: projects.map(({ setup: _memberSetup, ...member }) => member) };
}

function validateOptions(options: CreateWorkspaceOptions): void {
  if (!options || typeof options !== 'object') {
    throw new WorklerError('INVALID_OPTIONS', 'createWorkspace options must be an object');
  }
  if (typeof options.name !== 'string') {
    throw new WorklerError('INVALID_OPTIONS', 'workspace name must be a string');
  }
  for (const key of ['base', 'branch', 'checkout'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'string') {
      throw new WorklerError('INVALID_OPTIONS', `${key} must be a string when provided`);
    }
  }
  for (const key of ['force', 'copyLinks', 'setup'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new WorklerError('INVALID_OPTIONS', `${key} must be a boolean when provided`);
    }
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new WorklerError('INVALID_OPTIONS', 'onProgress must be a function when provided');
  }
  if (options.onRuleResult !== undefined && typeof options.onRuleResult !== 'function') {
    throw new WorklerError('INVALID_OPTIONS', 'onRuleResult must be a function when provided');
  }
  validateWorkspaceSetupOptions(options);

  if (options.branch && options.checkout) {
    throw new WorklerError('INVALID_OPTIONS', '--branch and --checkout cannot be used together');
  }
  if (options.base && options.checkout) {
    throw new WorklerError(
      'INVALID_OPTIONS',
      '[base] and --checkout cannot be used together (--checkout <ref> already names what to check out)',
    );
  }

  // Names and refs are validated before the clone exists, so a name git
  // rejects never leaves a clone on disk.
  validateNewWorkspaceName(options.name);
  if (options.branch !== undefined) {
    validateBranchName(options.branch, '--branch');
  }
  if (options.base !== undefined) {
    validateStartRef(options.base, 'base');
  }
  if (options.checkout !== undefined) {
    validateStartRef(options.checkout, '--checkout');
  }
  if (!options.branch && !options.checkout) {
    validateBranchName(options.name, 'workspace name (used as the branch name)');
  }
  validateWorkspaceRefName(options.name);
}

// Checked for group members too, so a group never accepts a repository that
// `add` would refuse directly.
function assertRepositoryDeclaresNoProjects(root: string): void {
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) {
    return;
  }
  if (readConfig(root).projects.length > 0) {
    throw new WorklerError(
      'CONFIG_INVALID',
      `${CONFIG_FILE} in a Git repository cannot declare "project" entries: ${root}\n` +
        'a project group is a plain folder (not a Git repository) that lists the repositories below it',
      { root },
    );
  }
}

function requireCloneableProject(rootInput: string): ProjectInfo {
  const info = requireProject(rootInput);
  if (info.gitRepo) {
    assertRepositoryDeclaresNoProjects(info.root);
    return info;
  }
  if (info.isGroup) {
    return info;
  }
  if (info.configError) {
    // Throws the original CONFIG_INVALID; inspectProject only kept the message.
    readConfig(info.root);
  }
  throw new WorklerError(
    'NOT_A_GIT_REPO',
    `${PACKAGE_NAME} add needs a git repository, or a project group (a ${CONFIG_FILE} with "project <path>" entries)`,
    { root: info.root },
  );
}

/** Plans without touching disk, for dry runs; createWorkspace re-plans under the lock. */
export function planWorkspaceCreation(rootInput: string, options: CreateWorkspaceOptions): WorkspacePlan {
  validateOptions(options);
  const info = requireCloneableProject(rootInput);
  return info.isGroup ? planGroupLocked(info.root, info.projects, options) : planLocked(info.root, options);
}

function workspaceTarget(root: string, name: string): string {
  const target = path.join(root, WORKSPACES_DIR, name);
  assertInside(path.join(root, WORKSPACES_DIR), target, 'workspace path escaped .worktrees');
  if (fs.existsSync(target)) {
    throw new WorklerError('WORKSPACE_EXISTS', `workspace already exists: ${target}`, { name, path: target });
  }
  return target;
}

function warnIfLinkedSource(root: string, warnings: string[], label: string): void {
  if (!hasIndependentGitDirectory(root)) {
    warnings.push(`${label} uses a linked Git directory; the offline removal history proof does not support this layout, so normal removal will refuse. Use an independent source checkout.`);
  }
}

function planLocked(root: string, options: CreateWorkspaceOptions): WorkspacePlan {
  const target = workspaceTarget(root, options.name);

  // A bad rule or ref fails here, before a clone could be left behind.
  applyRules(root, target, { force: options.force === true, copyLinks: options.copyLinks === true, dryRun: true });

  const checkout = planCheckout(root, options);

  const warnings: string[] = [];
  warnIfLinkedSource(root, warnings, 'source');
  if (!isGitWorkTreeClean(root)) {
    warnings.push('main project has uncommitted changes; the clone will only contain committed tracked files');
  }

  return { root, name: options.name, target, checkout, setup: readSetupCommands(root), warnings };
}

// All-or-nothing: a problem in any member fails before anything is cloned.
function planGroupLocked(root: string, projects: string[], options: CreateWorkspaceOptions): WorkspacePlan {
  const target = workspaceTarget(root, options.name);

  applyRules(root, target, { force: options.force === true, copyLinks: options.copyLinks === true, dryRun: true });

  const warnings: string[] = [];
  const members: MemberPlan[] = [];
  for (const project of projects) {
    const memberRoot = memberPath(root, project);
    const memberTarget = memberPath(target, project);
    forProject(project, () => {
      // A symlink on the way would make the group clone from, and sync into,
      // a repository elsewhere.
      const unusable = sourceBrokenReason(root, project);
      if (unusable !== undefined) {
        throw new WorklerError(
          'NOT_A_GIT_REPO',
          `declared project is ${unusable}: ${memberRoot}\n` +
            `put the repository there as a real folder, or fix the "project ${project}" line in ${CONFIG_FILE}`,
          { root: memberRoot, project },
        );
      }
      assertRepositoryDeclaresNoProjects(memberRoot);
      applyRules(memberRoot, memberTarget, { force: options.force === true, copyLinks: options.copyLinks === true, dryRun: true });
      const checkout = planCheckout(memberRoot, options);
      warnIfLinkedSource(memberRoot, warnings, project);
      if (!isGitWorkTreeClean(memberRoot)) {
        warnings.push(`${project} has uncommitted changes; its clone will only contain committed tracked files`);
      }
      members.push({ project, root: memberRoot, target: memberTarget, checkout, setup: readSetupCommands(memberRoot) });
    });
  }

  return { root, name: options.name, target, projects: members, setup: readSetupCommands(root), warnings };
}

export function createWorkspace(rootInput: string, options: CreateWorkspaceOptions): CreateWorkspaceResult {
  validateOptions(options);
  const info = requireCloneableProject(rootInput);
  const root = info.root;
  const progress = options.onProgress ?? (() => {});

  const result = withProjectLocks(lockRootsWithSourcesOf(info), `add ${options.name}`, () =>
    info.isGroup ? createGroupLocked(root, info.projects, options, progress) : createSingleLocked(root, options, progress),
  );

  // Setup can run for minutes, so it runs after the locks are released.
  if (options.setup !== false) {
    let outcome;
    try {
      outcome = runWorkspaceSetup(info, { name: result.name, path: result.path }, options);
    } catch (error) {
      if (error instanceof WorklerError && error.code === 'SETUP_COMMAND_FAILED') {
        throw new WorklerError(error.code, error.message, { ...error.details, workspace: createdWorkspace(result) });
      }
      throw error;
    }
    result.setup = outcome.setup;
    for (const member of outcome.projects ?? []) {
      const created = result.projects?.find((candidate) => candidate.project === member.project);
      if (created) {
        created.setup = member.setup;
      }
    }
  }
  return result;
}

function createSingleLocked(
  root: string,
  options: CreateWorkspaceOptions,
  progress: (message: string) => void,
): CreateWorkspaceResult {
  const plan = planLocked(root, options);
  for (const warning of plan.warnings) {
    progress(`warning: ${warning}`);
  }

  // A workspace hosting nested workspaces never ran `init`.
  addLineIfMissing(gitInfoExcludePath(root), `${WORKSPACES_DIR}/`);

  fs.mkdirSync(path.dirname(plan.target), { recursive: true });

  progress(`cloning ${root}`);
  progress(`     to ${plan.target}`);
  try {
    git(null, ['clone', '--local', root, plan.target]);
  } catch (error) {
    const partial = fs.existsSync(plan.target)
      ? '\nthe partial clone was left in place so you can inspect or remove it manually'
      : '';
    throw new WorklerError(
      'SETUP_FAILED',
      `clone failed for ${plan.target}: ${(error as Error).message}${partial}`,
      { name: options.name, path: plan.target, cause: (error as Error).message },
    );
  }

  let rules: ApplyRulesOutcome;
  try {
    executeCheckout(plan.target, plan.checkout as CheckoutPlan, progress);
    configureWorkspace(root, plan.target, options.name);
    if (options.copyLinks === true) {
      setWorkspaceCopiesLinks(plan.target, true);
    }
    rules = applyRules(root, plan.target, {
      force: options.force === true,
      copyLinks: options.copyLinks === true,
      dryRun: false,
      onResult: options.onRuleResult,
    });
  } catch (error) {
    throw new WorklerError(
      'SETUP_FAILED',
      `setup failed for ${plan.target}: ${(error as Error).message}\n` +
        'the clone was left in place so you can inspect or remove it manually',
      { name: options.name, path: plan.target, cause: (error as Error).message },
    );
  }

  const head = headState(plan.target);
  return {
    name: options.name,
    path: plan.target,
    root,
    ...head,
    copyLinks: options.copyLinks === true,
    rules,
  };
}

function headState(repo: string): { branch?: string; head?: string; detached: boolean } {
  const abbrev = gitMaybe(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const detached = !abbrev || abbrev === 'HEAD';
  return { branch: detached ? undefined : abbrev, head: gitMaybe(repo, ['rev-parse', 'HEAD']), detached };
}

// True for <group>/.worktrees/<name> of a group root, not a group that only sits in a folder named
// .worktrees. A parent whose .workler does not parse is no group root.
function isNestedGroupWorkspace(root: string): boolean {
  try {
    return groupWorkspaceParent(root) !== undefined;
  } catch {
    return false;
  }
}

// The copied .workler makes the workspace a group root of its own. A failure
// midway keeps the partial workspace for `remove --force`.
function createGroupLocked(
  root: string,
  projects: string[],
  options: CreateWorkspaceOptions,
  progress: (message: string) => void,
): CreateWorkspaceResult {
  const plan = planGroupLocked(root, projects, options);
  for (const warning of plan.warnings) {
    progress(`warning: ${warning}`);
  }

  // No info/exclude without a repository; .gitignore matters when the group
  // sits in an outer repository. A nested group workspace is ignored already.
  if (!isNestedGroupWorkspace(root)) {
    addLineIfMissing(path.join(root, '.gitignore'), `${WORKSPACES_DIR}/`);
  }

  fs.mkdirSync(plan.target, { recursive: true });
  fs.copyFileSync(path.join(root, CONFIG_FILE), path.join(plan.target, CONFIG_FILE));

  const results: MemberCreateResult[] = [];
  for (const member of plan.projects ?? []) {
    results.push(createMember(root, member, options, progress));
  }

  let rules: ApplyRulesOutcome;
  try {
    if (readRules(root).length > 0) {
      progress('group rules');
    }
    rules = applyRules(root, plan.target, {
      force: options.force === true,
      copyLinks: options.copyLinks === true,
      dryRun: false,
      onResult: options.onRuleResult,
    });
  } catch (error) {
    throw new WorklerError(
      'SETUP_FAILED',
      `setup failed for ${plan.target}: ${(error as Error).message}\n` +
        `the workspace was left in place so you can inspect it, or run \`${PACKAGE_NAME} remove ${options.name} --force\``,
      { name: options.name, path: plan.target, cause: (error as Error).message },
    );
  }

  const branches = new Set(results.map((result) => (result.detached ? undefined : result.branch)));
  const sameBranch = branches.size === 1 && !results[0].detached;
  return {
    name: options.name,
    path: plan.target,
    root,
    branch: sameBranch ? results[0].branch : undefined,
    detached: results.every((result) => result.detached),
    copyLinks: options.copyLinks === true,
    rules,
    projects: results,
  };
}

function createMember(
  group: string,
  member: MemberPlan,
  options: CreateWorkspaceOptions,
  progress: (message: string) => void,
): MemberCreateResult {
  const leftInPlace = `the partial workspace was left in place so you can inspect it, or run \`${PACKAGE_NAME} remove ${options.name} --force\``;
  fs.mkdirSync(path.dirname(member.target), { recursive: true });

  progress(`project ${member.project}`);
  progress(`cloning ${member.root}`);
  progress(`     to ${member.target}`);
  try {
    git(null, ['clone', '--local', member.root, member.target]);
  } catch (error) {
    throw new WorklerError(
      'SETUP_FAILED',
      `${member.project}: clone failed for ${member.target}: ${(error as Error).message}\n${leftInPlace}`,
      { name: options.name, path: member.target, project: member.project, cause: (error as Error).message },
    );
  }

  let rules: ApplyRulesOutcome;
  try {
    executeCheckout(member.target, member.checkout, progress);
    configureWorkspace(member.root, member.target, options.name);
    git(member.target, ['config', '--local', 'workler.group', canonicalPath(group)]);
    git(member.target, ['config', '--local', 'workler.groupProject', member.project]);
    if (options.copyLinks === true) {
      setWorkspaceCopiesLinks(member.target, true);
      // The group folder has no git config, so each member remembers its mode.
      setGroupWorkspaceCopiesLinks([member.target], true);
    }
    rules = applyRules(member.root, member.target, {
      force: options.force === true,
      copyLinks: options.copyLinks === true,
      dryRun: false,
      onResult: options.onRuleResult,
    });
  } catch (error) {
    throw new WorklerError(
      'SETUP_FAILED',
      `${member.project}: setup failed for ${member.target}: ${(error as Error).message}\n${leftInPlace}`,
      { name: options.name, path: member.target, project: member.project, cause: (error as Error).message },
    );
  }

  return { project: member.project, root: member.root, path: member.target, ...headState(member.target), rules };
}

function planCheckout(root: string, options: CreateWorkspaceOptions): CheckoutPlan {
  // --checkout never creates a branch.
  if (options.checkout) {
    const existing = planExistingBranch(root, options.checkout);
    if (existing) {
      return existing;
    }
    const sha = revParseCommit(root, options.checkout);
    if (sha === undefined) {
      throw new WorklerError(
        'BAD_REF',
        `--checkout ${options.checkout}: not a branch, tag, or commit in the main project`,
        { ref: options.checkout },
      );
    }
    return { kind: 'detach', sha, ref: options.checkout };
  }

  // `add <name> <base> --branch <branch>`, for branch names with "/".
  if (options.branch && options.base) {
    if (
      localBranchExists(root, options.branch) ||
      revParseCommit(root, `refs/remotes/origin/${options.branch}`) !== undefined
    ) {
      throw branchExistsError(options.branch);
    }
    return planNewBranchFromBase(root, options.branch, options.base);
  }

  if (options.branch) {
    return planExistingBranch(root, options.branch) ?? { kind: 'create-branch', branch: options.branch };
  }

  const branch = options.name;
  if (localBranchExists(root, branch) || revParseCommit(root, `refs/remotes/origin/${branch}`) !== undefined) {
    throw branchExistsError(branch);
  }
  if (!options.base) {
    return { kind: 'create-branch', branch };
  }
  return planNewBranchFromBase(root, branch, options.base);
}

function branchExistsError(branch: string): WorklerError {
  return new WorklerError(
    'BRANCH_EXISTS',
    `branch "${branch}" already exists; use --checkout ${branch} to put this workspace on the existing branch, ` +
      'or --branch <other> to pick a different branch name',
    { branch },
  );
}

function planNewBranchFromBase(root: string, branch: string, base: string): CheckoutPlan {
  // Only origin/* bases track: other remotes are not carried into the clone.
  const remoteSha = revParseCommit(root, `refs/remotes/${base}`);
  if (remoteSha !== undefined) {
    const upstream = base.startsWith('origin/') ? base : undefined;
    return { kind: 'create-branch', branch, startPoint: remoteSha, startPointLabel: base, upstream };
  }
  const sha = revParseCommit(root, base);
  if (sha === undefined) {
    throw new WorklerError(
      'BAD_REF',
      `base "${base}" is not a branch, tag, or commit in the main project`,
      { ref: base },
    );
  }
  return { kind: 'create-branch', branch, startPoint: sha, startPointLabel: base };
}

// Local in the main project, or on its origin (then a tracking branch is created).
function planExistingBranch(root: string, branch: string): CheckoutPlan | undefined {
  // origin/HEAD usually exists, but --checkout HEAD or @ must detach.
  if (branch === 'HEAD' || branch === '@') {
    return undefined;
  }
  const localSha = revParseCommit(root, `refs/heads/${branch}`);
  if (localSha !== undefined) {
    const upstreamSha = revParseCommit(root, `refs/remotes/origin/${branch}`);
    return {
      kind: 'checkout-branch',
      branch,
      sha: localSha,
      upstream: upstreamSha === undefined ? undefined : `origin/${branch}`,
      upstreamSha,
    };
  }
  const sha = revParseCommit(root, `refs/remotes/origin/${branch}`);
  if (sha !== undefined) {
    return { kind: 'create-branch', branch, startPoint: sha, startPointLabel: `origin/${branch}`, upstream: `origin/${branch}` };
  }
  return undefined;
}

function executeCheckout(repo: string, plan: CheckoutPlan, progress: (message: string) => void): void {
  if (plan.kind === 'checkout-branch') {
    const tracking = plan.upstream ? ` (tracking ${plan.upstream})` : '';
    progress(`checkout branch ${plan.branch}${tracking}`);
    if (localBranchExists(repo, plan.branch)) {
      git(repo, ['checkout', plan.branch]);
      // Pin to the planned sha in case the source moved during the clone.
      git(repo, ['reset', '--hard', plan.sha]);
    } else {
      // Not from clone --local's synthetic origin/<branch>.
      git(repo, ['checkout', '--no-track', '-b', plan.branch, plan.sha]);
    }
    if (plan.upstream && plan.upstreamSha) {
      git(repo, ['config', `branch.${plan.branch}.remote`, 'origin']);
      git(repo, ['config', `branch.${plan.branch}.merge`, `refs/heads/${plan.upstream.slice('origin/'.length)}`]);
      git(repo, ['update-ref', `refs/remotes/${plan.upstream}`, plan.upstreamSha]);
    } else {
      // Drop clone --local's synthetic origin tracking.
      gitMaybe(repo, ['config', '--unset-all', `branch.${plan.branch}.remote`]);
      gitMaybe(repo, ['config', '--unset-all', `branch.${plan.branch}.merge`]);
    }
    return;
  }

  if (plan.kind === 'detach') {
    progress(`checkout ${plan.ref} (detached HEAD, not on a branch)`);
    git(repo, ['checkout', '--detach', plan.sha]);
    return;
  }

  const tracking = plan.upstream ? ` (tracking ${plan.upstream})` : '';
  if (plan.startPoint) {
    progress(`create branch ${plan.branch} from ${plan.startPointLabel}${tracking}`);
    git(repo, ['checkout', '--no-track', '-b', plan.branch, plan.startPoint]);
  } else {
    progress(`create branch ${plan.branch} from HEAD`);
    git(repo, ['checkout', '-b', plan.branch]);
  }
  if (plan.upstream) {
    // Via config: the upstream ref may not exist in the clone yet.
    git(repo, ['config', `branch.${plan.branch}.remote`, 'origin']);
    git(repo, ['config', `branch.${plan.branch}.merge`, `refs/heads/${plan.upstream.slice('origin/'.length)}`]);
    if (plan.startPoint) {
      // clone --local made origin/* from the main project's local branches;
      // pin the real remote state so status shows no bogus ahead/behind.
      git(repo, ['update-ref', `refs/remotes/${plan.upstream}`, plan.startPoint]);
    }
  }
}

function revParseCommit(repo: string, ref: string): string | undefined {
  return gitMaybe(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

function configureWorkspace(root: string, target: string, name: string): void {
  // The immediate parent: for a nested workspace, the enclosing workspace.
  const canonicalRoot = canonicalPath(root);
  git(target, ['config', '--local', 'workler.root', canonicalRoot]);
  git(target, ['config', '--local', 'workler.name', name]);

  // Clones do not inherit .git/info/exclude, and may host nested workspaces.
  addLineIfMissing(gitInfoExcludePath(target), `${WORKSPACES_DIR}/`);

  // `clone --local` points origin at the main checkout, so `push origin` would push into it: inherit
  // the main project's real origin, or have none. The way back is always the workler-root remote.
  const rootOriginUrls = gitConfigValues(root, 'remote.origin.url').map((url) => inheritedRemoteUrl(root, url));
  const rootRemotes = gitMaybe(root, ['remote']);
  if (rootRemotes === undefined) {
    throw new Error('git could not list remotes in the main project');
  }
  const rootHasOrigin = rootRemotes.split('\n').includes('origin');
  if (rootOriginUrls.length > 0) {
    setGitConfigValues(target, 'remote.origin.url', rootOriginUrls);
    // Without the pushurl, pushes would go to the fetch URL.
    const pushUrls = gitConfigValues(root, 'remote.origin.pushurl').map((url) => inheritedRemoteUrl(root, url));
    setGitConfigValues(target, 'remote.origin.pushurl', pushUrls);
    reconcileOriginRefs(root, target);
  } else if (rootHasOrigin) {
    throw new Error('the main project has an origin remote but it has no URL');
  } else if (gitMaybe(target, ['remote', 'get-url', 'origin']) !== undefined) {
    git(target, ['remote', 'remove', 'origin']);
  }
  setRemote(target, ROOT_REMOTE, canonicalRoot);
}

// Replaces clone --local's origin/* (made from the source's local branches)
// with the root's real origin refs, offline.
function reconcileOriginRefs(root: string, target: string): void {
  const prefix = 'refs/remotes/origin/';
  const refs = (repo: string): Map<string, string> => {
    const output = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    const result = new Map<string, string>();
    for (const line of output.split('\n').filter(Boolean)) {
      const separator = line.lastIndexOf(' ');
      const ref = line.slice(0, separator);
      if (ref !== `${prefix}HEAD`) {
        result.set(ref, line.slice(separator + 1));
      }
    }
    return result;
  };

  const desired = refs(root);
  for (const ref of refs(target).keys()) {
    git(target, ['update-ref', '--no-deref', '-d', ref]);
  }
  // origin/HEAD is symbolic and handled on its own.
  gitMaybe(target, ['update-ref', '--no-deref', '-d', `${prefix}HEAD`]);
  for (const [ref, sha] of desired) {
    git(target, ['update-ref', ref, sha]);
  }
  const rootHead = gitMaybe(root, ['symbolic-ref', '--quiet', `${prefix}HEAD`]);
  if (rootHead && desired.has(rootHead)) {
    git(target, ['symbolic-ref', `${prefix}HEAD`, rootHead]);
  }

  // Keep the cloned branch's tracking only when its upstream really exists.
  const branches = git(target, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']);
  for (const branch of branches.split('\n').filter(Boolean)) {
    if (gitMaybe(target, ['config', '--get', `branch.${branch}.remote`]) !== 'origin') {
      continue;
    }
    const merge = gitMaybe(target, ['config', '--get', `branch.${branch}.merge`]);
    const upstreamRef = merge?.startsWith('refs/heads/')
      ? `${prefix}${merge.slice('refs/heads/'.length)}`
      : undefined;
    if (!upstreamRef || !desired.has(upstreamRef)) {
      gitMaybe(target, ['config', '--unset-all', `branch.${branch}.remote`]);
      gitMaybe(target, ['config', '--unset-all', `branch.${branch}.merge`]);
    }
  }
}

function gitConfigValues(repo: string, key: string): string[] {
  const output = gitMaybe(repo, ['config', '--null', '--get-all', key]);
  return output === undefined ? [] : output.split('\0').filter((value) => value.length > 0);
}

function setGitConfigValues(repo: string, key: string, values: string[]): void {
  // --unset-all fails when the key is absent, which is fine here.
  gitMaybe(repo, ['config', '--unset-all', key]);
  for (const value of values) {
    git(repo, ['config', '--add', key, value]);
  }
}

function inheritedRemoteUrl(root: string, url: string): string {
  if (
    path.isAbsolute(url) ||
    url.startsWith('~') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || // https://, ssh://, file://, ...
    /^[A-Za-z][A-Za-z0-9+.-]*::/.test(url) || // ext:: and other remote helpers
    /^(?:[^/\\@]+@)?(?:\[[^\]]+\]|[^/\\:]+):/.test(url) // scp-style host:path (including bracketed IPv6)
  ) {
    return url;
  }
  // Git resolves a relative remote against each repository's working tree,
  // and the clone lives elsewhere.
  return path.resolve(fs.realpathSync.native(root), url);
}

function setRemote(repo: string, name: string, url: string): void {
  const existing = gitMaybe(repo, ['remote', 'get-url', name]);
  if (existing === undefined) {
    git(repo, ['remote', 'add', name, url]);
  } else if (existing !== url) {
    git(repo, ['remote', 'set-url', name, url]);
  }
}
