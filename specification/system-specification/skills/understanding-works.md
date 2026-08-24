---
keyPoints: >-
  codex-small-loop:understanding-works builds sufficient project context from
  Work Graph paths, repository structure, atomic key points, links, backlinks,
  and shared descriptive names.
---

# Understanding Works

`codex-small-loop:understanding-works` is the read-only project-grounding Skill
used by Controller before each project-change Milestone assignment. It validates
the current Work Graph, starts from the requested result, and selects the
upstream decisions and downstream consumers relevant to that result. Controller
passes the selected context to Primary; Primary, Execute, Review, and Interviewer
do not rerun the Skill for that Milestone.

Within selected Works, it reads directory names, filenames, Work key points,
and atomic-document key points before opening full bodies. These provide the
main current model; full bodies supply supporting detail. It follows explicit
repository-root-relative Markdown links and backlinks first, then shared
descriptive names and Work Graph paths. This loose trace connects documents,
code, tests, images, video, audio, and other media without requiring identical
metadata from every format.

The Skill treats the graph as approved production causality rather than a file
inventory or Task boundary. It stops when the agent has a coherent working
model for its current decision instead of loading the entire project.

Its one Sonner invocation reads deterministic text by default. That text keeps
Work Graph, Files, and current Runtime states explicit while JSON-string
escaping every project-derived value. Machine and API comparisons use the
explicit canonical `--json` form instead.

## Implementation

- [Runtime Skill](/implementation/skills/understanding-works/SKILL.md)
- [Work Graph knowledge](/implementation/skills/understanding-works/references/work-graph.md)
- [Codex UI metadata](/implementation/skills/understanding-works/agents/openai.yaml)
- [Sonner command](/implementation/components/commands/sonner.mjs)
- [Sonner Work Graph tests](/implementation/components/sonner/tests/work-graph.test.mjs)
