'use strict';
// Cross-platform entry point for `npm test`.
//
// `node --test test/*.test.js` relies on the SHELL expanding the glob. npm
// runs scripts through cmd.exe on Windows, which does not, and `node --test`
// only learned to expand glob patterns itself in Node 21 — so the plain glob
// silently breaks on Windows and on the older Node versions we support.
// Enumerating the files here works everywhere from Node 18 up.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

if (files.length === 0) {
  console.error('no test files found in', __dirname);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
