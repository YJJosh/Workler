import { parseCommandArgs } from '../cli-utils';
import { readRules } from '../config';
import { PACKAGE_NAME } from '../constants';
import { createWorkspace, planWorkspaceCreation } from '../core/create';
import type { CheckoutPlan, CreateWorkspaceOptions, WorkspacePlan } from '../core/create';
import { requireProject } from '../core/project';
import { declaredSetupCommandCount, setupWorkspace } from '../core/setup';
import { applyRules } from '../rules';
import type { ApplyRulesOutcome } from '../rules';
import { NO_SETUP_VARIABLE, formatSetupPlan, formatSetupSkipped, setupDisabledByEnvironment } from '../setup';
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
  // The flag wins the wording when both are present; the effect is the same.
  const skipSetup = parsed.flags['no-setup'] === true ? '--no-setup' : setupDisabledByEnvironment() ? NO_SETUP_VARIABLE : undefined;

  const root = findWorklerRoot(process.cwd());

  if (dryRun) {
    const plan = planWorkspaceCreation(root, options);
    for (const warning of plan.warnings) {
      console.log(`warning: ${warning}`);
    }
    printPlan(plan, options.force === true, options.copyLinks === true);
    if (skipSetup === undefined) {
      printSetupPlan(plan);
    } else {
      printSetupSkipped(plan.setup.length + (plan.projects ?? []).reduce((sum, member) => sum + member.setup.length, 0), skipSetup);
    }
    return;
  }

  // Setup runs here, not in createWorkspace, so the rule summary prints first.
  const result = createWorkspace(root, {
    ...options,
    setup: false,
    onProgress: (message) => console.log(message),
    onRuleResult: printRuleResult,
  });
  if (result.projects) {
    // One summary for the group, so "no workspace rules" means none anywhere.
    printRuleSummary(combinedOutcome([result.rules, ...result.projects.map((project) => project.rules)]));
  } else {
    printRuleSummary(result.rules);
  }

  if (skipSetup === undefined) {
    // A failing command throws SETUP_COMMAND_FAILED; the workspace stays.
    setupWorkspace(root, result.name, setupCallbacks());
  } else {
    printSetupSkipped(declaredSetupCommandCount(requireProject(root)), skipSetup);
  }

  console.log(`done   ${result.name}`);
  console.log(`path   ${result.path}`);
}

// Mirrors createWorkspace's progress lines, then dry-runs the rules against
// the target that does not exist yet.
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
  if (readRules(plan.root).length > 0) {
    console.log('group rules');
  }
  const groupOutcome = applyRules(plan.root, plan.target, { force, copyLinks, dryRun: true, onResult: printRuleResult });
  printRuleSummary(combinedOutcome([groupOutcome, ...outcomes]));
}

// Run order: after every clone, each member's commands, then the group's.
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

function printSetupSkipped(count: number, reason: string): void {
  if (count > 0) {
    console.log(formatSetupSkipped(count, reason));
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
