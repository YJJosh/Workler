import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, SETUP_RECORD_FILE, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { findSymlinkAncestor } from './fs-utils';
import type { ProjectEntry, SetupCommand, WorklerConfig, WorklerRule } from './types';

const EXPECTED_SYNTAX =
  'copy <path> | link <path> | project <path> | setup [--if-missing <path>] <command>  (quote paths that contain spaces, "#" after whitespace starts a comment)';
const SETUP_ACTION = 'setup';
const IF_MISSING_OPTION = '--if-missing';

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

// A setup line is a shell command, taken verbatim: Workler must not strip a
// "#" the shell would treat as part of the command (cmd.exe has no "#"
// comments at all, and sh only sees one where the shell says so). Only
// full-line comments apply, so this works on the raw line. The one thing
// parsed before the command is an optional `--if-missing <path>` guard; its
// path follows the rule-path syntax (quoted when it holds a space or "#").
function parseSetupLine(rawLine: string, actionStart: number, lineNumber: number): SetupCommand {
  let cursor = actionStart + SETUP_ACTION.length;
  // Column (1-based) right after the last thing parsed, for "missing ..."
  // errors that point at where the command should have started.
  let afterLast = cursor + 1;
  const skipWhitespace = (): void => {
    while (cursor < rawLine.length && /\s/.test(rawLine[cursor])) {
      cursor++;
    }
  };
  skipWhitespace();

  let ifMissing: string | undefined;
  const option = rawLine.slice(cursor).match(/^--\S*/)?.[0];
  if (option !== undefined) {
    if (option !== IF_MISSING_OPTION) {
      parseError(lineNumber, cursor + 1, rawLine, `unknown setup option "${option}"`, `${IF_MISSING_OPTION} <path> before the command, or the command itself`);
    }
    cursor += option.length;
    afterLast = cursor + 1;
    skipWhitespace();
    if (cursor >= rawLine.length) {
      parseError(lineNumber, afterLast, rawLine, `missing path after "${IF_MISSING_OPTION}"`, `a path relative to the workspace, then the command`);
    }

    const pathStart = cursor;
    let parsedPath: string;
    const quote = rawLine[cursor];
    if (quote === '"' || quote === "'") {
      const end = rawLine.indexOf(quote, cursor + 1);
      if (end === -1) {
        parseError(lineNumber, cursor + 1, rawLine, `unterminated ${quote}...${quote} quoted path`, `a closing ${quote} before the command`);
      }
      parsedPath = rawLine.slice(cursor + 1, end);
      cursor = end + 1;
      if (cursor < rawLine.length && !/\s/.test(rawLine[cursor])) {
        parseError(lineNumber, cursor + 1, rawLine, `unexpected text after quoted path: "${rawLine.slice(cursor).match(/^\S+/)?.[0]}"`, 'whitespace, then the command');
      }
    } else {
      parsedPath = rawLine.slice(cursor).match(/^\S+/)?.[0] ?? '';
      cursor += parsedPath.length;
    }
    ifMissing = validateRulePath(parsedPath, lineNumber, pathStart + 1, rawLine);
    afterLast = cursor + 1;
    skipWhitespace();
  }

  const command = rawLine.slice(cursor).trim();
  if (!command) {
    const after = ifMissing === undefined ? SETUP_ACTION : `${IF_MISSING_OPTION} ${ifMissing}`;
    parseError(lineNumber, afterLast, rawLine, `missing command after "${after}"`, 'a shell command, e.g. setup pnpm install');
  }
  if (command.includes('\0')) {
    parseError(lineNumber, cursor + 1, rawLine, 'commands cannot contain a NUL character', 'a shell command without NUL characters');
  }
  return ifMissing === undefined ? { command, raw: rawLine.trim() } : { command, ifMissing, raw: rawLine.trim() };
}

// The files Workler itself writes into a group workspace folder; a group's
// own rules may not manage them.
const GROUP_WORKSPACE_FILES = [CONFIG_FILE, SETUP_RECORD_FILE];

// Every path-bearing line in the file, in order, for the overlap check.
interface ConfigEntry {
  kind: 'rule' | 'project';
  path: string;
}

// The copy/link rules of a project. `project` and `setup` lines are parsed
// and validated too (so a broken file fails everywhere), but only readConfig
// exposes them.
export function readRules(root: string): WorklerRule[] {
  return readConfig(root).rules;
}

// The `setup` commands of a project, in file order.
export function readSetupCommands(root: string): SetupCommand[] {
  return readConfig(root).setup;
}

// The paths a project's .workler produces inside one of its workspaces, in
// the file's portable spelling and relative to the workspace: the copy and
// link destinations apply would regenerate (see sourceRegenerates), and the
// `setup --if-missing` guard paths among `produced`, what `setup` recorded
// as created by a guarded command in that workspace (see
// recordedSetupOutputs in setup.ts). `workler apply` and `workler setup`
// regenerate them, so `remove` and the listing's `clean` do not count them
// as local data; a guard path on no record, or a destination apply would
// skip or refuse, is data like any other file. A file that cannot be parsed
// produces nothing here; the operations that need it fail on the parse
// error themselves.
export function managedWorkspacePaths(root: string, produced: readonly string[]): string[] {
  let config: WorklerConfig;
  try {
    config = readConfig(root);
  } catch (error) {
    if (error instanceof WorklerError && error.code === 'CONFIG_INVALID') {
      return [];
    }
    throw error;
  }
  const paths = new Set<string>();
  for (const rule of config.rules) {
    if (sourceRegenerates(root, rule.targetPath)) {
      paths.add(rule.targetPath);
    }
  }
  for (const command of config.setup) {
    if (command.ifMissing !== undefined && produced.includes(command.ifMissing)) {
      paths.add(command.ifMissing);
    }
  }
  return [...paths];
}

// The checks apply makes before it copies or links a rule's source: it
// exists, and no directory on the way to it is a symbolic link (apply skips
// an absent source and refuses one behind a link, so neither regenerates
// the destination; a file a user made there has nothing behind it and is
// data). A source that cannot be inspected counts as absent, the safe side.
function sourceRegenerates(root: string, targetPath: string): boolean {
  const source = path.join(root, targetPath);
  try {
    return findSymlinkAncestor(root, source) === undefined && fs.existsSync(source);
  } catch (_) {
    return false;
  }
}

export function readConfig(root: string): WorklerConfig {
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return { rules: [], projects: [], setup: [] };
  }

  const text = fs.readFileSync(configPath, 'utf8');
  const rules: WorklerRule[] = [];
  let configRule: { lineNumber: number; column: number; rawLine: string; file: string } | undefined;
  const projects: ProjectEntry[] = [];
  const setup: SetupCommand[] = [];
  const entries: ConfigEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    // Decide on the raw line whether this is a setup line, so the
    // inline-comment stripping below never touches a command.
    const rawActionStart = rawLine.length - rawLine.trimStart().length;
    const rawAction = rawLine.slice(rawActionStart).match(/^\S+/)?.[0] ?? '';
    if (rawAction === SETUP_ACTION) {
      setup.push(parseSetupLine(rawLine, rawActionStart, lineNumber));
      continue;
    }

    const line = stripInlineComment(rawLine);
    if (!line.trim()) {
      continue;
    }

    const actionStart = line.length - line.trimStart().length;
    const actionMatch = line.slice(actionStart).match(/^\S+/);
    const action = actionMatch ? actionMatch[0] : '';
    if (action !== 'copy' && action !== 'link' && action !== 'project') {
      parseError(index + 1, actionStart + 1, rawLine, `unknown action "${action}"`, EXPECTED_SYNTAX);
    }

    const afterAction = line.slice(actionStart + action.length);
    const pathStart = actionStart + action.length + (afterAction.length - afterAction.trimStart().length);
    if (!afterAction.trim()) {
      parseError(lineNumber, actionStart + action.length + 1, rawLine, `missing path after "${action}"`, EXPECTED_SYNTAX);
    }

    const parsedPath = parseRulePath(line, pathStart, lineNumber, rawLine);
    const targetPath = validateRulePath(parsedPath, lineNumber, pathStart + 1, rawLine);
    const entry: ConfigEntry = { kind: action === 'project' ? 'project' : 'rule', path: targetPath };

    // Workler writes its own copy of this file into every group workspace,
    // and its record of the group's setup outputs next to it, so a
    // group-level rule for either could only ever conflict with Workler's
    // file (or, with --force, replace it by a link that `remove` then
    // protects as local data). Remember the first such rule; it is rejected
    // below once the file turns out to declare projects.
    const reserved = GROUP_WORKSPACE_FILES.find((file) => targetPath.split('/')[0].toLowerCase() === file.toLowerCase());
    if (entry.kind === 'rule' && !configRule && reserved !== undefined) {
      configRule = { lineNumber, column: pathStart + 1, rawLine, file: reserved };
    }

    // Parent/child entries are not independent: a link at `cache` would make
    // a later rule for `cache/file` traverse that link, two rules for the same
    // path necessarily conflict, and a rule that reaches into a project (or a
    // project nested in another) would make two owners manage one tree.
    // Reject the ambiguous configuration instead of making behavior (and
    // safety) depend on line order.
    for (const existing of entries) {
      if (pathsOverlap(targetPath, existing.path)) {
        parseError(lineNumber, pathStart + 1, rawLine, overlapMessage(entry, existing, targetPath), overlapExpectation(entry, existing));
      }
    }

    entries.push(entry);
    if (action === 'project') {
      projects.push({ path: targetPath, raw: rawLine.trim() });
    } else {
      rules.push({ action, targetPath, raw: rawLine.trim() });
    }
  }

  if (configRule && projects.length > 0) {
    parseError(
      configRule.lineNumber,
      configRule.column,
      configRule.rawLine,
      `a project group cannot manage ${configRule.file}: Workler writes that file into group workspaces itself`,
      `a path other than ${configRule.file}`,
    );
  }

  return { rules, projects, setup };
}

// Whether two validated paths are the same entry or a parent and its child,
// compared the way the parser compares them: component by component and
// case-insensitively (on a case-insensitive file system `API` and `api` are
// one folder, so the file cannot tell them apart). Exported so `init` can
// leave out a discovered path that the file would reject.
export function pathsOverlap(first: string, second: string): boolean {
  const firstParts = first.split('/').map((part) => part.toLowerCase());
  const secondParts = second.split('/').map((part) => part.toLowerCase());
  const shared = Math.min(firstParts.length, secondParts.length);
  const samePrefix = firstParts.slice(0, shared).every((part, index) => part === secondParts[index]);
  return samePrefix && (firstParts.length === shared || secondParts.length === shared);
}

function overlapMessage(entry: ConfigEntry, existing: ConfigEntry, targetPath: string): string {
  const pair = `"${targetPath}" and "${existing.path}"`;
  if (entry.kind === 'rule' && existing.kind === 'rule') {
    return `rule path overlaps an earlier rule: ${pair}`;
  }
  if (entry.kind === 'project' && existing.kind === 'project') {
    return `project path overlaps an earlier project: ${pair}`;
  }
  return entry.kind === 'project'
    ? `project path overlaps an earlier rule: ${pair}`
    : `rule path overlaps an earlier project: ${pair}`;
}

function overlapExpectation(entry: ConfigEntry, existing: ConfigEntry): string {
  if (entry.kind === 'rule' && existing.kind === 'rule') {
    return 'non-overlapping rule paths (manage either a parent or its child, not both)';
  }
  if (entry.kind === 'project' && existing.kind === 'project') {
    return 'non-overlapping project paths (a project cannot contain another project)';
  }
  return "non-overlapping paths (rules that reach into a project belong in that project's own .workler)";
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

// The parser knows no escapes: a path is written bare, or inside whichever
// kind of quote it lacks. One holding both kinds, or a line break, cannot be
// written at all. Neither can one holding a backslash: the parser reads it as
// a separator (see validateRulePath), so `foo\bar` would name `foo/bar`.
export function canWriteConfigPath(value: string): boolean {
  return !/[\r\n\\]/.test(value) && !(value.includes('"') && value.includes("'"));
}

// Formats a path for a config line, and for any line shown to be pasted into
// one: whitespace, "#" or a quote need quotes to survive the parser, using
// whichever quote the path lacks (see canWriteConfigPath).
export function quoteConfigPath(value: string): string {
  if (!/[\s#"']/.test(value)) {
    return value;
  }
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}
