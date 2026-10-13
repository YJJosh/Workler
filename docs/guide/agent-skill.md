# Agent skill

Coding agents can learn Workler from a skill: one `SKILL.md` file that tells the agent when to use Workler, which commands it needs, how to work in a workspace and remove it without losing anything, and where to read the documentation for the version that is installed.

## Install

Download <a href="/Workler/skills/workler/SKILL.md" download>SKILL.md</a> into a `workler` folder in your agent's skills directory. For Claude Code:

```bash
mkdir -p ~/.claude/skills/workler
curl -fsSL https://yjjosh.github.io/Workler/skills/workler/SKILL.md -o ~/.claude/skills/workler/SKILL.md
```

Put it in `.claude/skills/workler/` inside a repository instead to share it with everyone who works on that project. Other agents that support `SKILL.md` skills load it from their own skills directory; for an agent without skills, add the file's contents to its instructions.

The file on this site belongs to the latest release. Download it again after upgrading Workler.

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

<<< @/public/skills/workler/SKILL.md{md}

:::
