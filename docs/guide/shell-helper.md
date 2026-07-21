# Shell switching (`wcd`)

A CLI cannot directly `cd` your current shell, so Workler ships a tiny shell function instead.

## Setup

Load the helper in your shell (add this to `~/.zshrc` or `~/.bashrc`):

```sh
eval "$(workler shell-init)"
```

## Usage

```sh
wcd feature-a    # cd into a workspace
wcd main         # back to the main project
```

`wcd <name>` is just `cd "$(workler path <name>)"` — it resolves the workspace name against the nearest enclosing workler project, so it also works between [nested workspaces](/guide/nested-workspaces).

Unknown names fail with `workler path`'s error and leave your shell where it is:

```text
$ wcd nope
workler: no workspace named "nope"
```

## What `shell-init` prints

`workler shell-init` writes the function definition to stdout — nothing more, no side effects:

```sh
wcd() {
  if [ "$#" -eq 0 ]; then
    echo "usage: wcd <workspace>" >&2
    return 2
  fi
  local dest
  dest="$(workler path "$1")" || return $?
  cd "$dest"
}
```

If you prefer another name, wrap it yourself — the building block is [`workler path`](/reference/cli/path).
