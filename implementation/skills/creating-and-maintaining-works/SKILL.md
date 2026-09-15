---
name: creating-and-maintaining-works
description: Use whenever creating, updating, moving, renaming, splitting, merging, or deleting project files or directories, including documents, code, tests, images, video, audio, assets, configuration, and Work Graph metadata.
---

# Creating And Maintaining Works

Change project outputs without losing the upstream knowledge that shaped them
or leaving downstream Works stale. Preserve a repository that another agent can
understand from its real structure.

## Supplied Context

Use the project context supplied by the caller and inspect the real files being
changed. This skill does not automatically load `understanding-works`, run
Sonner, or rediscover project structure. When Controller explicitly invokes
this skill to create or repair the Work Graph, the Controller-supplied graph
decision is authoritative. Files such as `.gitignore` may remain outside a Work
when forcing membership would turn the graph into repository inventory.

## Change The Earliest Maintained Decision

Classify the intended change before editing:

- When an output only fails to realize an approved upstream decision, correct
  the downstream output and verify conformance.
- When intent, behavior, visual direction, structure, or another production
  decision changes, update the earliest affected Work first, then inspect and
  update each reachable downstream Work.
- When downstream production reveals a faulty upstream decision, return to that
  decision, settle it, and propagate the accepted meaning forward again.

A Task may update one Work or several. Work Graph topology does not define the
Task boundary.

## Preserve A Readable Repository

For textual project knowledge, read
[Atomic Documentation](references/atomic-documentation.md) completely. Apply it
when adding, splitting, merging, moving, or substantially rewriting documents.
For every smaller textual edit, preserve its canonical ownership, descriptive
filename, accurate key points, and relevant links.

Organize every maintained output at the most natural boundary supported by its
medium:

- directories name coherent production or knowledge areas;
- files use descriptive names that reveal their owned responsibility;
- independently maintained knowledge receives one canonical home;
- Work and atomic-document key points support fast grounding;
- code and binary media use native key-point metadata when natural, without introducing
  a new metadata system solely for compliance.

## Preserve Loose Traceability

When one file depends on another and the medium supports an explicit link, add
a normal Markdown link from the explanatory knowledge to the related source or
output. Project-local Markdown links use repository-root-relative paths,
beginning with `/`, and include the target file extension:

```markdown
[Runtime implementation](/implementation/components/runtime/source/project-setup.mjs)
```

Open the repository root as the Obsidian vault root. These links remain ordinary
Markdown, work on GitHub, produce Obsidian backlinks, and can open non-Markdown
targets through the operating system when supported.

When a format cannot naturally carry a link, align descriptive names with the
related upstream and downstream files where practical. Preserve the shared
relation key without overriding ecosystem-required names or making a misleading
exact match.

After moving or renaming a target, update its inbound links and related-name
peers. After changing meaning, inspect explicit links, backlinks, shared names,
the containing Work, and reachable downstream Works for stale knowledge.

## Maintain The Work Graph When Needed

Consider a graph change when the current graph cannot explain an approved
production output, omits a direct maintained input, contains an invalid or stale
relationship, or uses a granularity that prevents useful production decisions.

A material topology change includes creating a graph; adding or removing a
Work or input edge; changing a Work's ID, type, or production meaning; or
splitting or merging Works. Present the proposed production forms, inputs,
branches, merges, and granularity for user agreement before changing topology.

Ordinary content maintenance, link repair, a meaning-preserving move that keeps
the directory-ID contract, and a key-points correction do not require a new
topology decision.

For a new or repaired graph, read
[Work Graph](../understanding-works/references/work-graph.md) completely. Use the
flow from Overview through Specifications, Units, Composites, and Outputs as a
starting point. Select the roles represented by useful maintained Works,
classify each Work by the purpose that best explains why it is maintained
separately, and connect the Works by production causality. Satisfy the Work
Graph contract defined by
`$codex-small-loop:understanding-works`: one Overview root, stable IDs, valid
inputs, reachability, and acyclicity. Reason backward from the desired output
and include approved future Works only when their production structure is
settled.

## Verify The Change

Before completion:

1. Re-read the changed filenames and Work and atomic-document `keyPoints` as a
   new agent would see them. Confirm they state the current content itself and
   provide a correct coarse model before a full body is opened.
2. Follow changed explicit links and check their inbound references.
3. Search for shared-name peers across the relevant Works.
4. Inspect every reachable downstream Work that may be stale when that context
   was supplied for a Controller-owned graph change.
5. State which Works changed, which upstream sources justified the change, and
   which downstream Works were checked.

Add a dedicated trace tool only after ordinary links, Obsidian backlinks, file
search, shared names, and Sonner Work Graph context have proven insufficient in repeated
real work.

## Boundary

This skill owns project mutation discipline, Atomic Documentation structure,
loose traceability, and Work Graph maintenance. It does not require perfect
file-level traceability, force every file into a Work, impose key-point metadata
on media without a natural metadata surface, or maintain a parallel binding
database.
