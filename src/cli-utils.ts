import { PACKAGE_NAME } from './constants';

export function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} needs a value`);
  }
  return value;
}

// Returns true when help was printed so simple no-argument commands can stop
// before doing any discovery or mutation.
export function assertNoArgs(args: string[], command: string): boolean {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(`usage: ${PACKAGE_NAME} ${command}`);
    return true;
  }
  if (args.length > 0) {
    throw new Error(`usage: ${PACKAGE_NAME} ${command}`);
  }
  return false;
}

export interface CommandArgsSpec {
  command: string;
  usage: string;
  booleanFlags?: string[];
  valueFlags?: string[];
  minPositionals: number;
  maxPositionals: number;
}

export interface ParsedCommandArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
  help: boolean;
}

// Shared flag/positional parsing for the workspace commands. Does not print
// or exit: on -h/--help it returns early with help=true (skipping arity
// checks, since -h anywhere must win) and leaves usage output to the caller;
// all other failures throw and flow through cli.ts's single error handler.
export function parseCommandArgs(args: string[], spec: CommandArgsSpec): ParsedCommandArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const booleanFlags = spec.booleanFlags ?? [];
  const valueFlags = spec.valueFlags ?? [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      return { flags, positionals, help: true };
    }

    if (booleanFlags.includes(arg)) {
      flags[arg.slice(2)] = true;
      continue;
    }

    const valueFlag = valueFlags.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (valueFlag) {
      flags[valueFlag.slice(2)] = arg === valueFlag ? requireValue(args, ++i, valueFlag) : arg.slice(valueFlag.length + 1);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`unknown ${spec.command} option: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length < spec.minPositionals || positionals.length > spec.maxPositionals) {
    throw new Error(`usage: ${spec.usage}`);
  }

  return { flags, positionals, help: false };
}
