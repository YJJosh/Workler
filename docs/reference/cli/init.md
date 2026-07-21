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

`init` is **idempotent**—run it as often as you like. It is never required for ordinary Git repositories.

## Output

```text
created .workler
ready   .worktrees
ignored .worktrees/ in .git/info/exclude
```

On a second run, `created` becomes `exists`.

## Examples

```bash
cd my-project
workler init
echo "link node_modules" >> .workler
echo "copy .env" >> .workler
workler add feature-a
```
