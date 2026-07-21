# workler shell-init

Print the `wcd` shell function for fast workspace switching.

```bash
workler shell-init
```

## Behavior

Writes a POSIX shell function to stdout and does nothing else. Evaluate it to get `wcd`:

```sh
eval "$(workler shell-init)"
```

Put that line in `~/.zshrc` or `~/.bashrc` to have `wcd` in every shell.

## What it prints

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

`wcd <name>` resolves the name with [`workler path`](/reference/cli/path) and `cd`s there; unknown names print the error and leave the shell where it is.

## Examples

```sh
eval "$(workler shell-init)"
wcd feature-a
wcd main
```

See [Shell switching (`wcd`)](/guide/shell-helper) for background.
