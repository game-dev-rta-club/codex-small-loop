---
keyPoints: >-
  Package the shared small-loop dispatcher and Sonner dependency closure for npm,
  with project-local bootstrap caching and compatible automatic updates.
---

# CLI Distribution

The root `package.json` defines `@game-dev-rta-club/small-loop` and the
`small-loop` executable. Its explicit `files` allowlist includes the shared
dispatcher, Sonner sources and native helpers, required Runtime data parsers,
and the bootstrap. It excludes the Board, Roles, Skills, Codex adapters and
Plugin manifest. Root MIT licensing accompanies the package. There are no npm
runtime dependencies or install/build lifecycle scripts. Adding a subcommand
requires including its dependency closure and testing the packed artifact.

The Plugin retains `implementation/` as its distribution boundary and uses
the same dispatcher and reader sources. The CLI's stable semantic version
comes from `package.json`; the Plugin snapshot identity still covers all bytes
under `implementation/`. Neither distribution imports the other's installed
cache. No generated copy of Sonner is maintained.

`small-loop sonner` defaults to the cwd and project-only inspection. The
`includeRuntime` option on the shared builder defaults to true for existing
Board and library consumers; the new CLI explicitly passes false unless
`--runtime` is requested. Skipping Runtime does not read local ledgers or
session history and omits that member from JSON and text. Existing full
version-12 output and lifecycle cancellation behavior remain unchanged.
The old `commands/sonner.mjs` adapter remains compatible with existing callers;
new documentation and skills use `small-loop sonner`.

The native and portable readers share the current `.WORK_NODE.xml` contract
with required `keyPoints`. Legacy `WORK_NODE.xml` paths are reported as migration
information without loading them as Works. No project files are migrated by
the CLI.

The copyable bootstrap has no checkout-relative dependencies. It downloads
stable 1.x through npm into unique cache directories with lifecycle scripts
disabled and bounded network/process timeouts. Package identity, version, bin
mapping, entry existence, and a successful help command precede atomic cache
pointer publication. Concurrent invocations never modify or delete a selected
package directory. A refresh error preserves the previous package and applies
a retry delay; initial failure is explicit. CLI execution occurs once with
argument-array forwarding, inherited cwd/stdio and exit status, and signal
forwarding. Future mutating commands must not be retried as download failures.

See [Standalone CLI](/user-documentation/cli.md) for setup, cache
behavior, compatibility policy, and the npm publication prerequisite.
