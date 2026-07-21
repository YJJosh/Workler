import { parseCommandArgs } from '../cli-utils';
import { ensureGitRepo } from '../git';
import { withProjectLock } from '../lock';
import { fetchOrigin, listSyncTargets, nameWidth } from '../multi-git';
import { findWorklerRoot } from '../workspaces';
import type { CliContext } from '../types';

export function fetchCommand(args: string[], context: CliContext): void {
  const usage = `${context.cliName} fetch`;
  const parsed = parseCommandArgs(args, {
    command: 'fetch',
    usage,
    minPositionals: 0,
    maxPositionals: 0,
  });
  if (parsed.help) {
    console.log(`usage: ${usage}

Runs \`git fetch --prune origin\` in the main project and every workspace.
Workspaces without an origin remote are skipped with a note.`);
    return;
  }

  const root = findWorklerRoot(process.cwd(), context.cliName);
  ensureGitRepo(root, 'fetch');

  withProjectLock(root, 'fetch', () => {
    const targets = listSyncTargets(root);
    const width = nameWidth(targets);
    let failures = 0;
    for (const target of targets) {
      let line: string;
      if (target.broken) {
        line = `skipped (broken: ${target.broken})`;
      } else {
        const result = fetchOrigin(target.path);
        line = result.line;
        if (result.failed) failures++;
      }
      console.log(`${target.name.padEnd(width)}  ${line}`);
    }
    if (failures > 0) {
      throw new Error(`${failures} fetch${failures === 1 ? '' : 'es'} failed`);
    }
  });
}
