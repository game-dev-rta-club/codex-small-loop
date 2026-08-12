# Contributing

Contributions that make Codex Small Loop simpler, safer, or easier to use are
welcome.

If you have found a security vulnerability, do not open a public issue. Follow
the private reporting process in [SECURITY.md](SECURITY.md).

## Propose a change

- Open a pull request directly for a typo, documentation fix, or small bug fix.
- Open an issue first for workflow, role, protocol, or compatibility changes so
  the behavior and scope can be agreed before implementation.
- Keep refactoring separate from behavior changes.

## Local development

Requirements: Node.js 24 or newer and Git. Use macOS when changing the packaged
native helpers; portable behavior is also tested on Windows.

```sh
git clone https://github.com/game-dev-rta-club/codex-small-loop.git
cd codex-small-loop
node --test "implementation/components/*/tests/*.test.mjs"
```

Run the focused tests for the component you change while developing, then run
the complete command above before opening a pull request. Follow the adjacent
`BUILD.md` when changing a packaged native helper.

## Pull requests

Keep each pull request focused on one logical change. A pull request should:

- Explain the user-visible problem and the focused solution.
- Include or update tests when behavior or repository contracts change.
- Update user-facing documentation when installation or usage changes.
- Preserve macOS and Windows behavior unless the change explicitly narrows it.
- Pass the complete repository test command.
- Avoid unrelated formatting, refactoring, secrets, and personal information.

Conventional Commit prefixes such as `docs:`, `fix:`, `feat:`, and `test:` are
preferred for commit and pull-request titles.

Maintainers review contributions when available. A response, merge, or release
timeline is not guaranteed.

## Contribution license

No Contributor License Agreement or Developer Certificate of Origin is
required. Unless explicitly stated otherwise, contributions intentionally
submitted for inclusion in this repository are licensed under the repository's
[MIT License](LICENSE).
