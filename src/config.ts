import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, SETUP_RECORD_FILE, WORKSPACES_DIR } from './constants';
import { WorklerError } from './errors';
import { findSymlinkAncestor, isCorrectSymlink, pathsHaveSameContent } from './fs-utils';
import type { ProjectEntry, SetupCommand, WorklerConfig, WorklerRule } from './types';

const EXPECTED_SYNTAX =
  'copy <path> | link <path> | project <path> | setup [--if-missing <path>] <command>  (quote paths that contain spaces, "#" after whitespace starts a comment)';
const SETUP_ACTION = 'setup';
const IF_MISSING_OPTION = '--if-missing';

function parseError(lineNumber: number, column: number, rawLine: string, message: string, expected: string): never {
  throw new WorklerError(
    'CONFIG_INVALID',
    `${CONFIG_FILE}:${lineNumber}:${column}: ${message}\n` +
      `  ${lineNumber} | ${rawLine}\n` +
      `  expected: ${expected}`,
    { file: CONFIG_FILE, line: lineNumber, column },
  );
}

// A "#" starts a comment only outside quotes and at the start or after
// whitespace, so file#1.txt keeps its "#".
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

// `line` is comment-stripped; `start` is the 0-based index of the path.
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

interface ParsedSetupLine {
  setup: SetupCommand;
  // 1-based column of the `--if-missing` path, for error messages.
  guardColumn?: number;
}

// The command is taken verbatim from the raw line, with no inline comments:
// cmd.exe has no "#" comments, and in sh only the shell decides what one is.
function parseSetupLine(rawLine: string, actionStart: number, lineNumber: number): ParsedSetupLine {
  let cursor = actionStart + SETUP_ACTION.length;
  // 1-based column after the last thing parsed, for "missing ..." errors.
  let afterLast = cursor + 1;
  const skipWhitespace = (): void => {
    while (cursor < rawLine.length && /\s/.test(rawLine[cursor])) {
      cursor++;
    }
  };
  skipWhitespace();

  let ifMissing: string | undefined;
  let guardColumn: number | undefined;
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
    guardColumn = pathStart + 1;
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
  return ifMissing === undefined ? { setup: { command, raw: rawLine.trim() } } : { setup: { command, ifMissing, raw: rawLine.trim() }, guardColumn };
}

// Workler writes these into a group workspace folder, so group rules and
// guards may not name them.
const GROUP_WORKSPACE_FILES = [CONFIG_FILE, SETUP_RECORD_FILE];

// Anything below the file counts: a guard at `.workler-setup.json/stamp`
// would put a folder where the record goes.
function reservedGroupFile(targetPath: string): string | undefined {
  const first = targetPath.split('/')[0].toLowerCase();
  return GROUP_WORKSPACE_FILES.find((file) => first === file.toLowerCase());
}

// Remembered until the file turns out to declare projects.
interface ReservedUse {
  lineNumber: number;
  column: number;
  rawLine: string;
  file: string;
  use: 'rule' | 'guard';
}

interface ConfigEntry {
  kind: 'rule' | 'project';
  path: string;
}

// The whole file is still validated, so a broken file fails everywhere.
export function readRules(root: string): WorklerRule[] {
  return readConfig(root).rules;
}

export function readSetupCommands(root: string): SetupCommand[] {
  return readConfig(root).setup;
}

/**
 * Paths `remove` and `clean` do not count as local data, because apply and setup recreate them: rule
 * outputs that match their source and guard paths in `produced`. A .workler that does not parse yields none.
 */
export function managedWorkspacePaths(root: string, workspace: string, produced: readonly string[]): string[] {
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
    if (ruleOutputInPlace(root, workspace, rule)) {
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

// True only when apply would leave the destination as it is (passes its symlink checks, matches the source).
// An edited copy of .env is data, and so is whatever cannot be inspected.
function ruleOutputInPlace(root: string, workspace: string, rule: WorklerRule): boolean {
  const source = path.join(root, rule.targetPath);
  const destination = path.join(workspace, rule.targetPath);
  try {
    if (findSymlinkAncestor(root, source) !== undefined || !fs.existsSync(source)) {
      return false;
    }
    if (findSymlinkAncestor(workspace, destination) !== undefined) {
      return false;
    }
    if (rule.action === 'link' && isCorrectSymlink(destination, source)) {
      return true;
    }
    fs.lstatSync(destination);
    const content = rule.action === 'link' ? fs.realpathSync(source) : source;
    return pathsHaveSameContent(content, destination, source);
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
  let reservedUse: ReservedUse | undefined;
  const projects: ProjectEntry[] = [];
  const setup: SetupCommand[] = [];
  const guards: { path: string; lineNumber: number; column: number; rawLine: string }[] = [];
  const entries: ConfigEntry[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    // Decided on the raw line, so comment stripping never touches a command.
    const rawActionStart = rawLine.length - rawLine.trimStart().length;
    const rawAction = rawLine.slice(rawActionStart).match(/^\S+/)?.[0] ?? '';
    if (rawAction === SETUP_ACTION) {
      const parsed = parseSetupLine(rawLine, rawActionStart, lineNumber);
      setup.push(parsed.setup);
      if (parsed.setup.ifMissing !== undefined && parsed.guardColumn !== undefined) {
        guards.push({ path: parsed.setup.ifMissing, lineNumber, column: parsed.guardColumn, rawLine });
      }
      // A guard there would collide with the setup record, or never be missing.
      const reserved = parsed.setup.ifMissing === undefined ? undefined : reservedGroupFile(parsed.setup.ifMissing);
      if (reserved !== undefined && parsed.guardColumn !== undefined && !reservedUse) {
        reservedUse = { lineNumber, column: parsed.guardColumn, rawLine, file: reserved, use: 'guard' };
      }
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

    // A group rule for these could only conflict with Workler's own file.
    const reserved = reservedGroupFile(targetPath);
    if (entry.kind === 'rule' && !reservedUse && reserved !== undefined) {
      reservedUse = { lineNumber, column: pathStart + 1, rawLine, file: reserved, use: 'rule' };
    }

    // Overlapping entries would make behaviour and safety depend on line
    // order: a rule for `cache/file` would traverse a link at `cache`.
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

  if (reservedUse && projects.length > 0) {
    const what = reservedUse.use === 'rule' ? 'manage' : 'guard a setup command with';
    parseError(
      reservedUse.lineNumber,
      reservedUse.column,
      reservedUse.rawLine,
      `a project group cannot ${what} ${reservedUse.file}: Workler writes that file into group workspaces itself`,
      `a path other than ${reservedUse.file}`,
    );
  }

  // A guard into a project must use its spelling: on a case-sensitive file system
  // `PROJECTS/API/generated` lies outside the member that `list` and `remove` credit it to.
  for (const guard of guards) {
    for (const project of projects) {
      if (pathsOverlap(guard.path, project.path) && !spelledLike(guard.path, project.path)) {
        parseError(
          guard.lineNumber,
          guard.column,
          guard.rawLine,
          `setup guard "${guard.path}" spells the project path "${project.path}" differently`,
          `the project line's spelling, ${project.path}`,
        );
      }
    }
  }

  return { rules, projects, setup };
}

/** Same entry, or parent and child. Case-insensitive: `API` and `api` are one folder on a case-insensitive file system. */
export function pathsOverlap(first: string, second: string): boolean {
  const firstParts = first.split('/').map((part) => part.toLowerCase());
  const secondParts = second.split('/').map((part) => part.toLowerCase());
  const shared = Math.min(firstParts.length, secondParts.length);
  const samePrefix = firstParts.slice(0, shared).every((part, index) => part === secondParts[index]);
  return samePrefix && (firstParts.length === shared || secondParts.length === shared);
}

/** The part of `child` strictly inside `parent`, else undefined. Case-sensitive: readConfig makes guards use the project's spelling. */
export function pathBelow(child: string, parent: string): string | undefined {
  const childParts = child.split('/');
  const parentParts = parent.split('/');
  if (childParts.length <= parentParts.length) {
    return undefined;
  }
  const inside = parentParts.every((part, index) => part === childParts[index]);
  return inside ? childParts.slice(parentParts.length).join('/') : undefined;
}

// Compares the shared leading segments, case included.
function spelledLike(first: string, second: string): boolean {
  const firstParts = first.split('/');
  const secondParts = second.split('/');
  const shared = Math.min(firstParts.length, secondParts.length);
  return firstParts.slice(0, shared).every((part, index) => part === secondParts[index]);
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
  // Both syntaxes on every host: a committed `C:\\...` or UNC rule must not
  // pass as a relative filename on POSIX.
  if (path.posix.isAbsolute(targetPath) || path.win32.isAbsolute(targetPath)) {
    parseError(lineNumber, column, rawLine, `absolute paths are not allowed: "${targetPath}"`, 'a path relative to the project root');
  }

  const rawParts = targetPath.split(/[\\/]+/).filter(Boolean);
  if (rawParts.includes('..')) {
    parseError(lineNumber, column, rawLine, `paths with ".." are not allowed: "${targetPath}"`, 'a path that stays inside the project root');
  }

  // Drop `.` components before the protected-path checks, so `./.git` is
  // caught and `link .` with --force cannot replace the clone with a symlink.
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

  // One spelling, so `a\\b` means the same nested path on POSIX and Windows.
  return parts.join('/');
}

/** False when the parser, which has no escapes, cannot read the path back: line breaks, backslashes, both quote kinds. */
export function canWriteConfigPath(value: string): boolean {
  return !/[\r\n\\]/.test(value) && !(value.includes('"') && value.includes("'"));
}

/** Quotes with whichever quote the path lacks, when it needs quoting. */
export function quoteConfigPath(value: string): string {
  if (!/[\s#"']/.test(value)) {
    return value;
  }
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}
