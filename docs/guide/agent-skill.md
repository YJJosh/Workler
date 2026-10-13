# Agent skill

Coding agents can learn Workler from a skill: one `SKILL.md` file that tells the agent when to use Workler, which commands it needs, how to work in a workspace and remove it without losing anything, and where to read the documentation for the version that is installed.

## Install

The latest skill, from `main`:

```bash
npx skills add YJJosh/Workler
```

The skill for the Workler version you have installed:

```bash
npx skills add "https://github.com/YJJosh/Workler/tree/v$(workler --version)/skills/workler"
```

The [`skills`](https://github.com/vercel-labs/skills) installer works with Claude Code, Codex, Cursor, OpenCode and most other coding agents. It asks which of your agents should get the skill and whether to install it into the current project or for your user. `npx skills update` keeps the latest one current; run the second command again after upgrading Workler. Releases from before the skill was added don't include it.

To install it by hand, copy [`skills/workler/SKILL.md`](https://github.com/YJJosh/Workler/blob/main/skills/workler/SKILL.md) into a `workler` folder in your agent's skills directory. For an agent without skills, add the file's contents to its instructions.

## Docs that match the installed version

This site shows the latest release. The skill therefore has the agent run `workler --version` and read the Markdown source of these pages at that release's tag:

```text
https://raw.githubusercontent.com/YJJosh/Workler/v<version>/docs/<page>.md
```

The tag is the commit the release was built from, so an agent working with an older Workler does not follow instructions for features it does not have yet.

## What the skill contains

- the command overview, the branch choices of `add`, and the `.workler` rules and setup commands
- how to work in a workspace: one per task or agent, review before pushing, check unfamiliar setup commands before they run
- how to remove a workspace without losing local data or branches
- project groups, and using Workler together with [Portler](https://github.com/YJJosh/Portler)
- where to find the docs for the installed version

::: details Show SKILL.md

<<< @/../skills/workler/SKILL.md{md}

:::
