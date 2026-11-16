import type { WorkspaceSetupOptions, WorkspaceSetupOutcome } from '../core/setup';
import { setupCommandCount } from '../core/setup';
import { formatRuleResult } from '../rules';
import type { ApplyRulesOutcome, RuleApplyResult } from '../rules';
import { formatSetupGuardMissing, formatSetupHeading, formatSetupSkip } from '../setup';
import type { SetupCommand } from '../types';

export function printRuleResult(result: RuleApplyResult): void {
  console.log(formatRuleResult(result));
}

export function printRuleSummary(outcome: ApplyRulesOutcome): void {
  if (outcome.ruleCount === 0) {
    console.log('no workspace rules');
  }
  if (outcome.conflicts > 0) {
    const plural = outcome.conflicts === 1 ? '' : 's';
    console.log(`${outcome.conflicts} conflict${plural}; re-run with --force to replace the destination${plural}`);
  }
}

export function printSetupHeading(command: SetupCommand): void {
  console.log(formatSetupHeading(command));
}

export function printSetupGuardMissing(command: SetupCommand, _index: number, _total: number, project?: string): void {
  console.log(formatSetupGuardMissing(command, project));
}

export function printSetupSkip(command: SetupCommand): void {
  console.log(formatSetupSkip(command));
}

export function printSetupSummary(outcome: WorkspaceSetupOutcome): void {
  if (setupCommandCount(outcome) === 0) {
    console.log('no setup commands');
  }
}

export function setupCallbacks(): WorkspaceSetupOptions {
  return {
    onSetupCommand: printSetupHeading,
    onSetupSkip: printSetupSkip,
    onSetupGuardMissing: printSetupGuardMissing,
    onProjectSetup: (project, commandCount, skipped) => {
      if (skipped !== undefined) {
        console.log(`project ${project}: skipped (${skipped})`);
      } else if (commandCount > 0) {
        console.log(`project ${project}`);
      }
    },
    onGroupSetup: (commandCount) => {
      if (commandCount > 0) {
        console.log('group setup');
      }
    },
    setupStdout: setupStdoutMode(),
  };
}

// When stdout is a pipe, setup output goes to stderr so scripts reading the
// `path` line see only Workler's own lines.
export function setupStdoutMode(): 'inherit' | 'stderr' {
  return process.stdout.isTTY ? 'inherit' : 'stderr';
}
