---
summary: >-
  Define when Codex Small Loop activates and how the first user-facing turn
  presents setup, model, speed, and profile confirmation.
---

# Activation And Execution Profile

Codex Small Loop activates only when the user explicitly selects it in Codex
Desktop or directs Codex to use Codex Small Loop for the requested work. An
ordinary conversation, a generic interview request, or a mere mention of the
plugin does not activate the workflow.

The implicitly available `codex-small-loop:handling-user-requests` Skill is the
plugin's user-facing entry point. The first active turn reads the complete
bundled English Markdown guide and, when needed, translates only its visible
text into the language of the latest user-authored message.
It performs no project, external-context, or requested-deliverable investigation
before the guide. The guide combines canonical execution-profile data with a
localized Markdown source and renders the bundled hero image from its absolute
filesystem path. It briefly introduces Codex Small Loop and always lists optional
Slack and Obsidian recommendations with a short reason to use them. Its Next
Action then invites the user to choose the Agent model, compares the available
models, places a short note between the model and speed tables that thinking
and implementation may use separate models, and presents 1x versus accelerated execution speed before the one
necessary model question. Speed defaults to 1x without a separate question;
1.5x applies only when the user explicitly selects it. The entry path inspects
neither connector nor project state. Internal runtime names such as
`serviceTier` remain hidden. The complete guide and question appear together in
the final response without HTML or a visualization file.

The ordinary model choice and the user-facing thinking model are the Primary
profile. The user-facing implementation model is the optional Worker profile.
The short note does not add another table or question to the normal path. A
voluntarily supplied Worker model applies to Execute,
Review, and Interviewer; otherwise Worker uses the Primary model. If the user
asks to split profiles without naming the Worker model, only that missing value
is clarified. The selected speed remains shared by both profiles.

The Root uses conversation history rather than persistent preference state. If
the user specified a model, the Root resolves the profile immediately with the
explicit speed or the 1x default and does not reconfirm it. If the model is
missing, the Root asks only for the model while retaining an explicitly selected
speed or defaulting it to 1x. With neither setting present, it proposes Terra
Medium and explains the 1x default in the guide's Next Action section, for
example:

> Start with Terra Medium? Unless you explicitly select 1.5x, execution remains at 1x.

An explicit answer that supplies or changes a setting is agreement to that
value and is not reconfirmed. On that next user-authored turn, the entry Skill
loads the Controller Role after the model is resolved and the explicit or
default speed is fixed; project
investigation and Interview begin there. Controller owns the user-facing
thinking/implementation terminology and maps it to Primary/Worker. It keeps the Codex App
settings of its user-facing Task. It applies the agreed Primary model, reasoning
effort, and speed explicitly when creating Primary and supplies the resolved
Worker model, reasoning effort, and shared speed in the launch assignment.
Primary explicitly applies the Worker profile to each new Execute, Review, and
Interviewer. The Worker pair equals the Primary pair when the optional setting
was omitted.

Optional setup recommendations do not block the request. Missing bundled
plugin content is an installation problem; Slack provides external reminders,
and an Obsidian vault makes project knowledge easier for a person to browse.

## System Realization

- [Controller Job Role](/specification/system-specification/roles/controller.md)
- [Handling User Requests](/specification/system-specification/skills/handling-user-requests.md)
- [Welcome contents](/implementation/contents/welcome/initialization-guide.md)
