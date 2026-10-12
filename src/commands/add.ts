import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { createWorkspace, planWorkspaceCreation } from '../core/create';
import type { CheckoutPlan, CreateWorkspaceOptions, WorkspacePlan } from '../core/create';
import { setupWorkspace } from '../core/setup';
import { applyRules } from '../rules';
import type { ApplyRulesOutcome } from '../rules';
import { formatSetupPlan } from '../setup';
import { findWorklerRoot } from '../workspaces';
import { printRuleResult, printRuleSummary, setupCallbacks } from './rule-output';

export function addCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} add <name> [base] [--branch <branch>] [--checkout <ref>] [--copy-links] [--force] [--no-setup] [--dry-run]`;
  const parsed = parseCommandArgs(args, {
    command: 'add',
    usage,
    booleanFlags: ['--copy-links', '--force', '--no-setup', '--dry-run'],
    valueFlags: ['--branch', '--checkout'],
    minPositionals: 1,
    maxPositionals: 2,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}`);
    return;
  }

  const options: CreateWorkspaceOptions = {
    name: parsed.positionals[0],
    base: parsed.positionals[1],
    branch: parsed.flags.branch as string | undefined,
    checkout: parsed.flags.checkout as string | undefined,
    force: parsed.flags.force === true,
    copyLinks: parsed.flags['copy-links'] === true,
  };
  const dryRun = parsed.flags['dry-run'] === true;
  const setup = parsed.flags['no-setup'] !== true;

  const root = findWorklerRoot(process.cwd());

  if (dryRun) {
    const plan = planWorkspaceCreation(root, options);
    for (const warning of plan.warnings) {
      console.log(`warning: ${warning}`);
    }
    printPlan(plan, options.force === true, options.copyLinks === true);
    if (setup) {
      printSetupPlan(plan);
    }
    return;
  }

  // Setup runs here rather than inside createWorkspace so the rule summary
  // lands before the first command's heading, in the order things happened.
  const result = createWorkspace(root, {
    ...options,
    setup: false,
    onProgress: (message) => console.log(message),
    onRuleResult: printRuleResult,
  });
  if (result.projects) {
    // Each member printed its own results as they resolved; summarize the
    // group as a whole so "no workspace rules" means no rules anywhere.
    printRuleSummary(combinedOutcome([result.rules, ...result.projects.map((project) => project.rules)]));
  } else {
    printRuleSummary(result.rules);
  }

  if (setup) {
    // A failing command throws SETUP_COMMAND_FAILED after the workspace is
    // complete; the message names the command and how to retry. With no
    // setup lines nothing is announced, so `done`/`path` stay the last lines.
    setupWorkspace(root, result.name, setupCallbacks());
  }

  console.log(`done   ${result.name}`);
  console.log(`path   ${result.path}`);
}

// Prints the full plan for `add --dry-run` without cloning anything. Mirrors
// what createWorkspace reports as progress, with "would" phrasing, then
// dry-runs the copy/link rules against the (nonexistent) target.
function printPlan(plan: WorkspacePlan, force: boolean, copyLinks: boolean): void {
  console.log('dry run: nothing will be created');

  if (!plan.projects) {
    printClonePlan(plan.root, plan.target, plan.checkout as CheckoutPlan);
    const outcome = applyRules(plan.root, plan.target, { force, copyLinks, dryRun: true, onResult: printRuleResult });
    printRuleSummary(outcome);
    return;
  }

  const outcomes: ApplyRulesOutcome[] = [];
  for (const member of plan.projects) {
    console.log(`project ${member.project}`);
    printClonePlan(member.root, member.target, member.checkout);
    outcomes.push(applyRules(member.root, member.target, { force, copyLinks, dryRun: true, onResult: printRuleResult }));
  }
  const groupOutcome = applyRules(plan.root, plan.target, { force, copyLinks, dryRun: true, onResult: printRuleResult });
  printRuleSummary(combinedOutcome([groupOutcome, ...outcomes]));
}

// The setup commands in the order they would run: after every clone, each
// member's from its source repository, then the group's own.
function printSetupPlan(plan: WorkspacePlan): void {
  if (!plan.projects) {
    for (const command of plan.setup) {
      console.log(formatSetupPlan(command));
    }
    return;
  }
  for (const member of plan.projects) {
    if (member.setup.length === 0) {
      continue;
    }
    console.log(`project ${member.project}`);
    for (const command of member.setup) {
      console.log(formatSetupPlan(command));
    }
  }
  if (plan.setup.length > 0) {
    console.log('group setup');
    for (const command of plan.setup) {
      console.log(formatSetupPlan(command));
    }
  }
}

function printClonePlan(root: string, target: string, plan: CheckoutPlan): void {
  console.log(`would clone ${root}`);
  console.log(`         to ${target}`);

  if (plan.kind === 'checkout-branch') {
    console.log(`would checkout branch ${plan.branch}`);
  } else if (plan.kind === 'detach') {
    console.log(`would checkout ${plan.ref} (detached HEAD, not on a branch)`);
  } else {
    const tracking = plan.upstream ? ` (tracking ${plan.upstream})` : '';
    if (plan.startPoint) {
      console.log(`would create branch ${plan.branch} from ${plan.startPointLabel}${tracking}`);
    } else {
      console.log(`would create branch ${plan.branch} from HEAD`);
    }
  }
}

function combinedOutcome(outcomes: ApplyRulesOutcome[]): ApplyRulesOutcome {
  return {
    ruleCount: outcomes.reduce((sum, outcome) => sum + outcome.ruleCount, 0),
    results: outcomes.flatMap((outcome) => outcome.results),
    conflicts: outcomes.reduce((sum, outcome) => sum + outcome.conflicts, 0),
  };
}
