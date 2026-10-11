# workler init

Optionally create a starter rules file and prepare Workler's local directories.

You can use Workler directly in any Git repository without running `init`. This command is a convenience for projects that want a `.workler` file or prefer to create the local directory up front.

```bash
workler init
```

## Behavior

Run anywhere inside a repository; Workler uses the Git top level:

1. Creates a starter [`.workler`](/reference/configuration) file with commented syntax examples — kept as-is if it already exists.
2. Creates the `.worktrees/` directory.
3. Excludes `.worktrees/` from git via `.git/info/exclude` — local to your machine, so your committed `.gitignore` is untouched.
4. Records the project as a workler root (`git config workler.root` and `workler.name main`).

Outside a git repository, the exclude line goes to `.gitignore` instead, with a warning.

In a plain folder that holds repositories (directly below it or one level deeper, like `projects/api`), `init` writes a [project group](/guide/project-groups) `.workler` with one `project <path>` line per repository found. Hidden directories, `node_modules`, and linked `git worktree` checkouts are skipped, and so is a repository whose path cannot be written to `.workler` (it holds both `"` and `'`, a backslash, or a line break): `init` prints a `skipped` line for it; rename the folder to declare it. Two repositories whose paths the file could not tell apart (`API` next to `api` on a case-sensitive file system, or `Projects` next to `projects/api`) are handled the same way: the first one found is declared, and the other gets a `skipped` line naming the path it overlaps, because writing both would leave a file that does not parse. The folder is the project even when an outer repository encloses it. An existing `.workler` is left alone, even one that does not parse (`init` then prints a `warning` line with the parse error and still prepares the folder); repositories it does not declare are pointed out with a hint whose `project` lines are quoted the way the file needs them, so they paste as they are.

`init` is **idempotent**—run it as often as you like. It is never required for ordinary Git repositories.

## Output

```text
created .workler
ready   .worktrees
ignored .worktrees/ in .git/info/exclude
```

On a second run, `created` becomes `exists`.

In a group folder:

```text
created .workler
project projects/api
project projects/web
project tools
ready   .worktrees
ignored .worktrees/ in .gitignore
```

## Examples

```bash
cd my-project
workler init
echo "link node_modules" >> .workler
echo "copy .env" >> .workler
workler add feature-a
```
