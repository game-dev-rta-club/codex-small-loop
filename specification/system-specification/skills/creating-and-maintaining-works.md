---
summary: >-
  codex-small-loop:creating-and-maintaining-works changes project outputs while
  preserving atomic knowledge and loose traces from caller-supplied context.
---

# Creating And Maintaining Works

`codex-small-loop:creating-and-maintaining-works` applies whenever a project file
or directory is created, updated, moved, renamed, split, merged, or deleted. It
uses caller-supplied context and does not automatically invoke Understanding
Works or rerun Work Graph discovery.

The Skill updates the earliest affected maintained decision and inspects each
reachable downstream Work. It considers graph repair or a material topology
change only when the current production structure is missing, invalid, stale,
or too coarse to support the decision. A material topology change requires user
agreement before mutation.

For textual knowledge, Atomic Documentation gives each independently nameable
responsibility one canonical file. Directory names, filenames, and summaries
form the live map read by `understanding-works`; handwritten README or index
inventories are not added because they duplicate that map and can become stale.
A stable entry page remains valid when serving a distinct audience is itself an
independent responsibility.

Linkable media use normal repository-root-relative Markdown links. Media that
cannot naturally carry links use aligned descriptive names where practical.
Work edges provide the universal production trace. Summaries are required for
Works and atomic Markdown documents and are used in other formats only when the
format supports them naturally.

## Implementation

- [Runtime Skill](/implementation/skills/creating-and-maintaining-works/SKILL.md)
- [Atomic Documentation](/implementation/skills/creating-and-maintaining-works/references/atomic-documentation.md)
- [Codex UI metadata](/implementation/skills/creating-and-maintaining-works/agents/openai.yaml)
- [Work Graph contract](/specification/system-specification/work-graph/contract.md)
