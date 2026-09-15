---
keyPoints: >-
  Codex Small Loop places each maintained Work in its meaningful project
  directory and uses implementation/ as its complete installable Plugin Output.
---

# Repository Structure

The repository is installed through the Codex plugin flow described in
[Installation](/user-documentation/install.md). Its directories are the real
maintained outputs represented by the Work Graph; there is no parallel
`works/` storage hierarchy.

```text
codex-small-loop/
  .agents/                    # Repository marketplace metadata
  overview/                   # Overview Work
  product-concept/            # Product Concept Work
  specification/              # Classification directory, not a Work itself
    interaction-specification/  # Interaction Specification Work
      activation/             # Activation and execution-profile behavior
      agreement/              # Intent and plan agreement
      delivery/               # Progress, authority, and final delivery
    system-specification/     # System Specification Work
      coordination/           # Managed delivery and Task coordination
      roles/                  # Complete five-Role specification inventory
      skills/                 # Complete seven-Skill specification inventory
      work-graph/             # Work Graph concept and contract
    technical-specification/  # Technical Specification Work
      package/                # Distribution and repository structure
      runtime/                # Stable runtime capability specifications
      integrations/           # Optional provider adapters
  implementation/             # Plugin Output Work and installable plugin root
    .codex-plugin/
    skills/
    contents/
      welcome/                # Shared Welcome Board template, profile data, and image
    components/
      commands/               # Shared small-loop dispatcher and compatibility entries
      cli/                    # Copyable auto-update bootstrap and package tests
      board/                  # Board UI/shared Host plus shared Node Signal reader
      roles/
      runtime/
      sonner/                  # Work Graph, Files, and Runtime projection plus descriptor reader
      contract-tests/
    assets/
    third_party/
  user-documentation/         # User Documentation Output Work
  package.json                # Standalone CLI package and explicit file allowlist
  README.md                   # Stable public entry page
  .gitignore
```

Every Work directory contains `.WORK_NODE.xml`. The leading dot distinguishes
the marker as project configuration while `.xml` retains editor support. Its stable Work ID may differ
from the directory basename, so physical organization can follow the host
project while graph edges retain durable semantic identities. The
`specification/` parent classifies related Works and intentionally has no
marker. Directories below each Specification Work are focused Parts, not
additional Work Nodes. Role and Skill specification names deliberately mirror
their Plugin Output counterparts; runtime capability documents
deliberately do not mirror individual source modules.

## The Plugin Output

`implementation/` is both the Plugin Output Work and the Codex plugin root.
Codex discovers its manifest, Skills, shared contents, job roles, runtime,
assets, third-party sources, and focused tests directly from that directory. The repository-level
marketplace manifest at `.agents/plugins/marketplace.json` points to
`./implementation`; no duplicate binding or generated projection is needed.

Within the plugin, `skills/<skill-name>/SKILL.md` is the host-required Skill
entry point. The directly named `commands/`, `board/`, `roles/`, `runtime/`,
`sonner/`, and `contract-tests/` directories organize implementation by runtime
surface; they require no additional repository-specific marker. `commands/`
owns small public entry points while implementation stays with its runtime
surface. Focused and contract tests are parts of the Plugin Output rather than
separate Work Nodes.
`contents/` holds shared model-readable or display material that belongs to the
plugin rather than to one Role or Skill.

## Work Graph

Every Work directory contains `.WORK_NODE.xml`. Use the installed
[Understanding Works Skill](/implementation/skills/understanding-works/SKILL.md)
and its one Sonner command's default Agent text to inspect current nodes, directory names,
filenames, key points, and traces instead of maintaining a second handwritten
inventory. Machine consumers add `--json` for the canonical versioned document
also served by the Browser API.

## Reference

- [Work Graph knowledge](/implementation/skills/understanding-works/references/work-graph.md)
- [Atomic Documentation](/implementation/skills/creating-and-maintaining-works/references/atomic-documentation.md)
- [Plugin Distribution](/specification/technical-specification/package/plugin-distribution.md)
- [Understanding Works Specification](/specification/system-specification/skills/understanding-works.md)
- [Creating And Maintaining Works Specification](/specification/system-specification/skills/creating-and-maintaining-works.md)
