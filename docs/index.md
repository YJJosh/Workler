---
layout: home

hero:
  name: Workler
  text: Workspaces that set themselves up.
  tagline: A local workspace manager that clones your project into .worktrees/ and wires up the untracked files — node_modules, .env — with copy and link rules.
  image:
    src: /logo.svg
    alt: Workler
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: What is Workler?
      link: /guide/what-is-workler
    - theme: alt
      text: GitHub
      link: https://github.com/YJJosh/Workler

features:
  - icon: 🗂️
    title: Real clones, not git worktrees
    details: Every workspace is an ordinary local clone under .worktrees/ — its own HEAD, its own index, its own local branches. Nothing shared, nothing surprising.
  - icon: 🔗
    title: Copy & link rules
    details: An optional .workler file declares what a workspace needs — link node_modules back to the main project, copy .env into place — applied automatically on add.
  - icon: 🌿
    title: Sensible branch handling
    details: workler add feat creates and checks out a new branch; bases, existing branches, tags, and detached checkouts are all one flag away.
  - icon: 🛟
    title: Safe by default
    details: Nothing is ever overwritten without --force, and --dry-run prints the full plan — clone, branch, every rule — before anything happens.
  - icon: 🔄
    title: Multi-workspace sync
    details: status, fetch, sync, and branch-sync operate on the main project and every workspace at once — fast-forward only, dirty workspaces never touched.
  - icon: 🪆
    title: Nested workspaces
    details: Workspaces are ordinary clones, so workler works inside them too — one workspace per feature, one nested workspace per subagent.
  - icon: 🧩
    title: Typed programmatic API
    details: Create, inspect, list, and remove workspaces from TypeScript or JavaScript with structured results, stable error codes, and per-project locking.
    link: /reference/api
---

## Quick taste

::: code-group

```txt [.workler (optional)]
# only needed when a workspace needs local files
link node_modules
copy .env
```

```bash [terminal]
$ workler add feature-a

$ workler list
main       main       /path/to/project
feature-a  feature-a  /path/to/project/.worktrees/feature-a

$ cd "$(workler path feature-a)"
```

:::

`workler add feature-a` works directly in any Git repository. It clones the project into `.worktrees/feature-a`, creates and checks out a new `feature-a` branch, and applies `.workler` rules when that optional file is present.
