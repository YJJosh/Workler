#!/usr/bin/env node
import { runCommand } from './commands';
import { PACKAGE_NAME } from './constants';

function main(): void {
  const args = process.argv.slice(2);
  const command = args.shift();

  try {
    runCommand(command, args);
  } catch (error) {
    console.error(`${PACKAGE_NAME}: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
