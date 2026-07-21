import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export default defineConfig({
  title: "Workler",
  description:
    "Local workspace manager with copy/link rules for untracked project files.",
  base: "/Workler/",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/Workler/logo.svg" }],
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-is-workler", activeMatch: "/guide/" },
      {
        text: "Reference",
        link: "/reference/configuration",
        activeMatch: "/reference/",
      },
      {
        text: `v${packageVersion}`,
        items: [
          { text: "npm", link: "https://www.npmjs.com/package/workler" },
          {
            text: "Releases",
            link: "https://github.com/YJJosh/Workler/releases",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is Workler?", link: "/guide/what-is-workler" },
            { text: "Getting started", link: "/guide/getting-started" },
          ],
        },
        {
          text: "Core concepts",
          items: [
            { text: "Workspaces & branches", link: "/guide/workspaces" },
            { text: "Copy & link rules", link: "/guide/rules" },
            { text: "Safety, --force, --dry-run", link: "/guide/safety" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "Keeping workspaces in sync", link: "/guide/sync" },
            { text: "Nested workspaces", link: "/guide/nested-workspaces" },
            { text: "Shell switching (wcd)", link: "/guide/shell-helper" },
          ],
        },
      ],

      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: ".workler file", link: "/reference/configuration" },
            { text: "Generated files", link: "/reference/generated-files" },
            { text: "Programmatic API", link: "/reference/api" },
          ],
        },
        {
          text: "CLI commands",
          items: [
            { text: "Overview", link: "/reference/cli/" },
            { text: "workler init", link: "/reference/cli/init" },
            { text: "workler add", link: "/reference/cli/add" },
            { text: "workler apply", link: "/reference/cli/apply" },
            { text: "workler list", link: "/reference/cli/list" },
            { text: "workler path", link: "/reference/cli/path" },
            { text: "workler remove", link: "/reference/cli/remove" },
            { text: "workler status", link: "/reference/cli/status" },
            { text: "workler fetch", link: "/reference/cli/fetch" },
            { text: "workler sync", link: "/reference/cli/sync" },
            { text: "workler branch-sync", link: "/reference/cli/branch-sync" },
            { text: "workler shell-init", link: "/reference/cli/shell-init" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/YJJosh/Workler" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/YJJosh/Workler/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
    },

    outline: { level: [2, 3] },
  },
});
