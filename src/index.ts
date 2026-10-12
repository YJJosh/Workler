// Programmatic API. Every operation takes an EXPLICIT project root — nothing
// here reads process.cwd() or mutates global state — and returns structured
// results. Domain failures throw WorklerError (inspect `error.code`), while
// unexpected host I/O/Git failures may remain ordinary Error instances;
// concurrent mutating operations on the same project throw LockError. All functions are
// synchronous, mirroring the CLI's execution model.

export { WorklerError, LockError } from './errors';
export type { WorklerErrorCode, LockHolder } from './errors';

export { discoverProjects, initProject, inspectProject } from './core/project';
export type { InitResult, ProjectInfo } from './core/project';

export { createWorkspace, planWorkspaceCreation } from './core/create';
export type {
  CheckoutPlan,
  CreatedWorkspace,
  CreateWorkspaceOptions,
  CreateWorkspaceResult,
  MemberCreateResult,
  MemberPlan,
  WorkspacePlan,
} from './core/create';

export { listWorkspaceInfos as listWorkspaces, resolveWorkspacePath } from './core/list';
export type { MemberInfo, WorkspaceInfo } from './core/list';

export { removeWorkspace } from './core/remove';
export type { RemoveWorkspaceOptions, RemoveWorkspaceResult } from './core/remove';

export { setupWorkspace } from './core/setup';
export type { MemberSetupResult, SetupWorkspaceResult, WorkspaceSetupOptions, WorkspaceSetupOutcome } from './core/setup';
export type { SetupCommandResult, SetupOptions, SetupOutcome, SetupTarget } from './setup';

// CLI-style discovery of the nearest enclosing project, for callers that
// want it; the operations above never call this themselves.
export { findWorklerRoot } from './workspaces';
export type { GroupMembership } from './workspaces';

// Where `branch-sync` at a group root mirrors a member clone's branches inside
// its source repository: refs/workler-group/<group>/<workspace>/<branch>.
export { groupRefNamespace } from './groups';

export { projectLockPath } from './lock';

export type { ApplyRulesOutcome, RuleApplyResult } from './rules';
export type { SetupCommand } from './types';

export { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from './constants';
