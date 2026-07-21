import { formatRuleResult } from '../rules';
import type { ApplyRulesOutcome, RuleApplyResult } from '../rules';

// Shared console rendering of rule application for `add` and `apply`:
// results print incrementally via this callback, then printRuleSummary adds
// the trailing lines the commands printed before results were structured.

export function printRuleResult(result: RuleApplyResult): void {
  console.log(formatRuleResult(result));
}

export function printRuleSummary(outcome: ApplyRulesOutcome): void {
  if (outcome.ruleCount === 0) {
    console.log('no workspace rules');
    return;
  }
  if (outcome.conflicts > 0) {
    // Only reachable in dry-run: outside dry-run a conflict throws instead.
    const plural = outcome.conflicts === 1 ? '' : 's';
    console.log(`${outcome.conflicts} conflict${plural}; re-run with --force to replace the destination${plural}`);
  }
}
