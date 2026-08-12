# Codex Small Loop

Give Codex the whole job.

Codex Small Loop is a Codex Desktop plugin for advancing project requests from
clarification to verified delivery.

## Requirements

- Codex Desktop on macOS or Windows
- Node.js 24 or newer
- On Windows, the signed standalone Codex CLI
- Git
- A project directory opened in a new Codex conversation

## Install

Register this repository as a plugin marketplace, then install the plugin:

```sh
codex plugin marketplace add game-dev-rta-club/codex-small-loop
codex plugin add codex-small-loop@codex-small-loop
```

Open a new Codex conversation after installation. Choose **Codex Small Loop**
from the Desktop **+** menu, or explicitly ask Codex to use Codex Small Loop for
the request. Merely mentioning the plugin does not activate it.

## Documentation

Read
[Installation](user-documentation/install.md),
then
[Run a Task](user-documentation/run-a-task.md).

For deeper behavior and implementation contracts, start with the
[project overview](overview/overview.md) and
[Work Graph concept](specification/system-specification/work-graph/concept.md).

## Sonner

Retrieve the deterministic Agent-readable Work Graph, Files index, and current
Runtime snapshot from an installed plugin in one command:

```sh
node <plugin-root>/components/commands/sonner.mjs --project-root "$PWD"
```

Add `--json` for the lossless versioned document used by machine consumers. The
local Browser API returns those same canonical JSON bytes while the Browser
presents the existing human interface.

Default fields are JSON-compatible quoted display values. Unicode display
controls, default-ignorables, noncharacters, and lone surrogates appear as
visible lowercase `\\u` escapes; ordinary Unicode remains readable. Use
`--json`, not the plaintext display, when exact source code points matter.

The local Codex Small Loop page exposes the same projection under **Sonner** in
its Activity Bar. **Work Graph** is the initial tab: it shows the deterministic
Overview-to-downstream DAG with automatically routed connections in an
independently scrolling region. Selecting a card updates the always-visible
detail region below it without re-layout. Inputs and outputs in that region
select their related Works, and the compact controls zoom the graph without
changing its layout. **Files** contains paths, types, Markdown
frontmatter summaries, and no file bodies. Its compact tree gives opaque
directories a concise omission summary, and directories sort before files at
each level. **Runtime** is a small health check that lists only active or
uncertain Tasks; a healthy idle project has an empty Task list.

The projection and Board are available on macOS and Windows. macOS uses the
packaged signed descriptor helpers; Windows uses bounded platform readers and
never executes those Mach-O files. Opening a file or Work folder is currently
macOS-only; Windows reports that action as unavailable without affecting
inspection.
