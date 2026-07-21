import fs from 'node:fs';
import path from 'node:path';

// Existing paths can have several valid spellings: a symlink alias, macOS's
// /var -> /private/var mapping, Windows drive/case differences, or an 8.3
// short name. Canonicalize before identity checks; for a not-yet-created path,
// fall back to its resolved lexical spelling.
export function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function pathsReferToSameLocation(left: string, right: string): boolean {
  const leftCanonical = canonicalPath(left);
  const rightCanonical = canonicalPath(right);
  return process.platform === 'win32'
    ? leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
    : leftCanonical === rightCanonical;
}

export function assertInside(root: string, child: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

// Lexical containment is not enough before a destructive filesystem action:
// `<workspace>/dir/file` can escape when `dir` is a symlink or junction. Return
// the first such ancestor (the destination itself is intentionally excluded so
// a rule may still replace a conflicting symlink at exactly its target path).
export function findSymlinkAncestor(root: string, child: string): string | undefined {
  assertInside(root, child, 'path escaped its expected root');
  const relative = path.relative(path.resolve(root), path.resolve(child));
  const parts = relative.split(path.sep).filter(Boolean);
  let current = path.resolve(root);

  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Once an ancestor does not exist, none of its descendants can exist.
        return undefined;
      }
      throw error;
    }
  }
  return undefined;
}

export function addLineIfMissing(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let text = '';
  if (fs.existsSync(filePath)) {
    text = fs.readFileSync(filePath, 'utf8');
  }

  const lines = text.split(/\r?\n/).map((item) => item.trim());
  if (lines.includes(line)) {
    return;
  }

  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(filePath, `${prefix}${line}\n`);
}

export function isBrokenSymlink(filePath: string): boolean {
  // lstat stats the link entry itself (it does NOT follow the link), so it
  // succeeds for a broken symlink; existsSync follows the link and tells us
  // whether the target resolves.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (_) {
    return false;
  }
  return stat.isSymbolicLink() && !fs.existsSync(filePath);
}

export function isCorrectSymlink(destination: string, source: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (_) {
    return false;
  }

  if (!stat.isSymbolicLink()) {
    return false;
  }

  const linkTarget = fs.readlinkSync(destination);
  const resolved = path.resolve(path.dirname(destination), linkTarget);
  return path.resolve(resolved) === path.resolve(source);
}

function filesHaveSameContent(left: string, right: string): boolean {
  const bufferSize = 64 * 1024;
  const leftBuffer = Buffer.alloc(bufferSize);
  const rightBuffer = Buffer.alloc(bufferSize);
  const leftFd = fs.openSync(left, 'r');

  try {
    const rightFd = fs.openSync(right, 'r');
    try {
      while (true) {
        const leftRead = fs.readSync(leftFd, leftBuffer, 0, bufferSize, null);
        const rightRead = fs.readSync(rightFd, rightBuffer, 0, bufferSize, null);
        if (leftRead !== rightRead) {
          return false;
        }
        if (leftRead === 0) {
          return true;
        }
        if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) {
          return false;
        }
      }
    } finally {
      fs.closeSync(rightFd);
    }
  } finally {
    fs.closeSync(leftFd);
  }
}

export function pathsHaveSameContent(left: string, right: string): boolean {
  let leftStat: fs.Stats;
  let rightStat: fs.Stats;

  try {
    leftStat = fs.lstatSync(left);
    rightStat = fs.lstatSync(right);
  } catch (_) {
    return false;
  }

  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return leftStat.isSymbolicLink()
      && rightStat.isSymbolicLink()
      && fs.readlinkSync(left) === fs.readlinkSync(right);
  }

  if (leftStat.isFile() || rightStat.isFile()) {
    if (!leftStat.isFile() || !rightStat.isFile()) {
      return false;
    }
    if (leftStat.size !== rightStat.size) {
      return false;
    }
    // No mtime fast path: equal size + mtime does not guarantee equal bytes
    // (touch -r, timestamp-restoring tools), and applyCopy relies on this
    // check to detect conflicts when --force is not set.
    return filesHaveSameContent(left, right);
  }

  if (leftStat.isDirectory() || rightStat.isDirectory()) {
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) {
      return false;
    }

    const leftEntries = fs.readdirSync(left).sort();
    const rightEntries = fs.readdirSync(right).sort();
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }

    for (let index = 0; index < leftEntries.length; index++) {
      if (leftEntries[index] !== rightEntries[index]) {
        return false;
      }
      if (!pathsHaveSameContent(path.join(left, leftEntries[index]), path.join(right, rightEntries[index]))) {
        return false;
      }
    }

    return true;
  }

  return false;
}

export function relativeToCwd(filePath: string): string {
  // Windows temp paths may alternate between an 8.3 spelling
  // (`C:\\Users\\RUNNER~1`) and the long spelling used by process.cwd(). macOS
  // similarly aliases /var to /private/var. Canonicalize existing paths before
  // deciding whether one is below the other, or user-facing output becomes an
  // unexpected absolute path.
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };

  const canonicalFile = canonical(filePath);
  const relative = path.relative(canonical(process.cwd()), canonicalFile);
  if (!relative) {
    return '.';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return canonicalFile;
  }
  return relative;
}
