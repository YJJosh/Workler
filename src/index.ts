// Every operation takes an explicit project root, never reads process.cwd() or changes
// global state, and is synchronous. Domain failures throw WorklerError, I/O and Git
// failures may be plain Errors, and concurrent changes to one project throw LockError.

export { WorklerError, LockError } from './errors';
export type { WorklerErrorCode, LockHolder } from './errors';

export { discoverProjects, initProject, inspectProject } from './core/project';
export type { InitResult, ProjectInfo } from './core/project';

export { addGroupProject, removeGroupProject } from './core/members';
export type { GroupProjectsResult } from './core/members';

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
export type { ListWorkspacesOptions, MemberInfo, WorkspaceInfo } from './core/list';
export type { HistoryAssessment } from './history';

export { removeWorkspace } from './core/remove';
export type { RemoveWorkspaceOptions, RemoveWorkspaceResult } from './core/remove';

export { setupWorkspace } from './core/setup';
export type { MemberSetupResult, SetupWorkspaceResult, WorkspaceSetupOptions, WorkspaceSetupOutcome } from './core/setup';
export type { SetupCommandResult, SetupOptions, SetupOutcome, SetupTarget } from './setup';

// The operations above never call this themselves.
export { findWorklerRoot } from './workspaces';
export type { GroupMembership } from './workspaces';

export { groupRefNamespace } from './groups';

export { projectLockPath } from './lock';

export type { ApplyRulesOutcome, RuleApplyResult } from './rules';
export type { SetupCommand } from './types';

export { CONFIG_FILE, MAIN_WORKSPACE_NAME, WORKSPACES_DIR } from './constants';
