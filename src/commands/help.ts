import { CONFIG_FILE, PACKAGE_NAME, VERSION, WORKSPACES_DIR } from '../constants';

export function helpCommand(): void {
  console.log(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${PACKAGE_NAME} --version
  ${PACKAGE_NAME} init
  ${PACKAGE_NAME} add <name> [base] [--branch <branch>] [--checkout <ref>] [--copy-links] [--force] [--dry-run]
  ${PACKAGE_NAME} apply [name] [--all] [--copy-links | --no-copy-links] [--force] [--dry-run]
  ${PACKAGE_NAME} list
  ${PACKAGE_NAME} path <name>
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

Workler does not use git worktree: it creates normal local clones under
${WORKSPACES_DIR}/ and applies copy/link rules from an optional ${CONFIG_FILE} file.
"sync" skips repositories with uncommitted tracked changes and only fast-forwards
current branches. "branch-sync" can create branches and fast-forward non-checked-out
branches, but leaves diverged or locally advanced branches unchanged.

Run "${PACKAGE_NAME} init" to prepare a project, and "${PACKAGE_NAME} <command> --help"
for details on each command.

Documentation: https://yjjosh.github.io/Workler
`);
}
