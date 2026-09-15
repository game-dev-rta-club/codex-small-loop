---
keyPoints: >-
  Run small-loop sonner without installing a Codex Plugin, and share an
  automatically updated CLI through a project-local skill.
---

# Standalone CLI

The CLI and Codex Plugin come from this repository and share the same Sonner
implementation. The CLI requires Node.js 24+, npm for downloading packages,
and Git. macOS and Windows are supported. No Codex installation, login,
Plugin, daemon, or API key is required for project inspection.

The npm package name is `@game-dev-rta-club/small-loop`; its executable is
`small-loop`. Registry commands below require the maintainer's first npm
publication. Adding this implementation to Git does not publish a package.

## Run Sonner

From the project directory, after the package is published:

```sh
npm exec --yes --package=@game-dev-rta-club/small-loop@1 -- small-loop sonner
```

Or install the CLI once and use its executable:

```sh
npm install --global @game-dev-rta-club/small-loop@1
small-loop sonner
```

A global install stays at its installed version until updated. `npm exec`
uses npm's package cache and resolution; it does not implement the bootstrap's
refresh interval or explicit offline fallback described below.

```sh
small-loop sonner --project-root /path/to/project --json
small-loop sonner --timeout-ms 30000
small-loop sonner --runtime
small-loop sonner --help
```

The default Root is the current working directory. `--project-root` accepts
an absolute path or one relative to that directory. Default output is
deterministic Agent text containing Work Graph and Files. `--json` returns
the lossless version-13 projection. Project-only output omits `runtime`;
`--runtime` adds the same Runtime projection used by the Plugin and Board.
It observes locally available records; it neither installs nor starts Codex.

Work discovery and Files use the same Git-selected paths. Git-ignored files
and directories (including Unity's `Library/` when ignored) are excluded from
Work discovery, so ignored generated directories are not traversed. Nested
`.gitignore` rules, negations, and standard Git excludes are respected. Already
tracked files remain included, as they do in Git. Ignored `.WORK_NODE.xml` and
legacy `WORK_NODE.xml` files do not produce Works or migration warnings.
Other people's histories are not shared through Git.

`--timeout-ms` sets the total inspection deadline (default 5000, maximum
300000). Use 30000 for large asset trees. Work discovery reads `.WORK_NODE.xml` with required `<keyPoints>` metadata.
Legacy `WORK_NODE.xml` files are reported for migration and are not interpreted
as current Works. The CLI does not migrate project files. A missing/invalid graph
is represented in output while Files remain available; a failed inspection
or invalid invocation exits nonzero.

## Share Through a Project Skill

The project maintainer copies
[`bootstrap.mjs`](/implementation/components/cli/bootstrap.mjs) into the
target repository as `tools/small-loop.mjs` and commits it alongside the
project's skill. This is a single self-contained file; do not copy Sonner's
implementation or reference a user's Plugin cache.

Example `.agents/skills/understand-project/SKILL.md`:

```markdown
---
name: understand-project
description: Read the project's current structure and key points with Sonner before starting work.
---

Run from the project root:

    node tools/small-loop.mjs sonner --timeout-ms 30000

Use the Work Graph and file key points to select the relevant project documents.
```

Teammates pull the repository and invoke the skill. On first execution, the
bootstrap downloads the CLI through npm. Subsequent executions reuse a private
cache at `~/.cache/small-loop/cli-v1` and check for compatible stable 1.x updates
once every 24 hours. No project `node_modules`, lockfile, global npm install,
or Codex configuration is changed. Normal Sonner output stays on stdout.

If a download or update validation fails, the previous downloaded CLI is used
with a stderr notice, and the next check is delayed one hour. The first run
requires network access and fails with a retry instruction when unavailable.
Once the CLI starts, a command failure is returned directly; it is never
retried with an older version. Downloaded versions remain available so another
running process is not disrupted. To reclaim them, remove this cache when no
bootstrap-launched commands are running; the next invocation downloads again.

Compatible fixes and new CLI subcommands arrive without project commits or
update PRs. A future breaking CLI major requires deliberately updating the
bootstrap's supported major. Changes to the bootstrap itself require copying
the revised file; it does not rewrite project files or update itself.

## Develop and Release

Before npm publication, run directly from this checkout:

```sh
node implementation/components/commands/small-loop.mjs sonner
npm pack --pack-destination /path/to/output
```

Install the resulting tarball into a temporary prefix to inspect it through
the real `small-loop` executable. The tarball includes the existing signed
macOS helper and portable Windows reader; no native compiler runs at install.

The CLI uses its own semantic version in root `package.json`. Increment it
when releasing CLI changes. This is separate from the Plugin's snapshot
version. Configure npm ownership for `@game-dev-rta-club/small-loop`, publish
the first version using an authorized maintainer account, and configure npm
trusted publishing for this repository's `publish-cli.yml` workflow. Do not
store npm credentials in this repository.

After that setup, a `cli-v<package.json version>` tag runs the macOS and Windows
suites and publishes that exact version through GitHub Actions OIDC. No npm
publication occurs on ordinary pushes or pull requests. Compatible releases
are picked up by project bootstraps automatically. The package and Plugin
continue to use one source tree; a second repository is unnecessary.

## Text layout

The default text output uses directory/file names within the indented tree and
places extension counts on the directory's line. Directories belonging to a valid
Work Graph include `[WORK_NODE: <id>]` immediately after the directory name,
before any extension counts. Each Work lists its summary,
project-relative node directory, inputs, and outputs:

```text
Work Graph: valid
  overview
    Project overview.
    nodeDir: Docs/Overview/
    input: none
    output: gameplay-specification, art-specification
Files:
  ./
    Docs/
      Overview/ [WORK_NODE: overview] 1 meta, 3 md
    Assets/ 53 meta, 53 png
```

Control characters and ambiguous labels remain escaped. Use `--json` for the
full structured fields, including Work types and complete file paths.

## Project extensions and scoped queries

Use `--extensions` to run project-owned metadata extractors configured in
`.sonner.json`. Use `--no-key-points`, `--depth N`, and `--path DIR` to control
the output and content scope. See [Sonner extensions and queries](/user-documentation/sonner-extensions.md)
for the API, configuration, counting rules, and partial graph semantics.
