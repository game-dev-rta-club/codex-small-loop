---
keyPoints: >-
  execute is a Milestone-scoped Child role that performs its initial project
  change and later Review corrections without losing implementation context.
---

# Execute Job Role

The installed runtime definition is
`components/roles/execute/role.md`. This page documents
that contract; it is not the file loaded at runtime.

Primary creates one fresh execute fork at the start of each Milestone and reuses
it only for later incoming Conversations in that Milestone. Each assignment supplies one current
problem context: changes that share the same problem, governing premises,
implementation direction, and verification approach. A problem context may be
large or span many files; change volume and file count alone do not split it.
Different problem contexts arrive sequentially so they do not compete inside
one Execute turn. The initial assignment combines the accepted Primary history
inherited by the fork with the current outcome, constraints, authority boundary,
and acceptance bar sent after launch.
Later implementation contexts and Review corrections arrive as new
Conversations on that same Task. Execute completes only the current problem
context and does not pre-implement a later one merely because it is visible.

Execute may modify the project within each assignment. It inspects the current
state, implements the change, preserves unrelated work, and runs the relevant
tests and real-environment checks. For corrections, it rereads the supplied
Signals before modifying project files and continues from its retained
implementation context. Same-context, overlapping, or coupled Signals stay in
one correction assignment; different problem contexts arrive in separate
Conversations. Execute reconciles the current assignment's change locations
and constraints and does not report completion until every supplied Signal is
covered. A material conflict among Signals returns to Primary rather than being
resolved by silently choosing one. Execute reports
the changed project files, evidence, and material limits to its direct Parent
through each incoming Conversation.

Execute does not accept its own work, close its incoming relationship, or own
final delivery. Primary inspects its result and starts the four required
read-only
[Review Job Role](/specification/system-specification/roles/review.md)
Children before accepting any project change.

Accepting one Execute Conversation does not retire the Task during its
Milestone. It remains available for a later problem context or correction
Conversation in that Milestone. A later Milestone creates a fresh Execute. If
the current Milestone Execute cannot be resumed,
Primary receives the error and decides recovery; Codex Small Loop does not
silently replace it with a fresh Execute.

## Implementation

- [Runtime role](/implementation/components/roles/execute/role.md)
- [Task interaction Skill](/implementation/skills/working-with-codex-tasks/SKILL.md)
