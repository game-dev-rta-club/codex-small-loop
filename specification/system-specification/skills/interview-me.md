---
keyPoints: >-
  codex-small-loop:interview-me adapts the upstream interview-me procedure to
  clarify only explicitly active, interactive Codex Small Loop requests before
  planning.
---

# Interview Me

`codex-small-loop:interview-me` is the user-requirement interview used by
[Controller](/specification/system-specification/roles/controller.md).
It runs only inside an explicitly active Codex Small Loop request when material
ambiguity remains after discoverable context has been inspected. Its
plugin-qualified identity lets an external or standalone `interview-me`
skill remain installed without changing ordinary conversations.

## Procedure

The adapter resolves the installed plugin root and reads the complete,
unmodified upstream procedure from
[the vendored SKILL.md](/implementation/third_party/agent-skills/interview-me/SKILL.md).
It then:

1. reuses the project context already gathered by Controller;
2. states a hypothesis and confidence;
3. asks one question at a time with a guess attached;
4. obtains explicit confirmation of the intent restatement; and
5. returns that confirmed intent to Controller for the Codex Small Loop plan and
   agreement gate.

It does not take the upstream downstream-skill route. Planning and execution
remain owned by Codex Small Loop. The Review correction-time
[Interviewer Job Role](/specification/system-specification/roles/interviewer.md)
is a separate responsibility.

## Implementation

- [Codex Small Loop adapter](/implementation/skills/interview-me/SKILL.md)
- [Codex UI metadata](/implementation/skills/interview-me/agents/openai.yaml)
- [Plugin distribution and upstream ownership](/specification/technical-specification/package/plugin-distribution.md)
- [Contract tests](/implementation/components/contract-tests/tests/codex-small-loop-contracts.test.mjs)
- [Manual workflow verification](/implementation/testing.md)
