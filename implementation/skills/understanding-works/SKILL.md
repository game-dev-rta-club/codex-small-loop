---
name: understanding-works
description: Use from Controller before assigning a project-change Milestone, when Controller must select the Works and upstream decisions that give the requested result meaning.
---

# Understanding Works

Build a sufficient project model for Controller before it assigns a Milestone.
Use the Work Graph to choose context, then use the repository structure,
atomic summaries, links, backlinks, and related names to reach the authoritative
sources.

Controller includes the resulting Work context in the Primary assignment.
Primary, Execute, Review, and Interviewer do not invoke this skill again for
that Milestone.

## Required Knowledge

Read [Work Graph](references/work-graph.md) completely before using this skill
for the first time in a project. It defines Work, Work Graph, graph direction,
storage, scope, and the boundary between production structure and repository
inventory.

## Start With The Current Map

Locate the project root. Work directories may appear anywhere beneath it and
are identified by `WORK_NODE.xml`.

Resolve the installed Codex Small Loop plugin root from this `SKILL.md`, then run:

```sh
node "<plugin-root>/components/commands/sonner.mjs" \
  --project-root <project-root>
```

Read the `Work Graph`, `Files`, and `Runtime` sections from the deterministic
Agent text. A valid graph supplies every Work in deterministic topological order
together with its summary, node path, direct inputs, and outputs. The adjacent
Files records are the shared project index; they are not
a claim that every file belongs to a Work. Host-required configuration may live
outside a Work without creating a graph defect.

Treat quoted values as JSON-compatible display fields: invisible Unicode
formatting controls, default-ignorables, noncharacters, and lone surrogates are
shown as visible `\\u` escapes while ordinary Unicode remains readable. This
plaintext is for grounding, not exact source recovery.

Use `--json` only when a machine consumer needs the lossless versioned Sonner
document. The Browser API uses that same canonical JSON; the default text is the
Agent reading surface.

Start from the requested result. Select the Work or Works that most directly
own that result. Follow `inputs` for upstream authority and `outputs` for
downstream impact; neither relation needs another command. Read enough upstream context to understand the decision,
then inspect downstream context when a change may make an existing output stale.

When `workGraph.status` is `missing` or `invalid`, report that stable state and
do not infer a graph from the Files tree. Propose the useful production
structure instead of relying on an invalid map. Load
`$codex-small-loop:creating-and-maintaining-works` to perform a repair only when
the current request and accepted plan authorize project mutation.

## Read Structure Before Bodies

Within relevant Work directories, inspect in this order:

1. directory names;
2. filenames;
3. the Work summary in `WORK_NODE.xml`;
4. available atomic document summaries or native-format summaries;
5. only the files whose names and summaries indicate that their bodies matter.

The directory is a live information map. Prefer it to a handwritten inventory.
An atomic summary should let an agent decide whether to open the full document.
Code and other mechanically detected text files retain their names. Images,
video, audio, and other non-text formats appear as extension/count groups and
rely on their directory placement and surrounding Work context.

## Trace Related Knowledge

Use progressively looser evidence instead of assuming that every medium can
carry identical metadata:

1. Follow explicit repository-root-relative Markdown links.
2. Find backlinks to the selected file or directory.
3. Search for files with the same or clearly shared descriptive name.
4. Use the containing Work and its graph inputs and consumers.
5. Search only the relevant upstream or downstream Work directories for the
   remaining relationship.

For example, `task-coordination.md`, `task-coordination.mjs`, and
`task-coordination.test.mjs` form a useful loose trace even when the source and
test cannot naturally link back. `opening-scene-01.png` and
`opening-scene-01.mp4` can express the same relationship across binary media.

Use existing CLI tools such as `rg` and `rg --files` for backlinks and shared
names. Use Obsidian backlinks when the repository root is open as a vault. Do
not require a dedicated trace index when the current map and ordinary search
answer the question.

## Establish Authority

A downstream Work uses its input Works as maintained decision context. When an
Implementation differs from an approved Specification, treat the Specification
as the current criterion unless an accepted change revises an earlier Work.

When downstream work reveals that an upstream decision is incomplete or wrong,
return to the earliest affected Work, settle that decision, and then follow the
graph downstream again. A link identifies related sources; graph direction and
accepted decisions determine authority.

## Completion Contract

Before deciding, changing, or reviewing, be able to state:

- the selected Work or Works;
- the upstream Works that constrain the decision;
- the files that own the relevant current knowledge;
- the explicit links, backlinks, shared names, or graph paths used to find them;
- the downstream Works that may become stale; and
- any graph gap or ambiguity that requires agreement instead of assumption.

Stop reading when this working model is coherent enough for the current
decision. The goal is sufficient grounding, not loading the entire project.

## Boundary

This skill owns project grounding and trace discovery. It does not change
project files or graph topology. Use
`$codex-small-loop:creating-and-maintaining-works` before any project mutation.
