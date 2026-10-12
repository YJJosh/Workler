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

// A `setup [--if-missing <path>] <command>` line: a shell command run in a
// new workspace after the copy/link rules (and again by `workler setup`).
export interface SetupCommand {
  // The command exactly as written, surrounding whitespace trimmed.
  command: string;
  // With `--if-missing <path>`: the command only runs while nothing exists
  // at this path, relative to the directory the command runs in (portable
  // forward-slash spelling, validated like a rule path).
  ifMissing?: string;
  raw: string;
}

export interface WorklerConfig {
  rules: WorklerRule[];
  projects: ProjectEntry[];
  setup: SetupCommand[];
}

export interface Workspace {
  name: string;
  path: string;
}
