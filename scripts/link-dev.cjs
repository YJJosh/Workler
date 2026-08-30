'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ALIAS = 'devworkler';
const INVOKED_AS_ENV = 'WORKLER_INVOKED_AS';

function npmGlobalPrefix() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, 'prefix', '--global'], {
      encoding: 'utf8',
    }).trim();
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmCommand, ['prefix', '--global'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function removeIfPresent(file) {
  fs.rmSync(file, { force: true });
}

function createWindowsShims(binDir, target) {
  const shellShim = path.join(binDir, ALIAS);
  const cmdShim = `${shellShim}.cmd`;
  const powershellShim = `${shellShim}.ps1`;

  for (const shim of [shellShim, cmdShim, powershellShim]) {
    removeIfPresent(shim);
  }

  fs.writeFileSync(
    shellShim,
    `#!/bin/sh\n${INVOKED_AS_ENV}=${ALIAS} exec node ${shellQuote(target)} "$@"\n`,
    { mode: 0o755 },
  );

  const cmdTarget = target.replace(/%/g, '%%');
  fs.writeFileSync(
    cmdShim,
    `@ECHO off\r\nSETLOCAL\r\nSET "${INVOKED_AS_ENV}=${ALIAS}"\r\nSET "NODE_EXE=node"\r\nIF EXIST "%~dp0node.exe" SET "NODE_EXE=%~dp0node.exe"\r\n"%NODE_EXE%" "${cmdTarget}" %*\r\nSET "EXIT_CODE=%ERRORLEVEL%"\r\nENDLOCAL & EXIT /B %EXIT_CODE%\r\n`,
  );

  fs.writeFileSync(
    powershellShim,
    `$node = 'node.exe'\nif (Test-Path "$PSScriptRoot/node.exe") { $node = "$PSScriptRoot/node.exe" }\n$previousInvokedAs = [Environment]::GetEnvironmentVariable('${INVOKED_AS_ENV}', 'Process')\ntry {\n  [Environment]::SetEnvironmentVariable('${INVOKED_AS_ENV}', '${ALIAS}', 'Process')\n  & $node ${powershellQuote(target)} @args\n  $exitCode = $LASTEXITCODE\n} finally {\n  [Environment]::SetEnvironmentVariable('${INVOKED_AS_ENV}', $previousInvokedAs, 'Process')\n}\nexit $exitCode\n`,
  );
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const target = path.join(projectRoot, 'dist', 'cli.js');
  if (!fs.existsSync(target)) {
    throw new Error(`missing built CLI: ${target}`);
  }

  const prefix = npmGlobalPrefix();
  if (!prefix) {
    throw new Error('npm returned an empty global prefix');
  }

  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    createWindowsShims(binDir, target);
  } else {
    const aliasPath = path.join(binDir, ALIAS);
    removeIfPresent(aliasPath);
    fs.chmodSync(target, fs.statSync(target).mode | 0o111);
    fs.symlinkSync(target, aliasPath);
  }

  console.log(`linked ${ALIAS} -> ${target}`);
}

try {
  main();
} catch (error) {
  console.error(`dev:link: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
