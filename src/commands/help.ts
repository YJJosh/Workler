import { CONFIG_FILE, PACKAGE_NAME, VERSION, WORKSPACES_DIR } from '../constants';
import type { CliContext } from '../types';

export function helpCommand(context: CliContext): void {
  console.log(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${context.cliName} --version
  ${context.cliName} init
  ${context.cliName} add <name> [base] [--branch <branch>] [--checkout <ref>] [--force] [--dry-run]
  ${context.cliName} apply [name] [--all] [--force] [--dry-run]
  ${context.cliName} list
  ${context.cliName} path <name>
  ${context.cliName} remove <name> [--force]
  ${context.cliName} shell-init
  ${context.cliName} status
  ${context.cliName} fetch
  ${context.cliName} sync
  ${context.cliName} branch-sync

Multi-workspace commands:
  status       branch, upstream ahead/behind and clean/dirty for the main
               project and every workspace; broken clones are flagged
  fetch        git fetch --prune origin everywhere (no origin: skipped)
  sync         fetch, then fast-forward-only pull each current branch;
               dirty workspaces and diverged branches are never touched
  branch-sync  create/fast-forward the root's local branches in every
               workspace (via a "workler-root" remote) and mirror workspace
               branches into the root as refs/workler/<workspace>/<branch>;
               checked-out and diverged branches are never touched

Add (branch behavior):
  add <name>                  new branch <name> from the main project's HEAD
  add <name> <base>           new branch <name> starting at <base> (branch,
                              tag, or commit; origin/x also sets upstream)
  add <name> --branch <b>     workspace <name> on branch <b>; creates <b>
                              from HEAD if it does not exist yet
  add <name> <base> --branch <b>
                              new branch <b> from <base>, with an independent
                              filesystem-safe workspace name
  add <name> --checkout <ref> no new branch: checks out an existing branch,
                              or a tag/commit on a detached HEAD (use this to
                              put several workspaces on the same branch)

Optional config file: ${CONFIG_FILE}
  link node_modules        # inline comments start with "#" after whitespace
  copy .env
  copy "some folder/file.txt"   (quote paths that contain spaces or "#")

Flags:
  --dry-run  print what would be copied/linked/replaced without changing anything
  --force    replace destinations that already exist and differ

Concept:
  Workler does not use git worktree. It works directly in any Git repository,
  creates normal local clones under ${WORKSPACES_DIR}/, and applies copy/link
  rules only when an optional ${CONFIG_FILE} file is present.
`);
}
