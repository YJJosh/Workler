import { assertNoArgs } from '../cli-utils';
import type { CliContext } from '../types';

export function shellInitCommand(args: string[], context: CliContext): void {
  if (assertNoArgs(args, 'shell-init', context)) return;
  console.log(`wcd() {
  if [ "$#" -eq 0 ]; then
    echo "usage: wcd <workspace>" >&2
    return 2
  fi
  local dest
  dest="$(${context.cliName} path "$1")" || return $?
  cd "$dest"
}`);
}
