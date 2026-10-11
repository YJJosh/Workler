export type RuleAction = 'copy' | 'link';

export interface WorklerRule {
  action: RuleAction;
  targetPath: string;
  raw: string;
}

// One `project <path>` line: a Git repository below a project group root,
// identified by its portable (forward-slash) path relative to that root.
export interface ProjectEntry {
  path: string;
  raw: string;
}

export interface WorklerConfig {
  rules: WorklerRule[];
  projects: ProjectEntry[];
}

export interface Workspace {
  name: string;
  path: string;
}
