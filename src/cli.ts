#!/usr/bin/env node
import path from 'node:path';
import { runCommand } from './commands';
import { PACKAGE_NAME } from './constants';
import type { CliContext } from './types';

function detectCliName(): string {
  const scriptName = path.basename(process.argv[1] || PACKAGE_NAME).replace(/\.js$/, '');
  // 'cli' means we were invoked directly as `node dist/cli.js` (this file's
  // compiled name) rather than via the bin shim; fall back to the package
  // name for readable usage text.
  return scriptName && scriptName !== 'cli' ? scriptName : PACKAGE_NAME;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args.shift();
  const context: CliContext = {
    cliName: detectCliName(),
  };

  try {
    runCommand(command, args, context);
  } catch (error) {
    console.error(`${PACKAGE_NAME}: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
