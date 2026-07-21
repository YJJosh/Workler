import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRules } from './config';
import { WorklerError } from './errors';
import {
  assertInside,
  findSymlinkAncestor,
  isCorrectSymlink,
  pathsHaveSameContent,
  pathsReferToSameLocation,
} from './fs-utils';
import type { RuleAction, WorklerRule } from './types';

// What already sits at a rule's destination. 'correct-link' means a symlink
// that already points at the intended source, which is not a conflict.
type DestinationState =
  | { kind: 'none' }
  | { kind: 'correct-link' }
  | { kind: 'link'; description: string }
  | { kind: 'file'; description: string }
  | { kind: 'dir'; description: string }
  | { kind: 'other'; description: string };

function inspectDestination(destination: string, source: string): DestinationState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (_) {
    return { kind: 'none' };
  }

  if (stat.isSymbolicLink()) {
    if (isCorrectSymlink(destination, source)) {
      return { kind: 'correct-link' };
    }
    const target = fs.readlinkSync(destination);
    const broken = !fs.existsSync(destination);
    return { kind: 'link', description: `${broken ? 'broken ' : ''}symlink -> ${target}` };
  }
  if (stat.isFile()) {
    return { kind: 'file', description: 'regular file' };
  }
  if (stat.isDirectory()) {
    return { kind: 'dir', description: 'directory' };
  }
  return { kind: 'other', description: 'special file' };
}

function conflictDetails(source: string, destination: string, description: string): string {
  return (
    `  source:      ${source}\n` +
    `  destination: ${destination} (existing ${description})`
  );
}

// One rule's outcome. 'ok' = nothing to do (already linked / contents match),
// 'applied' = linked or copied, 'planned' = dry-run would apply, 'skipped' =
// source missing, 'conflict' = dry-run found a conflicting destination
// (outside dry-run a conflict throws RULE_CONFLICT instead).
export interface RuleApplyResult {
  action: RuleAction;
  targetPath: string;
  source: string;
  destination: string;
  status: 'ok' | 'applied' | 'planned' | 'skipped' | 'conflict';
  // Reason for 'ok'/'skipped' ("already linked", "source does not exist: …").
  note?: string;
  // Description of what --force replaced (or would replace in dry-run).
  replaced?: string;
  // Description of the conflicting destination ('conflict' only).
  existing?: string;
}

export interface ApplyRulesOptions {
  force: boolean;
  dryRun: boolean;
  // Called as each rule resolves so the CLI can print incrementally; the
  // same results are also returned in the outcome.
  onResult?: (result: RuleApplyResult) => void;
}

export interface ApplyRulesOutcome {
  // Total rules parsed from .workler (0 means the file is empty or missing).
  ruleCount: number;
  results: RuleApplyResult[];
  conflicts: number;
}

export function applyRules(root: string, workspacePath: string, options: ApplyRulesOptions): ApplyRulesOutcome {
  if (pathsReferToSameLocation(root, workspacePath)) {
    throw new WorklerError('INVALID_OPTIONS', 'refusing to apply rules to main workspace');
  }

  const rules = readRules(root);
  const outcome: ApplyRulesOutcome = { ruleCount: rules.length, results: [], conflicts: 0 };
  const emit = (result: RuleApplyResult): void => {
    outcome.results.push(result);
    if (result.status === 'conflict') {
      outcome.conflicts++;
    }
    options.onResult?.(result);
  };

  for (const rule of rules) {
    const source = path.join(root, rule.targetPath);
    const destination = path.join(workspacePath, rule.targetPath);
    assertInside(root, source, `rule escapes project: ${rule.raw}`);
    assertInside(workspacePath, destination, `rule escapes workspace: ${rule.raw}`);

    // Relative paths can still traverse an existing symlink/junction. Check
    // both trees before even treating a missing source as a harmless skip, and
    // repeat this during real application after creation preflight. The final
    // entry is intentionally excluded: direct symlink sources and destination
    // symlinks remain supported and can be inspected/replaced safely.
    const sourceSymlinkAncestor = findSymlinkAncestor(root, source);
    if (sourceSymlinkAncestor) {
      const target = fs.readlinkSync(sourceSymlinkAncestor);
      throw new WorklerError(
        'RULE_CONFLICT',
        `cannot ${rule.action} ${rule.targetPath}: source parent traverses a symlink\n` +
          `${conflictDetails(source, destination, `source symlinked parent ${sourceSymlinkAncestor} -> ${target}`)}\n` +
          'remove or replace the symlinked parent first; --force will not traverse it',
        {
          action: rule.action,
          targetPath: rule.targetPath,
          source,
          destination,
          symlinkAncestor: sourceSymlinkAncestor,
          target,
        },
      );
    }

    const destinationSymlinkAncestor = findSymlinkAncestor(workspacePath, destination);
    if (destinationSymlinkAncestor) {
      const target = fs.readlinkSync(destinationSymlinkAncestor);
      throw new WorklerError(
        'RULE_CONFLICT',
        `cannot ${rule.action} ${rule.targetPath}: destination parent traverses a symlink\n` +
          `${conflictDetails(source, destination, `symlinked parent ${destinationSymlinkAncestor} -> ${target}`)}\n` +
          'remove or replace the symlinked parent first; --force will not write outside the workspace',
        {
          action: rule.action,
          targetPath: rule.targetPath,
          source,
          destination,
          symlinkAncestor: destinationSymlinkAncestor,
          target,
        },
      );
    }

    if (!fs.existsSync(source)) {
      emit({
        action: rule.action,
        targetPath: rule.targetPath,
        source,
        destination,
        status: 'skipped',
        note: `source does not exist: ${source}`,
      });
      continue;
    }

    emit(
      rule.action === 'link'
        ? applyLink(source, destination, rule, options)
        : applyCopy(source, destination, rule, options),
    );
  }

  return outcome;
}

// Renders one result exactly as the CLI printed it before results became
// structured; kept next to the result type so the two stay in sync.
export function formatRuleResult(result: RuleApplyResult): string {
  switch (result.status) {
    case 'skipped':
      return `skip   ${result.action} ${result.targetPath} (${result.note})`;
    case 'ok':
      return `ok     ${result.action} ${result.targetPath} (${result.note})`;
    case 'conflict':
      return `conflict ${result.action} ${result.targetPath}\n${conflictDetails(result.source, result.destination, result.existing ?? 'unknown')}`;
    case 'planned':
      return `would  ${result.action} ${result.targetPath} -> ${result.destination}${result.replaced ? ` (replacing existing ${result.replaced})` : ''}`;
    case 'applied':
      return `${result.action === 'link' ? 'linked' : 'copied'} ${result.targetPath}${result.replaced ? ` (replaced existing ${result.replaced})` : ''}`;
  }
}

function ruleConflictError(
  rule: WorklerRule,
  source: string,
  destination: string,
  description: string,
  reason: string,
): WorklerError {
  return new WorklerError(
    'RULE_CONFLICT',
    `cannot ${rule.action} ${rule.targetPath}: ${reason}\n${conflictDetails(source, destination, description)}\n` +
      're-run with --force to replace the destination',
    { action: rule.action, targetPath: rule.targetPath, source, destination, existing: description },
  );
}

// Build a forced replacement next to its destination before moving the old
// entry away. If construction or installation fails, the original remains in
// place (or is rolled back); `--force` must not turn a transient copy/symlink
// failure into silent data loss.
function replaceDestination(destination: string, createStaged: (staged: string) => void): void {
  const parent = path.dirname(destination);
  const staged = path.join(parent, `.workler-${randomUUID()}.tmp`);
  const backup = path.join(parent, `.workler-${randomUUID()}.bak`);
  let movedOriginal = false;

  try {
    createStaged(staged);
    fs.renameSync(destination, backup);
    movedOriginal = true;

    try {
      fs.renameSync(staged, destination);
    } catch (installError) {
      try {
        fs.renameSync(backup, destination);
        movedOriginal = false;
      } catch (rollbackError) {
        throw new Error(
          `replacement failed and the original could not be restored; it remains at ${backup}: ` +
            `${(installError as Error).message}; rollback failed: ${(rollbackError as Error).message}`,
        );
      }
      throw installError;
    }

    try {
      fs.rmSync(backup, { recursive: true, force: true });
      movedOriginal = false;
    } catch (cleanupError) {
      throw new Error(
        `replacement was installed, but the original could not be removed and remains at ${backup}: ` +
          `${(cleanupError as Error).message}`,
      );
    }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    // On an error before installation, preserve/restore the original rather
    // than deleting the backup in this cleanup path.
    if (!movedOriginal) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
  }
}

function applyLink(source: string, destination: string, rule: WorklerRule, options: ApplyRulesOptions): RuleApplyResult {
  const base = { action: rule.action, targetPath: rule.targetPath, source, destination } as const;
  const existing = inspectDestination(destination, source);
  if (existing.kind === 'correct-link') {
    return { ...base, status: 'ok', note: 'already linked' };
  }

  let replaced: string | undefined;
  if (existing.kind !== 'none') {
    if (!options.force) {
      if (options.dryRun) {
        return { ...base, status: 'conflict', existing: existing.description };
      }
      throw ruleConflictError(rule, source, destination, existing.description, 'destination already exists');
    }
    replaced = existing.description;
  }

  if (options.dryRun) {
    return { ...base, status: 'planned', replaced };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const relativeSource = path.relative(path.dirname(destination), source) || '.';
  const stat = fs.statSync(source);
  // Junctions because real directory symlinks on Windows need elevation or
  // Developer Mode. Node stores junction targets as ABSOLUTE paths, so the
  // relative link computed above only survives moving the project on POSIX.
  const type = process.platform === 'win32' && stat.isDirectory() ? 'junction' : undefined;
  const createLink = (target: string): void => fs.symlinkSync(relativeSource, target, type);
  if (replaced) {
    replaceDestination(destination, createLink);
  } else {
    createLink(destination);
  }
  return { ...base, status: 'applied', replaced };
}

function applyCopy(source: string, destination: string, rule: WorklerRule, options: ApplyRulesOptions): RuleApplyResult {
  const base = { action: rule.action, targetPath: rule.targetPath, source, destination } as const;
  const existing = inspectDestination(destination, source);

  let replaced: string | undefined;
  if (existing.kind !== 'none') {
    if (pathsHaveSameContent(source, destination)) {
      return { ...base, status: 'ok', note: 'destination matches source' };
    }
    if (!options.force) {
      const description = existing.kind === 'correct-link'
        ? 'symlink to the source, not a copy'
        : `${existing.description}, contents differ from source`;
      if (options.dryRun) {
        return { ...base, status: 'conflict', existing: description };
      }
      throw ruleConflictError(rule, source, destination, description, 'destination already exists and differs');
    }
    replaced = existing.kind === 'correct-link' ? 'symlink to the source' : existing.description;
  }

  if (options.dryRun) {
    return { ...base, status: 'planned', replaced };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const copy = (target: string): void => fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  if (replaced) {
    replaceDestination(destination, copy);
  } else {
    copy(destination);
  }
  return { ...base, status: 'applied', replaced };
}
