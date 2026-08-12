# Security Policy

## Maintenance status

Codex Small Loop is experimental. It does not publish a guaranteed security
support schedule. Reports may be addressed on the current `main` branch and the
most recent tagged release, subject to maintainer availability.

Acknowledgement, remediation, release, and long-term maintenance timelines are
not guaranteed. Do not rely on this project when your use case requires a
contractual response or fix deadline.

## Report a vulnerability

Do not open a public GitHub issue with vulnerability details. Use
[GitHub private vulnerability reporting](https://github.com/game-dev-rta-club/codex-small-loop/security/advisories/new).
Include:

- The affected version, operating system, and component.
- A description of the issue and its potential impact.
- Reproduction steps or a proof of concept where safe.
- Any known mitigations.
- Your intended disclosure timeline.

## Scope

In scope:

- Plugin skills, roles, specifications, and package metadata in this repository.
- Board, Activity, Sonner, and local runtime behavior shipped by this repository.
- Official packaged macOS helpers and Windows-compatible runtime paths.

Out of scope:

- Vulnerabilities in Codex, Node.js, Git, Slack, GitHub, or other third-party
  services and dependencies.
- Model behavior not caused by this repository's instructions or implementation.
- Social engineering, physical security, and denial-of-service testing.

Report third-party vulnerabilities to the relevant upstream project.

## Disclosure and attribution

Please avoid public disclosure until users have had a reasonable opportunity to
apply an available fix. This project cannot promise an embargo or remediation
timeline, so include your intended disclosure date in the report.

If an advisory is published, reporters are credited unless they request
otherwise.
