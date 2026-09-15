---
keyPoints: >-
  codex-small-loop:handling-user-requests is the explicit user-facing entry point
  that renders initial setup and resolves the execution profile before loading
  Controller on the next user-authored turn.
---

# Handling User Requests

`codex-small-loop:handling-user-requests` activates only when the user selects
Codex Small Loop, explicitly invokes the Skill, or directly asks to use it for
the current request. Discussion or inspection of Codex Small Loop does not
activate the workflow.

The Skill owns the latency-sensitive initial setup boundary. Before project,
external-context, or requested-deliverable investigation, it reads the
complete bundled English Markdown guide. The guide always contains Slack and
Obsidian recommendations; the entry path does not inspect connector or project
state. It translates only visible text when the user's language differs from
the canonical English, replaces the image placeholder with the bundled hero
image's absolute path, and emits the complete Markdown directly in the final
response.

Speed resolves to 1x whenever the user did not explicitly choose one; 1.5x is
used only by explicit selection. The final response therefore never asks a
speed-only follow-up. It asks only for a missing Primary model and states that
speed remains 1x unless 1.5x is selected. Between the model and speed tables,
the guide briefly notes that thinking and implementation may use separate
models, without adding that choice to the normal question sequence. In this
user-facing terminology, thinking maps to Primary and implementation maps to
Worker. A voluntarily supplied Worker model
applies to Execute, Review, and Interviewer; otherwise it resolves to the
Primary model. If the user requests a split without naming the Worker model,
only that missing value is clarified. On the next user-authored turn, the Skill
incorporates the answer and keeps asking only while a required value is missing.
Once the profiles are resolved, it retains the exact Primary and Worker model
and reasoning-effort pairs plus their shared speed, runs
`components/commands/role.mjs controller`, and reads the complete output. The
user-facing Controller owns this terminology, keeps its Codex App settings, applies the Primary
profile explicitly when it creates Primary, and supplies the Worker profile in
that assignment for explicit use by Execute, Review, and Interviewer. The
Controller Role owns intent clarification, Interview, plan agreement, Primary
creation, supervision, verification, and delivery.

## Implementation

- [Runtime skill](/implementation/skills/handling-user-requests/SKILL.md)
- [Codex UI metadata](/implementation/skills/handling-user-requests/agents/openai.yaml)
- [Controller Job Role](/specification/system-specification/roles/controller.md)
- [Activation and execution profile](/specification/interaction-specification/activation/activation-and-execution-profile.md)
- [Welcome contents](/implementation/contents/welcome/initialization-guide.md)
