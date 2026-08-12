---
summary: >-
  codex-small-loop:handling-user-requests is the explicit user-facing entry point
  that renders initial setup and resolves the execution profile before loading
  Controller on the next user-authored turn.
---

# Handling User Requests

`codex-small-loop:handling-user-requests` activates only when the user selects
Codex Small Loop, explicitly invokes the Skill, or directly asks to use Whole Job
Loop for the current request. Discussion or inspection of Codex Small Loop does
not activate the workflow.

The Skill owns the latency-sensitive initial setup boundary. Before project,
external-context, or requested-deliverable investigation, it reads the
complete bundled English Markdown guide. The guide always contains Slack and
Obsidian recommendations; the entry path does not inspect connector or project
state. It translates only visible text when the user's language differs from
the canonical English, replaces the image placeholder with the bundled hero
image's absolute path, and emits the complete Markdown directly in the final
response.

That same final response asks only for a missing model or speed. On the next
user-authored turn, the Skill incorporates the answer and keeps asking only for
any still-missing setting. Once the profile is resolved, it retains the exact
model, reasoning effort, and speed as the managed-Agent profile, runs
`components/commands/role.mjs controller`, and reads the complete output. The
user-facing Controller keeps its Codex App settings and applies the selected
profile explicitly when it creates Primary. The Controller Role owns intent
clarification, Interview, plan agreement, Primary creation, supervision,
verification, and delivery.

## Implementation

- [Runtime skill](/implementation/skills/handling-user-requests/SKILL.md)
- [Codex UI metadata](/implementation/skills/handling-user-requests/agents/openai.yaml)
- [Controller Job Role](/specification/system-specification/roles/controller.md)
- [Activation and execution profile](/specification/interaction-specification/activation/activation-and-execution-profile.md)
- [Welcome contents](/implementation/contents/welcome/initialization-guide.md)
