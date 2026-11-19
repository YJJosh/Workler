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

/** A `setup [--if-missing <path>] <command>` line: shell command run after the rules in a new workspace and by `workler setup`. */
export interface SetupCommand {
  /** Trimmed of surrounding whitespace. */
  command: string;
  /** Run only while nothing exists at this forward-slash path, relative to the command's directory. */
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
