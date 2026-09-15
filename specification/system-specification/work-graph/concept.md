---
keyPoints: >-
  A Work Graph keeps each durable stage of a production connected to the earlier
  Work that gives it shape, beginning at one Overview and allowing branches and
  merges where production paths diverge and meet.
---

# Work Graph

A **Work Node** is a maintained production output that gives shape to later
work. The earlier Work Node is cheaper to inspect and revise, while the later
Work Node carries more complete detail. It can be the earlier skeleton of the
whole product or a maintained view of one aspect. For a film, Plot can shape
Screenplay, Storyboard, and Film; character and background designs can join the
Storyboard at Layout and Shot production.

A **Work Graph** is a directed acyclic graph of maintained Work Nodes and their
direct input relationships. It has one `Overview` root, may branch, and may
merge. Work types use
recognizable production forms rather than feature, role, or activity names
invented for one project. A project chooses the useful Works and relationships;
it does not need every possible production output.

The graph records approved production causality, not a fixed procedure,
schedule, backlog, or progress tracker. It includes both maintained Works that
already exist and approved future Works that the production is expected to
create. An agent starts from the requested output and reasons backward through
available inputs instead of executing every visible path in order.

A merge lists the complete set of maintained Works that directly shape or
constrain the downstream Work.
For software, Interaction Specification, System Specification, and Technical
Specification can all join at Implementation. A project may split domain,
behavior, or packaging into separate Works when they are independently
maintained; otherwise they can remain Parts of the system or technical view.

## Recommended Production Shape

A useful starting point for a new Work Graph is:

```text
Overview
-> Specifications
-> Units
-> Composites
-> Outputs
```

This shape follows production as the whole idea becomes a small number of
decision areas, branches into independently producible parts, converges into
integrated results, and reaches the forms used from the project. A project uses
the layers represented by its maintained Works. The graph itself follows
production causality, so related Works may connect within one layer, branch,
merge, or end at several places.

- **Overview** is the entry point for understanding the project as a whole.
- **Specifications** document the current product well enough for someone new
  to understand its intended behavior and qualities. They support decisions
  made before production and stay current as accepted decisions emerge during
  production. Their medium may be prose, diagrams, images, sound, HTML,
  prototypes, or whatever communicates the specification best. Divide them
  into a small number of broad content areas, such as user interaction, system
  structure, and technical realization.
- **Units** are self-contained production packages prepared for convenient use
  by Composites. A Unit may assemble several internal assets or technical
  elements when they are selected, replaced, and evaluated together in later
  production.
- **Composites** combine Units or other Composites into maintained results that
  can be produced and evaluated in a real usage context.
- **Outputs** are maintained for an intended user, tool, or execution
  environment to use in their current form. Outputs may shape other Works and
  do not imply a graph endpoint.

Projects adapt this starting shape to their scale, medium, and established
structure. When a Work has several qualities, use the role that best explains
why the project maintains it separately. An integrated Output is its own Work
when the project maintains that combined result as a distinct production
surface. Directory names can carry the role as a suffix when it improves
readability, such as `GameplaySpecifications`, `BGMUnits`,
`StageDataComposites`, or `SkillOutputs`.

## Input Relationships

An input relationship means the downstream Work directly depends on the
upstream Work. It records production causality, not an execution unit, fixed
workflow, responsibility boundary, or schedule. One project change may update
one Work or several affected Works without changing what the graph means.

## Maintained State

Graph membership does not mean complete and does not indicate progress. It
states that a production output and its causal place have been approved. The
Work Graph therefore has no status field; schedules and progress belong to
their own project-management view.

Once a Work has production content, that content stays current. When later
production exposes a faulty earlier decision, update the earliest affected Work
Node and inspect its reachable consumers forward. This lets a new agent recover
the latest project state without replaying its history.

Temporary prototypes and experiments are not Work Nodes merely because they
were produced. They improve a maintained Work Node, and their accepted learning
is written back into the graph. A prototype and a production release are
separate goals; an obsolete prototype is not kept as a stale stage in the
maintained graph.

## Representation

Each Work Node is represented by a meaningful project directory. Its
`.WORK_NODE.xml` declares a stable `id`, a recognizable `type`, `keyPoints`, and
its direct `inputs`. The Work ID is independent of the containing directory's
basename: the path describes physical organization while the ID provides a
stable semantic identity for graph edges. Parent directories may classify
related Works. The directory uses the most meaningful production path and may
coincide with an existing `components/`, `tests/`, `assets/`, or other
production directory. Agents inspect the marker and selected directory rather
than maintaining a duplicate README index. Every `input` records one direct
upstream Work on which the current Work depends. Downstream impact is derived
from those connections.

## Reference

- [Runtime Work Graph knowledge](/implementation/skills/understanding-works/references/work-graph.md)
- [Work Graph design contract](/specification/system-specification/work-graph/contract.md)
- [Understanding Works](/specification/system-specification/skills/understanding-works.md)
- [Creating And Maintaining Works](/specification/system-specification/skills/creating-and-maintaining-works.md)
