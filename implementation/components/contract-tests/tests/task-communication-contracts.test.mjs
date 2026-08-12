import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

async function read(relativePath) {
  const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  return source.replace(/\r\n?/g, "\n");
}

test("working-with-codex-tasks is the explicit primitive Task Skill", async () => {
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");
  const metadata = await read(
    "implementation/skills/working-with-codex-tasks/agents/openai.yaml",
  );
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

  assert.match(frontmatter, /name:\s*working-with-codex-tasks/);
  assert.match(frontmatter, /description:\s*Use when/i);
  assert.match(frontmatter, /creating/i);
  assert.match(frontmatter, /forking/i);
  assert.match(frontmatter, /notifying/i);
  assert.match(frontmatter, /conversing/i);
  assert.match(frontmatter, /stopping/i);
  assert.match(frontmatter, /resuming/i);
  assert.match(frontmatter, /recovering/i);
  assert.match(metadata, /codex-small-loop:working-with-codex-tasks/);
  assert.match(metadata, /allow_implicit_invocation:\s*false/);
});

test("Task mechanics cover create, fork, profile inheritance, and lifecycle", async () => {
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");

  assert.match(skill, /commands\/task\.mjs/);
  assert.match(skill, /task\.mjs create[\s\S]*--name[\s\S]*--parent[\s\S]*--role <job-role>/i);
  assert.match(skill, /task\.mjs fork[\s\S]*--name[\s\S]*--parent[\s\S]*--role <job-role>/i);
  assert.match(skill, /--source <source-task-id>/);
  assert.match(skill, /model and reasoning effort are one pair/i);
  assert.match(skill, /service tier is independent/i);
  assert.match(skill, /approval policy/i);
  assert.match(skill, /permission profile|sandbox policy/i);
  assert.match(skill, /end_turn/i);
  assert.match(skill, /fork[\s\S]*returns a launch ID/i);
  assert.match(skill, /record[\s\S]*Task ID[\s\S]*Responder Task ID/i);
  assert.match(skill, /pipe|here-document/i);
  assert.match(skill, /without (?:allocating |using )?(?:a )?PTY/i);
  assert.match(skill, /task\.mjs stop[\s\S]*--task/is);
  assert.match(skill, /task\.mjs resume[\s\S]*--task/is);
  assert.match(skill, /active incoming Conversation branch/i);
  assert.match(skill, /resume is idempotent/i);
});

test("Task messaging separates Notification from managed Conversation", async () => {
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");

  assert.match(skill, /message\.mjs notify[\s\S]*--task/is);
  assert.match(skill, /no reply or acknowledgement is required/i);
  assert.match(skill, /creates no Conversation/i);
  assert.match(skill, /conversation\.mjs start[\s\S]*--task/is);
  assert.match(skill, /conversation\.mjs reply[\s\S]*--conversation/is);
  assert.match(skill, /conversation\.mjs continue[\s\S]*--conversation/is);
  assert.match(skill, /conversation\.mjs accept[\s\S]*--conversation/is);
  assert.match(skill, /--reload-role/);
  assert.match(skill, /MESSAGE_TARGET_BUSY/);
  assert.match(skill, /delivery:\s*"steered"|"started"/i);
  assert.match(skill, /delivery:\s*"queued"/i);
  assert.match(skill, /threadSource/i);
  assert.match(skill, /accept.*only that Conversation/i);
  assert.doesNotMatch(skill, /task\.mjs accept|task accept/i);
});

test("Task Skill owns runtime diagnosis and structured recovery", async () => {
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");

  assert.match(skill, /initialize.*private project runtime[\s\S]*automatically/is);
  assert.match(skill, /runtime\.mjs status[\s\S]*--project-root/is);
  assert.match(skill, /runtime\.mjs repair/);
  assert.match(skill, /compacts terminal records/i);
  assert.match(skill, /structured result whose `run` is other than `ok`/i);
  assert.match(skill, /causeCode/i);
  assert.match(skill, /phase/i);
  assert.match(skill, /never create\s+or fork again/i);
  assert.match(skill, /delivery:\s*"queued"[\s\S]*do not repeat/is);
  assert.match(skill, /retry_resume/);
  assert.match(skill, /new authority.*external action.*destructive choice/is);
  assert.match(skill, /instead of dumping raw JSON/i);
});

test("Roles own workflow and call the Task Skill at concrete action points", async () => {
  const rolePaths = ["controller", "primary", "execute", "review", "interviewer"]
    .map((role) => `implementation/components/roles/${role}/role.md`);
  const roles = await Promise.all(rolePaths.map(read));
  const skill = await read("implementation/skills/working-with-codex-tasks/SKILL.md");
  const primary = roles[1];
  const controller = roles[0];
  const interviewer = roles[4];

  for (const role of roles) {
    assert.match(role, /\$codex-small-loop:working-with-codex-tasks/);
    assert.doesNotMatch(
      role,
      /(?:components\/commands\/)?(?:task|conversation|message|runtime)\.mjs/,
    );
  }

  assert.match(controller, /current Milestone[\s\S]*Role reload/is);
  assert.match(primary, /every Milestone[\s\S]*fresh `execute` fork/is);
  assert.match(primary, /first correction[\s\S]*Role reload/is);
  assert.match(primary, /later Review pass[\s\S]*Role reload/is);
  assert.doesNotMatch(interviewer, /Role reload/i);
  assert.match(primary, /snapshot\.mjs create/);
  assert.match(primary, /signal\.mjs list/);
  assert.match(primary, /signal\.mjs set-severity/);

  assert.match(skill, /caller'?s? Role\s+decides|caller.*Role.*decides/is);
  assert.doesNotMatch(
    skill,
    /snapshot\.mjs|signal\.mjs|Milestone|Baseline Verification|Trust Review|Technical Excellence Review|Customer Value Review|Interviewer/i,
  );
});
