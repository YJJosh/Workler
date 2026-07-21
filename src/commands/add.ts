import { parseCommandArgs } from '../cli-utils';
import { createWorkspace, planWorkspaceCreation } from '../core/create';
import type { CheckoutPlan, CreateWorkspaceOptions } from '../core/create';
import { applyRules } from '../rules';
import { findWorklerRoot } from '../workspaces';
import { printRuleResult, printRuleSummary } from './rule-output';
import type { CliContext } from '../types';

export function addCommand(args: string[], context: CliContext): void {
  const usage = `${context.cliName} add <name> [base] [--branch <branch>] [--checkout <ref>] [--force] [--dry-run]`;
  const parsed = parseCommandArgs(args, {
    command: 'add',
    usage,
    booleanFlags: ['--force', '--dry-run'],
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
  };
  const dryRun = parsed.flags['dry-run'] === true;

  const root = findWorklerRoot(process.cwd(), context.cliName);

  if (dryRun) {
    const plan = planWorkspaceCreation(root, options);
    for (const warning of plan.warnings) {
      console.log(`warning: ${warning}`);
    }
    printPlan(plan.root, plan.target, plan.checkout, options.force === true);
    return;
  }

  const result = createWorkspace(root, {
    ...options,
    onProgress: (message) => console.log(message),
    onRuleResult: printRuleResult,
  });
  printRuleSummary(result.rules);

  console.log(`done   ${result.name}`);
  console.log(`path   ${result.path}`);
}

// Prints the full plan for `add --dry-run` without cloning anything. Mirrors
// what createWorkspace reports as progress, with "would" phrasing, then
// dry-runs the copy/link rules against the (nonexistent) target.
function printPlan(root: string, target: string, plan: CheckoutPlan, force: boolean): void {
  console.log('dry run: nothing will be created');
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

  const outcome = applyRules(root, target, { force, dryRun: true, onResult: printRuleResult });
  printRuleSummary(outcome);
}
