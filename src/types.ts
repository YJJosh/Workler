export interface CliContext {
  cliName: string;
}

export type RuleAction = 'copy' | 'link';

export interface WorklerRule {
  action: RuleAction;
  targetPath: string;
  raw: string;
}

export interface Workspace {
  name: string;
  path: string;
}
