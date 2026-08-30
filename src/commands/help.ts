import { CONFIG_FILE, PACKAGE_NAME, VERSION, WORKSPACES_DIR } from '../constants';

export function helpCommand(): void {
  console.log(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${PACKAGE_NAME} --version
  ${PACKAGE_NAME} init
  ${PACKAGE_NAME} add <name> [base] [--branch <branch>] [--checkout <ref>] [--force] [--dry-run]
  ${PACKAGE_NAME} apply [name] [--all] [--force] [--dry-run]
  ${PACKAGE_NAME} list
  ${PACKAGE_NAME} path <name>
  ${PACKAGE_NAME} remove <name> [--force]
  ${PACKAGE_NAME} shell-init
  ${PACKAGE_NAME} status
  ${PACKAGE_NAME} fetch
  ${PACKAGE_NAME} sync
  ${PACKAGE_NAME} branch-sync

Flags:
  --dry-run  print what would be copied/linked/replaced without changing anything
  --force    replace destinations that already exist and differ

Workler does not use git worktree: it creates normal local clones under
${WORKSPACES_DIR}/ and applies copy/link rules from an optional ${CONFIG_FILE} file.
"sync" and "branch-sync" are fail-safe: dirty workspaces and diverged or
checked-out branches are never touched.

Run "${PACKAGE_NAME} init" to prepare a project, and "${PACKAGE_NAME} <command> --help"
for details on each command.

Documentation: https://yjjosh.github.io/Workler
`);
}
