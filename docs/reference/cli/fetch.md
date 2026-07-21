# workler fetch

Fetch from `origin` in the main project and every workspace.

```bash
workler fetch
```

## Behavior

Runs `git fetch --prune origin` everywhere. Because every workspace is an independent clone with its own fetch state, fetching in one does nothing for the others — this command covers them all in one go.

- Workspaces without an `origin` remote are skipped with a note.
- A failing fetch (network, auth) is reported for that workspace and does not stop the others. After every workspace has been attempted, the command exits non-zero if any fetch failed.
- Broken clones are skipped with their reason.

Nothing is merged or checked out — working trees are untouched. Use [`workler sync`](/reference/cli/sync) to also fast-forward.

## Output

```text
main       fetched origin
feature-a  fetched origin
local-exp  skipped (no origin remote)
flaky      failed: could not read from remote repository
```

## Examples

```bash
workler fetch && workler status   # update, then see who is behind
```
