import path from 'node:path';
import { assertNoArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';

function invokedExecutableName(): string {
  const scriptName = path.basename(process.argv[1] || '').replace(/\.js$/, '');
  return scriptName && scriptName !== 'cli' ? scriptName : PACKAGE_NAME;
}

export function shellInitCommand(args: string[]): void {
  if (assertNoArgs(args, 'shell-init')) return;
  const executableName = invokedExecutableName();
  console.log(`wcd() {
  if [ "$#" -eq 0 ]; then
    echo "usage: wcd <workspace>" >&2
    return 2
  fi
  local dest
  dest="$(${executableName} path "$1")" || return $?
  cd "$dest"
}`);
}
