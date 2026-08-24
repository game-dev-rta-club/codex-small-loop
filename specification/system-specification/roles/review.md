---
keyPoints: >-
  review is a read-only Child role that independently evaluates one of four
  required quality responsibilities, preserves the candidate, and records
  material findings as evidence without prescribing or applying fixes.
---

# Review Job Role

The installed runtime definition is
`components/roles/review/role.md`. This page documents
that contract; it is not the file loaded at runtime.

After inspecting an Execute result, Primary makes a shared Review Plan and
responsibility map in its current turn. It creates four Review forks against
the initial candidate, then retains those four Tasks for later Review passes:

- **Baseline Verification** runs the broad reusable mechanical checks once,
  including the full test suite, build or compile, lint or typecheck, syntax
  and diff hygiene, and a minimal startup or HTTP smoke check when applicable.
- **Trust Review** judges whether the candidate can be safely relied on within
  its authority and whether material safety, security, privacy, and evidence
  claims justify that trust.
- **Technical Excellence Review** judges whether the candidate uses the
  simplicity and sound design needed for the project to continue changing,
  testing, diagnosing, recovering, and operating quickly and safely. It does
  not reward technical sophistication, speculative abstraction, or unnecessary
  implementation.
- **Customer Value Review** judges whether the candidate delivers substantial
  value to its intended customer or recipient within the agreed outcome, scope,
  and authority. Possible enhancements or additional features are not findings
  when the agreed value is already delivered.

Each Task keeps one responsibility. On every pass it receives a new
Conversation with the exact snapshot pair, diff, and context needed to evaluate
the complete material impact surface of that pass's changes. All four run in
parallel with the shared division of work.

The responsibilities are outcome goals, not fixed or exhaustive checklists.
Review derives its exploration axes from the exact candidate and assigned goal.

Baseline Verification owns the broad mechanical checks for the batch. Trust,
Technical Excellence, and Customer Value do not repeat those checks solely for
general confidence. They may run targeted checks needed for their assigned
responsibility or to reproduce a finding.

The candidate is strictly read-only. Review may inspect files, diffs, history,
logs, and run non-mutating tests or real-environment checks. It does not edit
candidate files, apply fixes, create corrective commits, push, merge, or
otherwise alter the outcome it judges.

The only path Review may write or modify is `.codex-small-loop/signals/`. This
private ignored directory holds snapshot-scoped coordination records and is
not part of the candidate. One material finding uses one Review Signal file,
and Review does not modify any other project or runtime file.

Commands that normally write generated files or caches use a non-writing mode
or temporary isolation outside the project. When neither is possible, Review
reports that verification limit instead of changing the reviewed project.

After running the supplied snapshot diff and before broader checks, Review
enumerates the material exploration axes implied by its responsibility, the
outcome and acceptance bar, the changed candidate, its material impact surface,
relevant state transitions, boundaries, failure modes, and user actions.
Primary's axes are minimum coverage; Review adds material axes exposed by the
candidate or early evidence. It does not rescan unrelated parts of the whole
candidate. A finding is not a stop condition, so Review records it and
continues through the remaining axes unless further checking would be unsafe or
genuinely impossible.

For every material finding, Review creates one Signal file:

```text
node <plugin-root>/components/commands/signal.mjs create \
  --task <primary-task-id> \
  --snapshot <currentSnapshot> \
  --name <lowercase-kebab-case-signal-name> \
  --template review-signal
```

Before classifying a finding, Review reads
[`signal-evaluation.md`](/implementation/contents/review/signal-evaluation.md).
That document is the single source of truth and owns all severity definitions
and calibration rules for every responsibility and every pass. Accurate
classification is the Reviewer's job; success does not require producing or
finding a `required` Signal.

Review edits only the returned Signal file. It replaces the instructional
`severity` with `required`, `consider`, `later`, or `dismiss`, replaces the
one-line `summary`, and writes the free-form `Explanation`. The Explanation
contains the facts and reasoning Primary needs to understand the finding and
judge why its selected severity is accurate. Review leaves the
`Implementation Approach` placeholder unchanged and does not prescribe an
implementation plan, implementation approach, or proposed correction. The
Signal file is the authoritative finding record, and create never overwrites an
existing file.

Before handoff, Review accounts for every planned axis as:

- `PASS`, when evidence supports the expected result;
- `FINDING`, when evidence shows a material defect, risk, or unmet expectation;
  or
- `LIMIT`, when the axis could not be completed, with the concrete reason and
  strongest safe evidence obtained.

Review reports verification limits, a clear assessment, and this compact
coverage accounting. A `FINDING` entry gives the Review Signal file path. The
handoff may include useful context outside the authoritative Signal files, such
as coverage accounting, `PASS` or `LIMIT` evidence, cross-cutting observations,
and concise context that helps Primary decide. Review includes that context
when it adds value; wholesale duplication of each Signal's Explanation is not
required. Beyond the coverage accounting, Review has no mandatory result
schema. A reviewer may surface an important
finding outside its assigned responsibility, but it does not replace the other
reviews. Review neither chooses nor applies the implementation response.

Primary waits for all four results, integrates their evidence, owns each
Signal's final severity, and chooses the response while remaining responsible
for the whole-job outcome. Findings are not automatic vetoes.

Review completes every planned exploration axis in its initial handoff. Primary
does not ask it to assume all reported Signals were implemented and search for
what other locations remain. Primary accepts that completed Conversation and
retains the Reviewer Task for a possible
[Interviewer](/specification/system-specification/roles/interviewer.md)
Conversation about `required` Signals. Review answers the Interviewer from its
evidence and reasoning. It helps deepen the Signal into an
implementation-ready correction and explores adjacent inputs, sibling
operations, states, failure transitions, or consumers that share the same cause
or invariant. Same-cause cases join the same correction and same Signal; a
distinct cause returns to Primary. It does not recursively ask what remains
after assuming every fix is implemented. After Interview,
Primary forwards Signals that remain `required` to the same existing
[Execute Job Role](/specification/system-specification/roles/execute.md)
Task in a new Conversation. It then starts new Conversations with the same four
Review Tasks, explaining how earlier findings were handled and everything that
changed since the previous pass. There is no separate Integration Review Child;
Primary owns candidate integration and current-Milestone acceptance, while
Controller owns independent whole-request acceptance.

## Implementation

- [Runtime role](/implementation/components/roles/review/role.md)
- [Task interaction Skill](/implementation/skills/working-with-codex-tasks/SKILL.md)
