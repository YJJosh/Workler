import { CONFIG_FILE, PACKAGE_NAME, VERSION, WORKSPACES_DIR } from '../constants';

export function helpCommand(): void {
  console.log(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${PACKAGE_NAME} --version
  ${PACKAGE_NAME} init
  ${PACKAGE_NAME} add <name> [base] [--branch <branch>] [--checkout <ref>] [--copy-links] [--force] [--no-setup] [--dry-run]
  ${PACKAGE_NAME} apply [name[/<project>]] [--all] [--copy-links | --no-copy-links] [--force] [--dry-run]
  ${PACKAGE_NAME} setup [name[/<project>]]
  ${PACKAGE_NAME} list
  ${PACKAGE_NAME} path <name>[/<project>]
  ${PACKAGE_NAME} remove <name> [--force]
  ${PACKAGE_NAME} shell-init
  ${PACKAGE_NAME} status
  ${PACKAGE_NAME} fetch
  ${PACKAGE_NAME} sync
  ${PACKAGE_NAME} branch-sync

Flags:
  --copy-links     copy what "link" rules would symlink, so the workspace shares
                   nothing; "apply --copy-links" converts existing links to copies
  --no-copy-links  apply only: go back to symlinks (existing copies need --force)
  --dry-run        print what would be copied/linked/replaced without changing anything
  --force          replace destinations that already exist and differ
  --no-setup       add only: skip the "setup" commands ("setup <name>" runs them later)

Workler does not use git worktree: it creates normal local clones under
${WORKSPACES_DIR}/, applies copy/link rules from an optional ${CONFIG_FILE} file, and
then runs its "setup" commands inside the new clone ("setup pnpm install";
"setup --if-missing node_modules pnpm install" only while that path is absent).
"apply" re-applies only the copy/link rules; "setup" re-runs only the commands.
"sync" skips repositories with uncommitted tracked changes and only fast-forwards
current branches. "branch-sync" can create branches and fast-forward non-checked-out
branches, but leaves diverged or locally advanced branches unchanged.

A plain folder that holds several repositories becomes a project group by
listing them with "project <path>" lines in its ${CONFIG_FILE} ("${PACKAGE_NAME} init" writes
them for you). "add" there clones every listed repository into ${WORKSPACES_DIR}/<name>/
in the same layout and runs each repository's "setup" commands in its clone,
then the group's own; "path", "apply", "setup" and "status" address one member
as <name>/<path>. Each repository keeps its own ${CONFIG_FILE} and its own workspaces.

Run "${PACKAGE_NAME} init" to prepare a project, and "${PACKAGE_NAME} <command> --help"
for details on each command.

Documentation: https://yjjosh.github.io/Workler
`);
}
