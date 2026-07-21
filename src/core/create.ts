import fs from 'node:fs';
import path from 'node:path';
import { ROOT_REMOTE, WORKSPACES_DIR } from '../constants';
import { WorklerError } from '../errors';
import { addLineIfMissing, assertInside, canonicalPath } from '../fs-utils';
import { git, gitInfoExcludePath, gitMaybe, isGitWorkTreeClean, localBranchExists } from '../git';
import { withProjectLock } from '../lock';
import { validateBranchName, validateNewWorkspaceName, validateStartRef, validateWorkspaceRefName } from '../names';
import { applyRules } from '../rules';
import type { ApplyRulesOutcome, RuleApplyResult } from '../rules';
import { requireProject } from './project';
import type { ProjectInfo } from './project';

export interface CreateWorkspaceOptions {
  name: string;
  // Start point for a new branch (branch, tag, or commit; origin/* also
  // sets upstream tracking). Without `branch`, the new branch is named after
  // the workspace. With `branch`, that branch is created from this base.
  // Mutually exclusive with checkout.
  base?: string;
  // Branch to put the workspace on. Without `base`, an existing branch is
  // reused or a missing branch is created from HEAD. With `base`, the branch
  // must be new and is created from that ref. Mutually exclusive with checkout.
  branch?: string;
  // Existing ref to check out without creating a branch (tags/commits are
  // checked out detached). Mutually exclusive with base/branch.
  checkout?: string;
  // Replace conflicting rule destinations (same as `add --force`).
  force?: boolean;
  // Human-readable progress lines (the CLI prints these verbatim).
  onProgress?: (message: string) => void;
  // Per-rule results as they resolve (the CLI prints these incrementally).
  onRuleResult?: (result: RuleApplyResult) => void;
}

// What to do in the fresh clone. Planned against the MAIN project so refs mean
// what the user sees there; executed in the clone, where the main project's
// local branches appear as origin/* (only its HEAD branch exists locally) but
// every object is present.
export type CheckoutPlan =
  // Create a NEW branch. Without startPoint it starts at the clone's HEAD
  // (= the main project's current HEAD). startPoint is a commit sha resolved
  // in the main project; startPointLabel is the name the user typed.
  | { kind: 'create-branch'; branch: string; startPoint?: string; startPointLabel?: string; upstream?: string }
  // Checkout a branch that exists locally in the main project. `sha` is the
  // exact local tip; upstream state is copied only when the root's real
  // origin snapshot contains the same branch.
  | { kind: 'checkout-branch'; branch: string; sha: string; upstream?: string; upstreamSha?: string }
  // Checkout a tag/commit without a branch (detached HEAD).
  | { kind: 'detach'; sha: string; ref: string };

export interface WorkspacePlan {
  root: string;
  name: string;
  // Where the workspace will be created: <root>/.worktrees/<name>.
  target: string;
  checkout: CheckoutPlan;
  // Human-readable warnings (currently: main project has uncommitted changes).
  warnings: string[];
}

export interface CreateWorkspaceResult {
  name: string;
  path: string;
  root: string;
  // Branch checked out in the new workspace; undefined when detached.
  branch?: string;
  // Full commit sha of the workspace HEAD.
  head?: string;
  detached: boolean;
  rules: ApplyRulesOutcome;
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
  if (options.force !== undefined && typeof options.force !== 'boolean') {
    throw new WorklerError('INVALID_OPTIONS', 'force must be a boolean when provided');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new WorklerError('INVALID_OPTIONS', 'onProgress must be a function when provided');
  }
  if (options.onRuleResult !== undefined && typeof options.onRuleResult !== 'function') {
    throw new WorklerError('INVALID_OPTIONS', 'onRuleResult must be a function when provided');
  }

  if (options.branch && options.checkout) {
    throw new WorklerError('INVALID_OPTIONS', '--branch and --checkout cannot be used together');
  }
  if (options.base && options.checkout) {
    throw new WorklerError(
      'INVALID_OPTIONS',
      '[base] and --checkout cannot be used together (--checkout <ref> already names what to check out)',
    );
  }

  // Every name and ref is validated HERE, before planning touches the
  // repository and long before the clone exists. A branch name git rejects
  // used to surface only when `git checkout -b` ran inside the fresh clone,
  // which failed the operation but left the clone on disk.
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
  // Without --branch/--checkout the workspace name IS the new branch name, so
  // it has to satisfy git's ref rules as well as the filesystem's.
  if (!options.branch && !options.checkout) {
    validateBranchName(options.name, 'workspace name (used as the branch name)');
  }
  validateWorkspaceRefName(options.name);
}

function requireGitProject(rootInput: string): ProjectInfo {
  const info = requireProject(rootInput);
  if (!info.gitRepo) {
    throw new WorklerError('NOT_A_GIT_REPO', 'workler add needs a git repository', { root: info.root });
  }
  return info;
}

// Validates options and resolves everything `add` needs without touching
// disk: the target path, the checkout plan, and any warnings. Used directly
// for dry runs; createWorkspace re-plans under the project lock.
export function planWorkspaceCreation(rootInput: string, options: CreateWorkspaceOptions): WorkspacePlan {
  validateOptions(options);
  const info = requireGitProject(rootInput);
  return planLocked(info.root, options);
}

function planLocked(root: string, options: CreateWorkspaceOptions): WorkspacePlan {
  const target = path.join(root, WORKSPACES_DIR, options.name);
  assertInside(path.join(root, WORKSPACES_DIR), target, 'workspace path escaped .worktrees');

  if (fs.existsSync(target)) {
    throw new WorklerError('WORKSPACE_EXISTS', `workspace already exists: ${target}`, { name: options.name, path: target });
  }

  // Parse and safety-check every rule against the still-nonexistent target.
  // This has no side effects, but prevents a known-bad rule (including a
  // source symlink-ancestor escape) from leaving a clone behind.
  applyRules(root, target, { force: options.force === true, dryRun: true });

  // Resolve the requested branch/ref against the main project BEFORE cloning
  // so name clashes and bad refs fail cleanly without leaving a clone behind.
  const checkout = planCheckout(root, options);

  const warnings: string[] = [];
  if (!isGitWorkTreeClean(root)) {
    warnings.push('main project has uncommitted changes; the clone will only contain committed tracked files');
  }

  return { root, name: options.name, target, checkout, warnings };
}

export function createWorkspace(rootInput: string, options: CreateWorkspaceOptions): CreateWorkspaceResult {
  validateOptions(options);
  const info = requireGitProject(rootInput);
  const root = info.root;
  const progress = options.onProgress ?? (() => {});

  return withProjectLock(root, `add ${options.name}`, () => {
    const plan = planLocked(root, options);
    for (const warning of plan.warnings) {
      progress(`warning: ${warning}`);
    }

    // `init` excludes .worktrees/ on the main project, but a workspace acting
    // as the root of nested workspaces (or a root from an older workler) may
    // not have the entry yet; make sure it does before creating the clone.
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
      executeCheckout(plan.target, plan.checkout, progress);
      configureWorkspace(root, plan.target, options.name);
      rules = applyRules(root, plan.target, {
        force: options.force === true,
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

    const abbrev = gitMaybe(plan.target, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const detached = !abbrev || abbrev === 'HEAD';
    return {
      name: options.name,
      path: plan.target,
      root,
      branch: detached ? undefined : abbrev,
      head: gitMaybe(plan.target, ['rev-parse', 'HEAD']),
      detached,
      rules,
    };
  });
}

function planCheckout(root: string, options: CreateWorkspaceOptions): CheckoutPlan {
  // `add <name> --checkout <ref>`: never create a new branch. Branches are
  // checked out as branches; tags/commits leave a detached HEAD.
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

  // `add <name> <base> --branch <branch>`: create the explicitly named
  // branch from the requested base. This is the programmatic integration
  // form used when a workspace name cannot equal a slash-containing branch.
  if (options.branch && options.base) {
    if (
      localBranchExists(root, options.branch) ||
      revParseCommit(root, `refs/remotes/origin/${options.branch}`) !== undefined
    ) {
      throw branchExistsError(options.branch);
    }
    return planNewBranchFromBase(root, options.branch, options.base);
  }

  // `add <name> --branch <branch>`: checkout <branch> if it exists, create it
  // from HEAD otherwise.
  if (options.branch) {
    return planExistingBranch(root, options.branch) ?? { kind: 'create-branch', branch: options.branch };
  }

  // `add <name> [base]`: always create a NEW branch <name>.
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
  // A remote-branch base (e.g. origin/main) also becomes the new branch's
  // upstream; other remotes than origin are not carried into the clone, so
  // only origin/* bases can track.
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

// A branch "exists" if the main project has it locally, or knows it on origin
// (checking out a remote branch creates the usual local tracking branch).
function planExistingBranch(root: string, branch: string): CheckoutPlan | undefined {
  // HEAD and @ are revision shorthands, never literal branches. In a normal
  // clone origin/HEAD exists, but --checkout HEAD/@ must still detach.
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
      // The clone's initial local branch should already be at this commit, but
      // pin it to the SHA resolved during planning rather than trusting a
      // clone-generated ref if the source changed concurrently.
      git(repo, ['reset', '--hard', plan.sha]);
    } else {
      // clone --local synthesizes origin/<branch> from root local branches.
      // Create from the exact root-local tip instead of trusting that ref.
      git(repo, ['checkout', '--no-track', '-b', plan.branch, plan.sha]);
    }
    if (plan.upstream && plan.upstreamSha) {
      git(repo, ['config', `branch.${plan.branch}.remote`, 'origin']);
      git(repo, ['config', `branch.${plan.branch}.merge`, `refs/heads/${plan.upstream.slice('origin/'.length)}`]);
      git(repo, ['update-ref', `refs/remotes/${plan.upstream}`, plan.upstreamSha]);
    } else {
      // A root-local-only branch must not retain clone --local's synthetic
      // origin tracking, including when it was the initially cloned branch.
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
    // Set upstream via config: the clone's origin/* refs are the main
    // project's local branches, so the upstream ref itself may not exist in
    // the clone until the first fetch (configureWorkspace repoints origin at
    // the real remote right after this).
    git(repo, ['config', `branch.${plan.branch}.remote`, 'origin']);
    git(repo, ['config', `branch.${plan.branch}.merge`, `refs/heads/${plan.upstream.slice('origin/'.length)}`]);
    if (plan.startPoint) {
      // `clone --local` created the clone's origin/* refs from the main
      // project's LOCAL branches, and they are not rewritten when origin is
      // repointed at the real remote. Pin the tracking ref to the sha we
      // resolved from the main project's refs/remotes/origin/* so status
      // reflects the real remote state at creation time instead of a bogus
      // ahead/behind count against a stale ref.
      git(repo, ['update-ref', `refs/remotes/${plan.upstream}`, plan.startPoint]);
    }
  }
}

function revParseCommit(repo: string, ref: string): string | undefined {
  return gitMaybe(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

function configureWorkspace(root: string, target: string, name: string): void {
  // workler.root records the IMMEDIATE parent: for a nested workspace that
  // is the enclosing workspace, not the outermost root.
  const canonicalRoot = canonicalPath(root);
  git(target, ['config', '--local', 'workler.root', canonicalRoot]);
  git(target, ['config', '--local', 'workler.name', name]);

  // Independent clones do not inherit .git/info/exclude, so exclude
  // .worktrees/ here too: the workspace may host nested workspaces of its
  // own (`workler add` run inside it).
  addLineIfMissing(gitInfoExcludePath(target), `${WORKSPACES_DIR}/`);

  // `clone --local` leaves the clone's origin pointing at the main checkout on
  // disk, which is never what a user means by "origin": `push origin` would
  // push into the main project and `fetch origin` would treat it as upstream.
  //
  // If the main project has a real origin, inherit it. If it has none, the
  // workspace must not have one either — dropping it also removes the
  // remote-tracking refs `clone --local` copied from the main project's LOCAL
  // branches, which would otherwise masquerade as origin/* state.
  //
  // Either way the link back to the main checkout is kept under a dedicated
  // `workler-root` remote (what `branch-sync` uses), so it exists for EVERY
  // workspace and not just the ones whose root happens to have an origin.
  const rootOriginUrls = gitConfigValues(root, 'remote.origin.url').map((url) => inheritedRemoteUrl(root, url));
  const rootRemotes = gitMaybe(root, ['remote']);
  if (rootRemotes === undefined) {
    throw new Error('git could not list remotes in the main project');
  }
  const rootHasOrigin = rootRemotes.split('\n').includes('origin');
  if (rootOriginUrls.length > 0) {
    setGitConfigValues(target, 'remote.origin.url', rootOriginUrls);
    // A separate push URL is part of the root's origin semantics. Dropping it
    // can send workspace pushes to the fetch mirror instead of the intended
    // push endpoint. No pushurl means Git correctly falls back to the URL list.
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

// clone --local synthesizes origin/* from the source's LOCAL branches. Once
// origin is repointed those refs would masquerade as real upstream state.
// Replace them, without network access, with the root's actual origin snapshot.
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
  // origin/HEAD is normally symbolic and was excluded above. Remove the
  // clone-generated one before recreating the root snapshot's symbolic ref.
  gitMaybe(target, ['update-ref', '--no-deref', '-d', `${prefix}HEAD`]);
  for (const [ref, sha] of desired) {
    git(target, ['update-ref', ref, sha]);
  }
  const rootHead = gitMaybe(root, ['symbolic-ref', '--quiet', `${prefix}HEAD`]);
  if (rootHead && desired.has(rootHead)) {
    git(target, ['symbolic-ref', `${prefix}HEAD`, rootHead]);
  }

  // The initially cloned branch may carry auto-created tracking config. Keep
  // it only when its upstream exists in the real root origin snapshot.
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
  // --unset-all exits non-zero when the key is absent; that is already the
  // desired state, so use the non-throwing helper.
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
  // Git interprets a relative local remote against each repository's working
  // directory. The clone lives two levels deeper, so copying the text verbatim
  // points somewhere else; make its meaning stable before inheriting it.
  return path.resolve(fs.realpathSync.native(root), url);
}

// Adds the remote, or corrects its URL if it somehow already points elsewhere.
function setRemote(repo: string, name: string, url: string): void {
  const existing = gitMaybe(repo, ['remote', 'get-url', name]);
  if (existing === undefined) {
    git(repo, ['remote', 'add', name, url]);
  } else if (existing !== url) {
    git(repo, ['remote', 'set-url', name, url]);
  }
}
