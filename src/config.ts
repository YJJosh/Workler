import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import type { WorklerRule } from './types';

const EXPECTED_SYNTAX = 'copy <path> | link <path>  (quote paths that contain spaces, "#" after whitespace starts a comment)';

// Throws with .workler:<line>:<column>, the offending line, and what was
// expected, so config mistakes are easy to locate and fix.
function parseError(lineNumber: number, column: number, rawLine: string, message: string, expected: string): never {
  throw new WorklerError(
    'CONFIG_INVALID',
    `${CONFIG_FILE}:${lineNumber}:${column}: ${message}\n` +
      `  ${lineNumber} | ${rawLine}\n` +
      `  expected: ${expected}`,
    { file: CONFIG_FILE, line: lineNumber, column },
  );
}

// Removes an inline comment: a "#" outside quotes that is either the first
// character or preceded by whitespace. A "#" inside a quoted path (or glued
// to a word, like file#1.txt) is kept.
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

// Parses the path portion of a rule line. `line` is the comment-stripped
// line and `start` is the 0-based index where the path begins. Supports
// double- or single-quoted paths for spaces and "#", or a bare path that
// runs to the end of the line.
function parseRulePath(line: string, start: number, lineNumber: number, rawLine: string): string {
  const quote = line[start];
  if (quote === '"' || quote === "'") {
    const end = line.indexOf(quote, start + 1);
    if (end === -1) {
      parseError(lineNumber, start + 1, rawLine, `unterminated ${quote}...${quote} quoted path`, `a closing ${quote} before the end of the line`);
    }
    const rest = line.slice(end + 1);
    if (rest.trim()) {
      const extraColumn = end + 2 + (rest.length - rest.trimStart().length);
      parseError(lineNumber, extraColumn, rawLine, `unexpected text after quoted path: "${rest.trim()}"`, 'nothing after the closing quote (or a "# comment")');
    }
    return line.slice(start + 1, end);
  }
  return line.slice(start).trim();
}

export function readRules(root: string): WorklerRule[] {
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const text = fs.readFileSync(configPath, 'utf8');
  const rules: WorklerRule[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const line = stripInlineComment(rawLine);
    if (!line.trim()) {
      continue;
    }

    const actionStart = line.length - line.trimStart().length;
    const actionMatch = line.slice(actionStart).match(/^\S+/);
    const action = actionMatch ? actionMatch[0] : '';
    if (action !== 'copy' && action !== 'link') {
      parseError(index + 1, actionStart + 1, rawLine, `unknown action "${action}"`, EXPECTED_SYNTAX);
    }

    const afterAction = line.slice(actionStart + action.length);
    const pathStart = actionStart + action.length + (afterAction.length - afterAction.trimStart().length);
    if (!afterAction.trim()) {
      parseError(lineNumber, actionStart + action.length + 1, rawLine, `missing path after "${action}"`, EXPECTED_SYNTAX);
    }

    const parsedPath = parseRulePath(line, pathStart, lineNumber, rawLine);
    const targetPath = validateRulePath(parsedPath, lineNumber, pathStart + 1, rawLine);

    // Parent/child rules are not independent: a link at `cache` would make a
    // later rule for `cache/file` traverse that link, while two rules for the
    // same path necessarily conflict. Reject the ambiguous configuration
    // instead of making behavior (and safety) depend on line order.
    const targetParts = targetPath.split('/').map((part) => part.toLowerCase());
    for (const existing of rules) {
      const existingParts = existing.targetPath.split('/').map((part) => part.toLowerCase());
      const shared = Math.min(targetParts.length, existingParts.length);
      const samePrefix = targetParts.slice(0, shared).every((part, partIndex) => part === existingParts[partIndex]);
      if (samePrefix && (targetParts.length === shared || existingParts.length === shared)) {
        parseError(
          lineNumber,
          pathStart + 1,
          rawLine,
          `rule path overlaps an earlier rule: "${targetPath}" and "${existing.targetPath}"`,
          'non-overlapping rule paths (manage either a parent or its child, not both)',
        );
      }
    }

    rules.push({ action, targetPath, raw: rawLine.trim() });
  }

  return rules;
}

function validateRulePath(targetPath: string, lineNumber: number, column: number, rawLine: string): string {
  if (!targetPath) {
    parseError(lineNumber, column, rawLine, 'empty path', 'a path relative to the project root');
  }
  if (targetPath.includes('\0')) {
    parseError(lineNumber, column, rawLine, 'paths cannot contain a NUL character', 'a filesystem path without NUL characters');
  }
  // Check both syntaxes regardless of the host running Workler. A committed
  // `C:\\...` or UNC rule must not become a harmless-looking relative filename
  // when the same project is used on POSIX.
  if (path.posix.isAbsolute(targetPath) || path.win32.isAbsolute(targetPath)) {
    parseError(lineNumber, column, rawLine, `absolute paths are not allowed: "${targetPath}"`, 'a path relative to the project root');
  }

  const rawParts = targetPath.split(/[\\/]+/).filter(Boolean);
  if (rawParts.includes('..')) {
    parseError(lineNumber, column, rawLine, `paths with ".." are not allowed: "${targetPath}"`, 'a path that stays inside the project root');
  }

  // Leading `./` components used to bypass the protected-path checks, and a
  // rule consisting only of `.` resolved to the workspace root itself. With
  // --force, `link .` could therefore delete the clone and replace it with a
  // symlink. Canonicalize harmless dot components before all checks.
  const parts = rawParts.filter((part) => part !== '.');
  if (parts.length === 0) {
    parseError(lineNumber, column, rawLine, 'managing the project/workspace root is not allowed', 'a path below the project root');
  }

  const first = parts[0].toLowerCase();
  if (first === '.git') {
    parseError(lineNumber, column, rawLine, 'managing .git is not allowed', 'a path outside .git');
  }
  if (first === WORKSPACES_DIR.toLowerCase()) {
    parseError(lineNumber, column, rawLine, `managing ${WORKSPACES_DIR} is not allowed`, `a path outside ${WORKSPACES_DIR}`);
  }

  // Store one portable spelling so `a\\b` does not mean a single filename on
  // POSIX and a nested path on Windows, and so overlap checks are reliable.
  return parts.join('/');
}
