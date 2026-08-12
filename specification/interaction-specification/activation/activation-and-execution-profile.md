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
models, and presents 1x versus accelerated execution speed before the one
necessary profile question. The entry path inspects neither connector nor
project state. Internal runtime names such as `serviceTier` remain hidden. The
complete guide and question appear together in the final response without HTML
or a visualization file.

The Root uses conversation history rather than persistent preference state. If
the user already specified both model and speed, both values are agreed and the
Root proceeds without profile confirmation. If exactly one is present, the Root
asks only for the missing setting. If neither is present, it proposes Terra
Medium at 1x speed and asks one confirmation in the user's language in the
guide's Next Action section, for example:

> Terra Medium・1xで始めてよいですか？

An explicit answer that supplies or changes a setting is agreement to that
value and is not reconfirmed. On that next user-authored turn, the entry Skill
loads the Controller Role only after both settings are resolved; project
investigation and Interview begin there. The Controller keeps the Codex App
settings of its user-facing Task. It applies the agreed model, reasoning effort,
and speed explicitly when creating Primary; Primary and its managed Children
then inherit that profile unless the user approves a Child-specific override.

Optional setup recommendations do not block the request. Missing bundled
plugin content is an installation problem; Slack provides external reminders,
and an Obsidian vault makes project knowledge easier for a person to browse.

## System Realization

- [Controller Job Role](/specification/system-specification/roles/controller.md)
- [Handling User Requests](/specification/system-specification/skills/handling-user-requests.md)
- [Welcome contents](/implementation/contents/welcome/initialization-guide.md)
