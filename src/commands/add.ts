import { parseCommandArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';
import { createWorkspace, planWorkspaceCreation } from '../core/create';
import type { CheckoutPlan, CreateWorkspaceOptions, WorkspacePlan } from '../core/create';
import { applyRules } from '../rules';
import type { ApplyRulesOutcome } from '../rules';
import { findWorklerRoot } from '../workspaces';
import { printRuleResult, printRuleSummary } from './rule-output';

export function addCommand(args: string[]): void {
  const usage = `${PACKAGE_NAME} add <name> [base] [--branch <branch>] [--checkout <ref>] [--copy-links] [--force] [--dry-run]`;
  const parsed = parseCommandArgs(args, {
    command: 'add',
    usage,
    booleanFlags: ['--copy-links', '--force', '--dry-run'],
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

  const root = findWorklerRoot(process.cwd());

  if (dryRun) {
    const plan = planWorkspaceCreation(root, options);
    for (const warning of plan.warnings) {
      console.log(`warning: ${warning}`);
    }
    printPlan(plan, options.force === true, options.copyLinks === true);
    return;
  }

  const result = createWorkspace(root, {
    ...options,
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
