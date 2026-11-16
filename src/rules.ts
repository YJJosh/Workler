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
  rebaseInternalLinks,
} from './fs-utils';
import type { RuleAction, WorklerRule } from './types';

// 'correct-link': a symlink already pointing at the source; not a conflict.
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

export interface RuleApplyResult {
  action: RuleAction;
  targetPath: string;
  source: string;
  destination: string;
  /**
   * 'ok': nothing to do. 'applied': linked or copied. 'planned': dry run would
   * apply. 'skipped': source missing. 'conflict': dry run only; otherwise a
   * conflict throws RULE_CONFLICT.
   */
  status: 'ok' | 'applied' | 'planned' | 'skipped' | 'conflict';
  /** Reason for 'ok' or 'skipped'. */
  note?: string;
  /** What --force replaced, or would replace in a dry run. */
  replaced?: string;
  /** The conflicting destination ('conflict' only). */
  existing?: string;
  /** A `link` rule copied under copyLinks; `action` still says 'link'. */
  copiedLink?: boolean;
}

export interface ApplyRulesOptions {
  force: boolean;
  dryRun: boolean;
  /**
   * Copy `link` rules instead of linking. A symlink to the source is
   * converted without --force, since it holds no data of its own.
   */
  copyLinks?: boolean;
  /** Called as each rule resolves; the results are also returned. */
  onResult?: (result: RuleApplyResult) => void;
}

export interface ApplyRulesOutcome {
  /** 0 when .workler is empty or missing. */
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

    // A relative path can still traverse a symlink or junction. Check both
    // trees before even skipping a missing source.
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
      rule.action === 'link' && !options.copyLinks
        ? applyLink(source, destination, rule, options)
        : applyCopy(source, destination, rule, options),
    );
  }

  return outcome;
}

export function formatRuleResult(result: RuleApplyResult): string {
  switch (result.status) {
    case 'skipped':
      return `skip   ${result.action} ${result.targetPath} (${result.note})`;
    case 'ok':
      return `ok     ${result.action} ${result.targetPath} (${result.note})`;
    case 'conflict':
      return `conflict ${result.action} ${result.targetPath}\n${conflictDetails(result.source, result.destination, result.existing ?? 'unknown')}`;
    case 'planned': {
      const action = result.copiedLink ? 'copy' : result.action;
      return `would  ${action} ${result.targetPath} -> ${result.destination}${copiedLinkNote(result)}${result.replaced ? ` (replacing existing ${result.replaced})` : ''}`;
    }
    case 'applied': {
      const verb = result.action === 'link' && !result.copiedLink ? 'linked' : 'copied';
      return `${verb} ${result.targetPath}${copiedLinkNote(result)}${result.replaced ? ` (replaced existing ${result.replaced})` : ''}`;
    }
  }
}

function copiedLinkNote(result: RuleApplyResult): string {
  return result.copiedLink ? ' (link rule, copied instead)' : '';
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

// Builds the replacement before moving the original away, and rolls back on
// failure, so `--force` never turns a failed copy into data loss.
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
    // While the backup is still the only copy of the original, keep it.
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
  // Windows directory symlinks need elevation or Developer Mode, so use
  // junctions. Node stores their targets as absolute paths.
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
  // A `link` rule only gets here under copyLinks.
  const copiedLink = rule.action === 'link';
  const base = {
    action: rule.action,
    targetPath: rule.targetPath,
    source,
    destination,
    ...(copiedLink ? { copiedLink } : {}),
  } as const;
  const existing = inspectDestination(destination, source);
  // A copied link copies what the source resolves to; a nested workspace's
  // source is often itself a link, and copying that would make another link.
  const content = copiedLink ? fs.realpathSync(source) : source;

  let replaced: string | undefined;
  if (existing.kind !== 'none') {
    if (pathsHaveSameContent(content, destination, source)) {
      return { ...base, status: 'ok', note: 'destination matches source' };
    }
    const convertsLink = options.copyLinks === true && existing.kind === 'correct-link';
    if (!options.force && !convertsLink) {
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
  const copy = (target: string): void => {
    fs.cpSync(content, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      // Newer Node's native copy follows Windows junctions; any filter forces
      // the lstat-based JS path, which keeps them as links.
      filter: process.platform === 'win32' ? () => true : undefined,
      // Otherwise Node makes relative links (node_modules/.bin) absolute,
      // pointing back into the source.
      verbatimSymlinks: true,
    });
    // Absolute links still point at the source. `target` may be a staging
    // name; `source` is passed so links written through its alias count too.
    rebaseInternalLinks(content, target, destination, source);
  };
  if (replaced) {
    replaceDestination(destination, copy);
  } else {
    copy(destination);
  }
  return { ...base, status: 'applied', replaced };
}
