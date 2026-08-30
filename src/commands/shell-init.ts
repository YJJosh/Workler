import { assertNoArgs } from '../cli-utils';
import { PACKAGE_NAME } from '../constants';

export function shellInitCommand(args: string[]): void {
  if (assertNoArgs(args, 'shell-init')) return;
  console.log(`wcd() {
  if [ "$#" -eq 0 ]; then
    echo "usage: wcd <workspace>" >&2
    return 2
  fi
  local dest
  dest="$(${PACKAGE_NAME} path "$1")" || return $?
  cd "$dest"
}`);
}
