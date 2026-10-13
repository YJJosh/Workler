import type { WorkspaceSetupOptions, WorkspaceSetupOutcome } from '../core/setup';
import { setupCommandCount } from '../core/setup';
import { formatRuleResult } from '../rules';
import type { ApplyRulesOutcome, RuleApplyResult } from '../rules';
import { formatSetupGuardMissing, formatSetupHeading, formatSetupSkip } from '../setup';
import type { SetupCommand } from '../types';

// Shared console rendering of rule application for `add` and `apply`:
// results print incrementally via this callback, then printRuleSummary adds
// the trailing lines (nothing to do, or how many conflicts need --force).

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

// Shared console rendering of setup commands for `add` and `setup`: a heading
// per command before it runs (or a skip line for a guarded one), a project
// heading per member of a group workspace, and the trailing line when there
// were no commands anywhere.

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

// Setup commands print straight to the terminal. When stdout is a pipe (a
// script reading the `path` line, a test), their output goes to stderr
// instead so Workler's own lines stay the only thing on stdout.
export function setupStdoutMode(): 'inherit' | 'stderr' {
  return process.stdout.isTTY ? 'inherit' : 'stderr';
}
