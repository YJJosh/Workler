// Name validation that runs BEFORE anything is cloned or written.
//
// `add` used to hand the workspace name straight to `git checkout -b` inside
// the fresh clone, so a name git rejects (`foo.lock`, `a..b`, `-x`) failed
// only after the clone existed, and the failed clone was left behind for the
// user to clean up. Everything here is a pure pre-flight check on the input.

import { WorklerError } from './errors';
import { gitMaybe } from './git';
import { validateWorkspaceName } from './workspaces';

// Names Windows cannot use for a path component, with or without an
// extension: CON, NUL.txt, COM1, ... A workspace name becomes a real
// directory under .worktrees/, so these are rejected on every platform to
// keep a project that works on Linux from being unusable on Windows.
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\..*)?$/i;

// Characters Windows forbids in a path component. Git already rejects ':',
// '?' and '*' in a ref name, but '<', '>', '"' and '|' are legal in a ref and
// still unusable as a directory name.
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

// The name of a workspace that is about to be CREATED. Stricter than
// validateWorkspaceName, which also guards `remove` and therefore has to keep
// accepting the name of any workspace already on disk (including one created
// before these rules existed). A new name has to be a usable directory name
// on every platform we support.
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

// branch-sync mirrors this workspace below refs/workler/<name>/*. A name that
// is only filesystem-valid (for example "has space" or "foo.lock") makes that
// refspec invalid and breaks branch-sync for the whole workspace.
export function validateWorkspaceRefName(name: string): void {
  if (!isValidRefName(`refs/workler/${name}/placeholder`)) {
    throw new WorklerError(
      'INVALID_NAME',
      `workspace name cannot be represented safely in git refs: ${name}`,
      { name },
    );
  }
}

// A branch name `add` may have to CREATE. Git is the authority on what a ref
// may be called, so the real check is `git check-ref-format`; the explicit
// cases in front of it are the ones check-ref-format accepts but that git (or
// we) still cannot use.
export function validateBranchName(branch: string, label: string): void {
  if (!branch) {
    throw new WorklerError('INVALID_NAME', `${label} cannot be empty`, { branch });
  }
  // check-ref-format accepts a leading "-", but every later `git <cmd> <branch>`
  // would read it as an option.
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

// A ref `add` only READS (a base, or a --checkout target). Anything git can
// resolve is fair game, so the only pre-flight check is that it cannot be
// mistaken for a command-line option; an unresolvable ref still fails as
// BAD_REF during planning, which is before the clone.
export function validateStartRef(ref: string, label: string): void {
  if (!ref) {
    throw new WorklerError('BAD_REF', `${label} cannot be empty`, { ref });
  }
  if (ref.startsWith('-')) {
    throw new WorklerError('BAD_REF', `${label} cannot start with "-": ${ref}`, { ref });
  }
}

// Validates the FULL refname (refs/heads/<branch>) rather than passing
// --branch: --branch resolves shorthands such as `@{-1}` against the current
// repository, which would let a name that is not a literal branch through.
// check-ref-format needs no repository, so this runs outside one.
function isValidRefName(ref: string): boolean {
  return gitMaybe(null, ['check-ref-format', ref]) !== undefined;
}
