// Checks run before anything is cloned, so a name git rejects never leaves a
// half-made workspace behind.

import { WorklerError } from './errors';
import { gitMaybe } from './git';
import { validateWorkspaceName } from './workspaces';

// Windows device names, with or without an extension. Rejected on every
// platform so a project stays usable on Windows.
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i;

// Forbidden in a Windows path component; git allows '<', '>', '"' and '|' in refs.
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * For a new workspace: stricter than validateWorkspaceName, which `remove`
 * uses and so must accept any name already on disk.
 * @throws WorklerError INVALID_NAME
 */
export function validateNewWorkspaceName(name: string): void {
  validateWorkspaceName(name);

  if (name.startsWith('-')) {
    throw new WorklerError('INVALID_NAME', `workspace name cannot start with "-": ${name}`, { name });
  }
  if (WINDOWS_INVALID_CHARS.test(name) || hasControlCharacter(name)) {
    throw new WorklerError(
      'INVALID_NAME',
      `workspace name cannot contain <>:"|?* or control characters: ${name}`,
      { name },
    );
  }
  if (/[. ]$/.test(name)) {
    throw new WorklerError('INVALID_NAME', `workspace name cannot end with a dot or a space: ${name}`, { name });
  }
  if (name.length > 255 || Buffer.byteLength(name, 'utf8') > 255) {
    throw new WorklerError('INVALID_NAME', 'workspace name is too long for a portable filesystem component', { name });
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    throw new WorklerError('INVALID_NAME', `workspace name "${name}" is a reserved device name on Windows`, { name });
  }
}

// branch-sync mirrors the workspace under refs/workler/<name>/, so the name
// must also be valid in a ref.
export function validateWorkspaceRefName(name: string): void {
  if (!isValidRefName(`refs/workler/${name}/placeholder`)) {
    throw new WorklerError(
      'INVALID_NAME',
      `workspace name cannot be represented safely in git refs: ${name}`,
      { name },
    );
  }
}

// A branch `add` may create. `git check-ref-format` decides; the checks before
// it catch names it accepts that are still unusable.
export function validateBranchName(branch: string, label: string): void {
  if (!branch) {
    throw new WorklerError('INVALID_NAME', `${label} cannot be empty`, { branch });
  }
  // Later git commands would read a leading "-" as an option.
  if (branch.startsWith('-')) {
    throw new WorklerError('INVALID_NAME', `${label} cannot start with "-": ${branch}`, { branch });
  }
  // Both are valid refnames, but they name something other than a branch.
  if (branch === 'HEAD' || branch === '@') {
    throw new WorklerError('INVALID_NAME', `${label} cannot be "${branch}"`, { branch });
  }
  if (branch.split('/').some((component) => component.length > 255 || Buffer.byteLength(component, 'utf8') > 255)) {
    throw new WorklerError('INVALID_NAME', `${label} contains a path component too long for a portable filesystem: ${branch}`, { branch });
  }
  if (!isValidRefName(`refs/heads/${branch}`)) {
    throw new WorklerError(
      'INVALID_NAME',
      `${label} is not a valid git branch name: ${branch}\n` +
        'run `git check-ref-format --help` for the rules (no "..", no space, no "~^:?*[", no trailing ".lock")',
      { branch },
    );
  }
}

// A ref `add` only reads. Any resolvable ref is fine; an unresolvable one
// fails as BAD_REF during planning, before the clone.
export function validateStartRef(ref: string, label: string): void {
  if (!ref) {
    throw new WorklerError('BAD_REF', `${label} cannot be empty`, { ref });
  }
  if (ref.startsWith('-')) {
    throw new WorklerError('BAD_REF', `${label} cannot start with "-": ${ref}`, { ref });
  }
}

// Takes a full refname, not --branch, which resolves shorthands like `@{-1}`.
// check-ref-format needs no repository.
function isValidRefName(ref: string): boolean {
  return gitMaybe(null, ['check-ref-format', ref]) !== undefined;
}
