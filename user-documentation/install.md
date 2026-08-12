---
summary: >-
  Install Codex Small Loop as a Codex plugin, then start it explicitly from the
  Codex Desktop + menu or with a direct natural-language instruction. Refresh
  an inactive installed copy by upgrading its Git marketplace, removing and
  re-adding the plugin, and verifying the returned installed snapshot.
---

# Installation

Install Codex Small Loop, then explicitly select it for the work you want it to
manage.

## Install The Codex Plugin

First, register the Codex Small Loop repository as a plugin marketplace:

```sh
codex plugin marketplace add game-dev-rta-club/codex-small-loop
```

Then install Codex Small Loop:

```sh
codex plugin add codex-small-loop@codex-small-loop
```

The Codex plugin is the distribution boundary. It installs the skills together
with the role definitions and shared runtime scripts they use.

## Desktop Runtime Requirements

Codex Small Loop supports Codex Desktop on macOS and Windows. Both platforms
require Node.js 24 or newer; verify the executable visible to Codex Desktop:

```text
node --version
```

On macOS, Codex Small Loop uses the signed Codex runtime belonging to the active
Desktop app. A standalone CLI installation is not used as a runtime fallback.
Moving or renaming the app is supported because the running process supplies
its location.

On Windows, install the signed standalone Codex CLI using the official OpenAI
installer, then run `codex` once and sign in with ChatGPT:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex
```

Codex Small Loop accepts the official standalone `codex.exe` only after checking
its canonical path, OpenAI Authenticode publisher, version, authentication, and
authenticated App Server transport. WindowsApps aliases and arbitrary PATH
matches are not used. If the signed standalone executable is installed at a
nonstandard location, set `CODEX_SMALL_LOOP_CODEX_PATH` to its absolute path.

The host-level read-only doctor reports the active Node and Codex evidence:

```text
node <plugin-root>/components/commands/runtime.mjs doctor
```

No separate daemon setup is required. The implementation and fail-closed
runtime boundary are documented in
[Plugin Distribution](/specification/technical-specification/package/plugin-distribution.md).

## Start Codex Small Loop Explicitly

Start a new Codex conversation in the project folder so the installed plugin is
available. Activate Codex Small Loop through either supported entry path:

- Select **Codex Small Loop** from the Codex Desktop **+** menu before submitting
  the request.
- Directly instruct Codex to use it, for example, "Use Codex Small Loop to ...".

Merely mentioning, discussing, inspecting, or asking about Codex Small Loop does
not activate it. No separate initial readiness command is required after an
explicit activation.

The first managed operation initializes the private project runtime
automatically. For example, a Child Task creates the private local runtime
automatically.
No Runtime Task, project-wide Codex Automation, or user setup step is required.
App-message delivery may create a temporary schedule automatically.
`runtime.mjs status` and `repair` remain available for explicit diagnosis.

`$codex-small-loop:handling-user-requests` is the user-facing entry Skill. On the
Task's first Codex Small Loop turn, it shows one complete inline Welcome guide in
the user's language before investigating the project or requested deliverable.
The guide contains the complete model and speed comparison and always includes
the optional Slack and Obsidian recommendations. When neither setting was supplied, a
plain-text line proposes Terra Medium with Normal speed and asks for explicit
agreement. When one setting was supplied, the Skill asks only for the missing
one; when both were supplied, it records them without asking again. On the next
user-authored turn, it loads Controller only after the profile is resolved and
then begins project investigation and Interview. It uses conversation history
rather than a persistent first-run setting.

Initialization does not add a preflight step to ordinary request handling, and
work that never needs a managed operation does not initialize the runtime.

## Optional Tools

External notifications use the provider available to the user-facing task,
initially Slack reminders. Slack is optional for Codex Small Loop as a whole. The
Welcome guide always recommends the Slack Plugin and explains the notification
benefit without inspecting connector state.

Obsidian is not required. The documentation remains usable as ordinary Markdown
and through CLI tools. Obsidian can be used as an optional viewer for navigation
and backlinks. The Welcome guide always recommends the Obsidian App without
inspecting project state. Open the repository root as the vault root so
repository-root links such as
`/specification/system-specification/...` and
`/implementation/skills/...` resolve correctly.

## Reference

- [Run a Task](/user-documentation/run-a-task.md)
- [Update Codex Small Loop](/user-documentation/update.md)
- [Working With Codex Tasks](/specification/system-specification/skills/working-with-codex-tasks.md)
- [Plugin Distribution](/specification/technical-specification/package/plugin-distribution.md)
