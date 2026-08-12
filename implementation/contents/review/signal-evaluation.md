---
summary: >-
  The one canonical standard for evaluating every Codex Small Loop Review Signal
  by its supported improvement and implementation proportionality.
---

# Review Signal Evaluation

This document is the single source of truth for Review Signal severity. A
Review responsibility decides where to inspect. This shared evaluation standard
decides which severity accurately describes a finding from any responsibility.

Evaluate the correction supported by the finding through either of these value
lenses. A finding does not need to satisfy both.

## Development Efficiency

Judge whether the correction makes continued development meaningfully easier,
faster, safer, or more reliable. This includes improvements to the environment,
documentation, and rules, as well as long-term code maintenance that reduces
change, diagnosis, testing, recovery, or operational cost.

## User Experience

Judge whether users can perceive a meaningful improvement while using the
delivered result. This includes usability improvements and defect or bug fixes.
Use the supported users, interactions, and frequency of the current outcome;
do not raise severity for hypothetical audiences or unsupported behavior.

## Implementation Proportionality

Judge whether the correction is proportionate to the problem it solves and
avoids unnecessary implementation complexity.

## Severity

First use the strongest level supported by concrete evidence under either value
lens. Implementation Proportionality sets the upper limit: the final severity
must not exceed the level supported by that axis.

| Severity | Development Efficiency | User Experience | Implementation Proportionality |
|---|---|---|---|
| `required` | The correction substantially improves development efficiency. | Every user can perceive the improvement in a frequent interaction. | The correction is proportionate to the problem and does not introduce unnecessary complexity. |
| `consider` | The correction modestly improves development efficiency. | Every user can perceive the improvement in an infrequent interaction. | The correction is broadly proportionate, but could be implemented more simply. |
| `later` | There is a supported opportunity to improve development efficiency. | Some users, or users in a limited interaction, can perceive the improvement. | The correction is too large for the problem and needs a simpler implementation. |
| `dismiss` | The supported opportunity to improve development efficiency is small. | The opportunity for users to perceive an improvement is small. | The correction is disproportionate to the problem and introduces unnecessary complexity. |

## Calibrate For The Work, Not For More Work

The Reviewer's job is to evaluate the assigned responsibility accurately and
leave the correct Signals. It is not to find a `required` Signal. Reporting no
`required` Signal has substantial value when the evidence does not meet that
bar, because unnecessary required corrections lengthen delivery and expand the
candidate without sufficient benefit.

The Signal's free-form `Explanation` must contain enough supported reasoning
for Primary to understand and independently judge its severity. A Reviewer who
marks a Signal `required` owns the burden of explaining why the finding clears
that bar. If the Explanation cannot support `required`, the correct response is
to choose a lower severity rather than use urgency as a substitute for
evidence.

On a later Review pass that examines corrections from an earlier pass, treat a
new `required` Signal with additional care. It may be important, but it was not
found in the earlier complete review and may instead indicate a lower-value
improvement or an expanding correction boundary. Consider whether leaving the
new behavior unchanged, narrowing the correction, or reverting an earlier
change produces a better result than extending the correction again.

Primary reads every Signal and owns its final severity. Primary may raise or
lower the Reviewer's severity when the evidence and this standard support a
different result. Only a Signal whose final severity is `required` proceeds
through Interview and Execute. Signals that remain `consider`, `later`, or
`dismiss` stay as observations for that Review pass; they do not carry work
into a future Milestone.
