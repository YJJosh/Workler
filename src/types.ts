export type RuleAction = 'copy' | 'link';

export interface WorklerRule {
  action: RuleAction;
  targetPath: string;
  raw: string;
}

/** A `project <path>` line: a Git repository below a project group root. */
export interface ProjectEntry {
  /** Forward-slash path relative to the group root. */
  path: string;
  raw: string;
}

/**
 * A `setup [--if-missing <path>] <command>` line: a shell command run in a
 * new workspace after the copy/link rules, and again by `workler setup`.
 */
export interface SetupCommand {
  /** Trimmed of surrounding whitespace. */
  command: string;
  /**
   * The command runs only while nothing exists at this forward-slash path,
   * relative to the directory the command runs in.
   */
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
