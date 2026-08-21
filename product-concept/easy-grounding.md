---
summary: >-
  Easy grounding lets Controller build an accurate working model once and route
  the relevant context to every agent in a Milestone.
---

# Easy Grounding

Grounding is the initial work of building an accurate working model of a project
before deciding or acting. The agent identifies the intended outcome, current
state, project structure, important constraints, authoritative sources, and the
Works and source files relevant to the request.

Easy grounding is Codex Small Loop's commitment to make that initial understanding
fast, repeatable, and difficult to get subtly wrong. A newly started agent should
not need a human to repeat the project's structure or manually assemble a reading
list.

## Sonner: One Shared First Look

Sonner is the compact, versioned project overview that lets a user and an Agent
start from the same facts. An Agent obtains it with one command. A user sees the
same projection in the local Browser surface beside the Activity Board. Its
shared document combines the maintained Work Graph, a Files index, and a small
current Runtime snapshot. The
graph answers which production outputs exist and how they depend on each other;
paths, types, maintained file summaries, and a compact directory tree answer
what is here and where deeper reading should begin. Runtime answers whether
open execution currently contains active or mechanically uncertain Tasks
without turning current state into historical analysis.

Sonner does not copy file bodies, generate interpretations with AI, or hide an
unknown project boundary behind a plausible-looking tree. It preserves admitted
directory routes, lists only files with maintained summaries, and compresses
every other file into direct-parent extension/count groups. Missing or invalid graphs remain
explicit without hiding Files or exposing parser diagnostics. Runtime exposes
only health, coarse reasons, and active or uncertain Task identities—not ended
Tasks, Root history, coordination records, message bodies, logs, summaries, or
recommended actions; the Board remains the place for history and analysis. The
same compact first look is available on macOS and Windows. Platform-specific
filesystem authority stays behind Sonner's readers and never changes the public
text, JSON, or Browser projection.

This concept follows
[Route Context Just in Time](https://github.com/lopopolo/harness-engineering/blob/226c8d35fb6ea3ed55467753dba6dea2b5fd5778/docs/just-in-time-context/README.md):
keep the full project knowledge navigable while loading only the material needed
for the current work.

## How It Works

1. Every maintained Work has a machine-readable `WORK_NODE.xml` in its project
   directory.
2. Controller runs one command before a Milestone assignment to retrieve a
   deterministic Agent-readable Work Graph, Files index, and current Runtime
   snapshot:

   ```sh
   node "<plugin-root>/components/commands/sonner.mjs" \
     --project-root <project-root>
   ```

   Machine consumers can add `--json`; the Browser API uses that same lossless
   versioned JSON while presenting a human interface.
3. The graph, summaries, node paths, inputs, and outputs let Controller select
   relevant Works without opening every project file.
4. The Overview-rooted relationships connect the Product Concept to the
   maintained Interaction, System, and Technical Specifications, then to the
   Implementation and User Documentation.
5. Controller reads directory names, filenames, and atomic summaries before full
   bodies, then follows explicit links, backlinks, shared descriptive names,
   and Work Graph paths until it has the context needed for the current
   decision.

Sonner is a routing surface, not a replacement for source reading. The actual
directory structure, filenames, and summaries form a live information map.
Handwritten README or index inventories are unnecessary when they only repeat
that derived structure and can drift from it.

## Routed to Every Agent

Controller uses `codex-small-loop:understanding-works` once at the Milestone
boundary and includes the selected Work context in Primary's assignment.
Primary routes the relevant parts through ordinary assignments. Execute,
Review, and Interviewer do not rerun graph discovery, so every agent receives
the useful project model without repeatedly paying for the same map and reading.

The project improves easy grounding by keeping summaries accurate, preserving
Work relationships, removing stale routes, and making the Sonner command and skills
simple to invoke. The target is that a new agent can catch up immediately and
accurately from its assignment without a bespoke walkthrough.

## Detailed Contracts

- [Understanding Works](/specification/system-specification/skills/understanding-works.md)
- [Creating And Maintaining Works](/specification/system-specification/skills/creating-and-maintaining-works.md)
- [Work Graph Design](/specification/system-specification/work-graph/contract.md)
