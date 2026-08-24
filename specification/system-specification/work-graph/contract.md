---
keyPoints: >-
  The Work Graph contract uses one Overview-rooted acyclic graph of XML node
  files so production intent, current state, and change impact remain
  machine-readable without duplicate directory indexes.
---

# Work Graph Contract

## Work Contract

Every Work is a meaningful project directory containing `.WORK_NODE.xml`. Work
directories may live anywhere beneath the project root. A generic `works/`
bucket is not part of the graph contract and should not be created merely to
collect nodes:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<work-node id="implementation" type="Implementation">
  <keyPoints>The plugin turns the maintained product specifications into installed skills, roles, runtime commands, Sonner, and Board.</keyPoints>
  <inputs>
    <input ref="interaction-specification" />
    <input ref="system-specification" />
    <input ref="technical-specification" />
  </inputs>
</work-node>
```

- `keyPoints` state the maintained or intended production output itself,
  including its main behavior, decisions, and important boundaries.
- `id` is unique, stable, and readable by people and programs.
- `id` is independent of the containing directory name. This lets an existing
  production path remain stable while the graph uses a durable semantic
  identity. Parent directories may classify related outputs, and moving or
  renaming a directory does not require changing the Work ID.
- `type` is a recognizable production classification such as `Overview`,
  `ProductConcept`, `InteractionSpecification`, `SystemSpecification`,
  `TechnicalSpecification`, `Implementation`, or `UserDocumentation`.
- Each `input.ref` identifies a direct input Work Node used to produce the
  current output Work Node.

The presence of `.WORK_NODE.xml` marks a Work entry point. It does not claim
exclusive ownership of every descendant or require every maintained project
file to belong to a Work. Mapping starts at the project root and discovers Work
markers recursively while excluding generated and local-state directories. The
marker path identifies where the Work lives; the XML ID identifies it in graph
edges. Agents read both instead of inferring identity from the directory
basename.

The leading dot identifies the marker as project configuration while the XML
suffix preserves editor and tooling support. The former `WORK_NODE.xml` name is
not a graph marker. Sonner reports each occurrence as an actionable Files
warning so its owner can rename it to `.WORK_NODE.xml`; it never silently loads
the legacy file or mutates the project.

Work directories do not require README files. Agents inspect the selected
directory after mapping the graph. Create a README only for an external host or
distinct human entry point, keep it stable, and link to canonical documents
instead of duplicating inventories or current state.

## Graph Scope

The formal graph includes approved future Works as soon as their production
form and causal inputs are agreed. A future Work may begin as a directory with
only `.WORK_NODE.xml`; its marker reserves neither implementation ownership nor
claims that the output has been produced.

Graph membership expresses approved production structure. It does not express
completion, progress, schedule, or readiness, and `.WORK_NODE.xml` does not carry
a status field. Those concerns belong to project-management state outside the
Work Graph. Changes to the approved production structure may revise the graph
as production reveals better boundaries or causal relationships.

## Graph Invariants

The project Work Graph must:

1. contain exactly one `Overview` Work;
2. give the Overview no inputs;
3. reference only existing Work IDs;
4. keep every non-Overview Work reachable from the Overview;
5. remain acyclic; and
6. avoid duplicate Work IDs.

## Input Relation Contract

Each `<input ref="…" />` records one direct production dependency:

```text
input Work Node --> output Work Node
```

The downstream Work uses every listed upstream Work as a maintained input.
Edges do not define execution units, role activity, ownership boundaries, or
the amount of work grouped into a project change. Branches represent Works that
can advance independently from the same earlier Work.

A merge records every maintained Work that the downstream Work directly uses.
An Implementation lists each independent specification that constrains the
working result. Specification concerns may remain separate or be consolidated
when they are maintained and consumed together; every resulting independent
specification remains a peer input at the Implementation merge.

The graph does not prescribe execution order or project-change scope. Agents
reason backward from the requested outcome, current Work state, and direct
inputs.

## Work And Repository Structure

The Work Graph records production causality rather than exhaustive physical
ownership. Host-required configuration and support files may remain outside a
Work. Inside relevant Works, directories, descriptive filenames, atomic key
points, explicit links, backlinks, and shared names provide progressively
more detailed routes to maintained knowledge and outputs.

## Change Impact

Inputs are the only stored graph edge. Tools derive downstream consumers by
reverse lookup. A change to one Work Node requires reviewing its reachable
consumers; reachability identifies the review path but does not prove semantic
consistency. Accepted prototype or experiment learning is written into the
earliest affected Work Node, then propagated through that path.

## Implementation

- [Runtime Work Graph knowledge](/implementation/skills/understanding-works/references/work-graph.md)
- [Understanding Works runtime Skill](/implementation/skills/understanding-works/SKILL.md)
- [Creating And Maintaining Works runtime Skill](/implementation/skills/creating-and-maintaining-works/SKILL.md)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
