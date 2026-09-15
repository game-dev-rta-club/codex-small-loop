---
keyPoints: >-
  A Work Graph begins at one Overview and connects maintained production
  outputs through the direct inputs that shape each downstream result.
---

# Work Graph

A **Work** is a maintained production output with a recognizable form. A Work
may be a concept, specification, source tree, asset collection, test suite,
film, sound master, or another output that remains useful as production
continues.

A **Work Graph** is a directed acyclic graph of those Works and their direct
maintained inputs. It preserves lower-cost decisions and intermediate outputs
so a person or agent can understand and revise expensive downstream results.

## Meaning

Every graph begins at exactly one `Overview`. The Overview has no inputs and
states the intended production at the broadest useful level.

An edge points from an input Work toward the downstream Work that it shapes.
The downstream Work lists that input in its own `.WORK_NODE.xml`. Branches allow
independent outputs to advance from shared context. Merges state that a result
depends directly on several maintained inputs.

The graph records production causality. It is not a schedule, task list,
progress tracker, role hierarchy, document taxonomy, or inventory of every
repository file. Graph membership does not mean that a Work is complete.

## A Useful Starting Shape

When designing a new graph, start by looking for this production flow:

```text
Overview
-> Specifications
-> Units
-> Composites
-> Outputs
```

- **Overview** explains the project as a whole.
- **Specifications** make the current product understandable to someone new to
  the project. Use them both to make decisions before production and to keep
  accepted decisions current as production evolves. Choose the clearest
  medium, including prose, diagrams, images, sound, HTML, or prototypes, and
  group the material into a small number of broad subjects.
- **Units** package self-contained production parts for convenient use by
  Composites. Keep internal assets and technical elements together when later
  production selects, replaces, and evaluates them as one part.
- **Composites** integrate Units or other Composites into results that can be
  produced and evaluated in a real usage context.
- **Outputs** are maintained for an intended user, tool, or execution
  environment to use in their current form. They may shape other Works and do
  not imply a graph endpoint.

Adapt this starting shape to the project's scale, medium, and established
structure. Use only the layers represented by useful maintained Works, and use
the role that best explains why each Work is maintained separately. Add a
combined Output when the project maintains the integrated result as its own
production surface. Names such as `GameplaySpecifications`, `BGMUnits`,
`StageDataComposites`, and `SkillOutputs` can make each role easier to recognize
when they fit the project naturally.

## Storage

Every Work is a meaningful directory containing `.WORK_NODE.xml`. The marker's
`id` is a stable graph identity independent of the directory basename. Parent
directories may classify Works without becoming Works themselves, and existing
production paths do not need to be renamed to participate in the graph.

The historical `WORK_NODE.xml` name is not loaded. Sonner surfaces it as a
Files warning with the exact `.WORK_NODE.xml` rename target.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<work-node id="implementation" type="Implementation">
  <keyPoints>The plugin turns the maintained specifications into the installed skills, roles, runtime, Sonner, and Board.</keyPoints>
  <inputs>
    <input ref="interaction-specification" />
    <input ref="system-specification" />
    <input ref="technical-specification" />
  </inputs>
</work-node>
```

The `id` is unique and stable. The `type` names the reusable production form.
The `keyPoints` state the current or approved intended output itself, including
its main behavior, decisions, and important boundaries. Each
`input.ref` names one existing direct input Work. Store an edge only in the
consumer and derive downstream relationships by reverse lookup.

A valid graph:

- has exactly one Overview with no inputs;
- gives every Work a unique ID;
- keeps every Work ID unique even when directory names differ;
- references only existing inputs;
- keeps every Work reachable from the Overview; and
- contains no cycle.

## Scope And Granularity

Use the smallest graph that improves production decisions without turning the
graph into file inventory. A Work is useful when it is independently
maintained, changes for a recognizable production reason, can shape several
downstream outputs, or preserves a cheaper representation of a costly result.

Not every maintained file belongs to a Work. Host-required configuration and
support files may remain outside the graph. Conversely, `.WORK_NODE.xml` marks a
Work entry point without claiming exclusive ownership of every descendant.

Prefer forms reusable across the relevant production practice. `Storyboard`,
`Film`, `System Specification`, and `Implementation` remain meaningful across
projects; a project-specific feature name usually belongs inside one of those
Works.

## Current Knowledge

The graph represents the approved current and future production structure, not
every historical revision. When a downstream result exposes a faulty upstream
decision, update the earliest affected maintained Work and reconsider each
reachable downstream consumer.

An approved future Work may appear before its full content exists. Its marker
records agreed production structure, not completion or readiness. Progress and
execution state belong outside `.WORK_NODE.xml`.

## Traceability

Work edges provide the universal trace across media. Documents add precise
repository-root-relative Markdown links when the medium supports them. Files
that cannot carry links use aligned descriptive names where practical. These
layers provide useful discovery without promising perfect file-level
traceability or requiring a separate binding database.
