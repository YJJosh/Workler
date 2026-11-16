'use strict';
// Lists the test files itself: npm runs scripts through cmd.exe on Windows, which does not
// expand `test/*.test.js`, and `node --test` expands globs itself only from Node 21.

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
