import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  runTaskCli,
} from "../../commands/task.mjs";
import { TaskLaunchError } from "../source/task-launch.mjs";

const PROJECT_ROOT = path.resolve("/project");
const TARGET_ROOT = path.resolve("/workspace/current", "../target");

function capture() {
  let output = "";
  return {
    write(chunk) {
      output += chunk;
    },
    json() {
      assert.equal(output.endsWith("\n"), true);
      assert.equal(output.trim().split("\n").length, 1);
      return JSON.parse(output);
    },
    text() {
      return output;
    },
  };
}

test("task help presents create, fork, stop, and resume", async () => {
  const stdout = capture();
  const exitCode = await runTaskCli(["--help"], { stdout });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /task create/);
  assert.match(stdout.text(), /task fork/);
  assert.match(stdout.text(), /task stop\|resume/);
  assert.match(stdout.text(), /--service-tier default.*normal Codex tier/i);
  assert.doesNotMatch(stdout.text(), /task launch/);
});

test("runs create with an explicit name, parent, role, and cwd default", async () => {
  const stdout = capture();
  const calls = [];
  const supervisorRoots = [];
  const exitCode = await runTaskCli(
    ["create", "--name", "Curie", "--parent", "parent-1", "--role", "primary"],
    {
      cwd: "/project",
      stdin: Readable.from(["Implement the requested change."]),
      stdout,
      async launch(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "create",
          launchId: "launch-1",
          name: "Curie",
          parentTaskId: "parent-1",
          childTaskId: "child-1",
          role: "primary",
          phase: "ready",
        };
      },
      startSupervisor(projectRoot) {
        supervisorRoots.push(projectRoot);
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Curie",
    parentTaskId: "parent-1",
    role: "primary",
    assignment: "Implement the requested change.",
  }]);
  assert.deepEqual(supervisorRoots, [PROJECT_ROOT]);
  assert.deepEqual(stdout.json(), {
    run: "ok",
    operation: "create",
    launchId: "launch-1",
    name: "Curie",
    parentTaskId: "parent-1",
    childTaskId: "child-1",
    role: "primary",
    phase: "ready",
  });
});

test("runs fork with an explicit execute role and starts recovery supervision", async () => {
  const stdout = capture();
  const calls = [];
  const supervisorRoots = [];
  const exitCode = await runTaskCli(
    ["fork", "--name", "Builder-1", "--parent", "parent-1", "--role", "execute"],
    {
      cwd: "/project",
      stdin: Readable.from(["Review the accepted change."]),
      stdout,
      async fork(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "fork",
          launchId: "launch-1",
          name: "Builder-1",
          role: "execute",
          phase: "fork_queued",
          nextAction: {
            type: "end_turn",
            required: true,
            reason: "The fork starts after this Parent turn completes.",
          },
        };
      },
      startSupervisor(projectRoot) {
        supervisorRoots.push(projectRoot);
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Builder-1",
    parentTaskId: "parent-1",
    role: "execute",
    assignment: "Review the accepted change.",
  }]);
  assert.deepEqual(supervisorRoots, [PROJECT_ROOT]);
  assert.deepEqual(stdout.json(), {
    run: "ok",
    operation: "fork",
    launchId: "launch-1",
    name: "Builder-1",
    role: "execute",
    phase: "fork_queued",
    nextAction: {
      type: "end_turn",
      required: true,
      reason: "The fork starts after this Parent turn completes.",
    },
  });
});

test("runs a fork managed by one Parent from another Task's context", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runTaskCli(
    [
      "fork",
      "--name",
      "Interviewer-1",
      "--parent",
      "primary-1",
      "--source",
      "execute-1",
      "--role",
      "interviewer",
    ],
    {
      cwd: "/project",
      stdin: Readable.from(["Refine the required Signal."]),
      stdout,
      async fork(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "fork",
          launchId: "launch-1",
          name: "Interviewer-1",
          parentTaskId: "primary-1",
          sourceTaskId: "execute-1",
          role: "interviewer",
          phase: "fork_queued",
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Interviewer-1",
    parentTaskId: "primary-1",
    sourceTaskId: "execute-1",
    role: "interviewer",
    assignment: "Refine the required Signal.",
  }]);
  assert.equal(stdout.json().sourceTaskId, "execute-1");
});

test("passes an explicit service tier with a complete model override to fork", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runTaskCli(
    [
      "fork",
      "--name",
      "Builder-1",
      "--parent",
      "parent-1",
      "--role",
      "execute",
      "--model",
      "gpt-5.6-sol",
      "--reasoning-effort",
      "medium",
      "--service-tier",
      "priority",
    ],
    {
      cwd: "/project",
      stdin: Readable.from(["Implement the requested change."]),
      stdout,
      async fork(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "fork",
          launchId: "launch-1",
          name: "Builder-1",
          role: "execute",
          phase: "fork_queued",
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Builder-1",
    parentTaskId: "parent-1",
    role: "execute",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    assignment: "Implement the requested change.",
  }]);
});

test("passes a service-tier override independently of model settings", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runTaskCli(
    [
      "launch",
      "--name",
      "Curie",
      "--parent",
      "parent-1",
      "--role",
      "primary",
      "--service-tier",
      "priority",
    ],
    {
      cwd: "/project",
      stdin: Readable.from(["Implement the requested change."]),
      stdout,
      async launch(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "launch",
          launchId: "launch-1",
          name: "Curie",
          role: "primary",
          phase: "ready",
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Curie",
    parentTaskId: "parent-1",
    role: "primary",
    serviceTier: "priority",
    assignment: "Implement the requested change.",
  }]);
});

test("maps the explicit default service tier to the normal Codex tier", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runTaskCli(
    [
      "fork",
      "--name",
      "Primary-1",
      "--parent",
      "controller-1",
      "--role",
      "primary",
      "--model",
      "gpt-5.6-terra",
      "--reasoning-effort",
      "medium",
      "--service-tier",
      "default",
    ],
    {
      cwd: "/project",
      stdin: Readable.from(["Prepare the agreed work."]),
      stdout,
      async fork(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: "fork",
          launchId: "launch-1",
          name: "Primary-1",
          role: "primary",
          phase: "fork_queued",
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    projectRoot: PROJECT_ROOT,
    name: "Primary-1",
    parentTaskId: "controller-1",
    role: "primary",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    serviceTier: null,
    assignment: "Prepare the agreed work.",
  }]);
});

test("rejects an incomplete model override before calling fork", async () => {
  for (const override of [
    ["--model", "gpt-5.6-sol"],
    ["--reasoning-effort", "medium"],
  ]) {
    const stdout = capture();
    let called = false;
    const exitCode = await runTaskCli(
      [
        "fork",
        "--name",
        "Builder-1",
        "--parent",
        "parent-1",
        "--role",
        "execute",
        ...override,
      ],
      {
        cwd: "/project",
        stdin: Readable.from(["Implement the requested change."]),
        stdout,
        async fork() {
          called = true;
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.equal(stdout.json().code, "TASK_EXECUTION_PROFILE_INCOMPLETE");
  }
});

test("resolves an explicit project root from the caller cwd", async () => {
  const stdout = capture();
  let received;
  const exitCode = await runTaskCli(
    [
      "launch",
      "--name",
      "Curie",
      "--parent",
      "parent-1",
      "--role",
      "primary",
      "--project-root",
      "../target",
    ],
    {
      cwd: "/workspace/current",
      stdin: Readable.from(["Implement the requested change."]),
      stdout,
      async launch(input) {
        received = input;
        return {
          run: "ok",
          operation: "launch",
          launchId: "launch-1",
          parentTaskId: input.parentTaskId,
          childTaskId: "child-1",
          phase: "ready",
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(received.projectRoot, TARGET_ROOT);
});

test("rejects invalid arguments before calling launch", async () => {
  const cases = [
    {
      argv: ["launch"],
      code: "PARENT_TASK_REQUIRED",
    },
    {
      argv: ["launch", "--parent", "contains whitespace"],
      code: "PARENT_TASK_INVALID",
    },
    {
      argv: ["launch", "--parent"],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: ["launch", "--parent", "parent-1", "--parent", "parent-2"],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: ["launch", "--parent", "parent-1"],
      code: "TASK_NAME_REQUIRED",
    },
    {
      argv: ["launch", "--name", "Curie", "--parent", "parent-1"],
      code: "TASK_ROLE_REQUIRED",
    },
    {
      argv: ["launch", "--name", "Curie", "--parent", "parent-1", "--role", "Bad Role"],
      code: "TASK_ROLE_INVALID",
    },
    {
      argv: ["launch", "--parent", "parent-1", "assignment"],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: [
        "launch",
        "--name",
        "Curie",
        "--parent",
        "parent-1",
        "--source",
        "execute-1",
        "--role",
        "primary",
      ],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: ["unknown", "--parent", "parent-1"],
      code: "TASK_COMMAND_INVALID",
    },
    {
      argv: [
        "launch",
        "--name",
        "Curie",
        "--parent",
        "parent-1",
        "--role",
        "primary",
        "--service-tier",
        "not valid",
      ],
      code: "TASK_SERVICE_TIER_INVALID",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
    let called = false;
    const exitCode = await runTaskCli(current.argv, {
      cwd: "/project",
      stdin: Readable.from(["assignment"]),
      stdout,
      async launch() {
        called = true;
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.equal(stdout.json().code, current.code);
  }
});

test("requires one non-empty assignment on stdin for launch and fork", async () => {
  for (const command of ["launch", "fork"]) {
    const stdout = capture();
    const exitCode = await runTaskCli(
      [
        command,
        "--name",
        "Curie",
        "--parent",
        "parent-1",
        "--role",
        "primary",
      ],
      {
        cwd: "/project",
        stdin: Readable.from([]),
        stdout,
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout.json().code, "TASK_ASSIGNMENT_REQUIRED");
  }
});

test("rejects TTY assignment input before creating a Task", async () => {
  for (const command of ["create", "fork"]) {
    const stdout = capture();
    const stdin = Readable.from(["Implement the requested change."]);
    stdin.isTTY = true;
    let called = false;
    const exitCode = await runTaskCli(
      [
        command,
        "--name",
        "Curie",
        "--parent",
        "parent-1",
        "--role",
        "primary",
      ],
      {
        cwd: "/project",
        stdin,
        stdout,
        async launch() {
          called = true;
        },
        async fork() {
          called = true;
        },
      },
    );

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.equal(
      stdout.json().code,
      "TASK_ASSIGNMENT_STDIN_TTY_UNSUPPORTED",
    );
  }
});

test("maps failed and partial launch errors to bounded safe JSON", async () => {
  for (const current of [
    {
      run: "failed",
      code: "PARENT_TASK_NOT_FOUND",
      exitCode: 1,
    },
    {
      run: "partial",
      code: "LAUNCH_REPAIR_REQUIRED",
      exitCode: 2,
    },
  ]) {
    const stdout = capture();
    const error = new TaskLaunchError(
      current.code,
      "x".repeat(2_000),
      {
        run: current.run,
        operation: "launch",
        launchId: "launch-1",
        parentTaskId: "parent-1",
        childTaskId: "child-1",
        roleTurnId: "role-turn-1",
        assignmentTurnId: "turn-1",
        phase: "assignment_started",
        cause: {
          code: "APP_SERVER_REQUEST_FAILED",
          secret: "must not escape",
        },
      },
    );
    const exitCode = await runTaskCli(
      ["launch", "--name", "Curie", "--parent", "parent-1", "--role", "primary"],
      {
        cwd: "/project",
        stdin: Readable.from(["Implement the requested change."]),
        stdout,
        async launch() {
          throw error;
        },
      },
    );

    const result = stdout.json();
    assert.equal(exitCode, current.exitCode);
    assert.equal(result.run, current.run);
    assert.equal(result.code, current.code);
    assert.equal(result.causeCode, "APP_SERVER_REQUEST_FAILED");
    assert.equal(result.message.length <= 512, true);
    assert.equal(JSON.stringify(result).includes("must not escape"), false);
    assert.deepEqual(Object.keys(result), [
      "run",
      "operation",
      "code",
      "causeCode",
      "message",
      "launchId",
      "parentTaskId",
      "childTaskId",
      "roleTurnId",
      "assignmentTurnId",
      "phase",
    ]);
  }
});

test("the executable emits one JSON error and exit status 1", () => {
  const script = fileURLToPath(new URL("../../commands/task.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "launch"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).code, "PARENT_TASK_REQUIRED");
});

test("runs stop and resume with explicit Task IDs", async () => {
  for (const operation of ["stop", "resume"]) {
    const stdout = capture();
    const calls = [];
    const supervisorRoots = [];
    const exitCode = await runTaskCli(
      [
        operation,
        "--task",
        "task-1",
        "--project-root",
        "../target",
      ],
      {
        cwd: "/workspace/current",
        stdout,
        async lifecycle(input) {
          calls.push(input);
          return {
            run: "ok",
            operation,
            operationId: `${operation}-operation`,
            taskId: input.taskId,
            changedLinks: 1,
            queuedActions: 1,
            deliveredActions: 1,
            pendingActions: 0,
            affectedTaskIds: ["task-1"],
            omitted: 0,
          };
        },
        startSupervisor(projectRoot) {
          supervisorRoots.push(projectRoot);
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [{
      operation,
      projectRoot: TARGET_ROOT,
      taskId: "task-1",
    }]);
    assert.equal(stdout.json().operation, operation);
    assert.deepEqual(
      supervisorRoots,
      operation === "resume" ? [TARGET_ROOT] : [],
    );
  }
});

test("reports committed create as partial when supervision cannot start", async () => {
  const stdout = capture();
  const exitCode = await runTaskCli(
    ["create", "--name", "Curie", "--parent", "parent-1", "--role", "primary"],
    {
      cwd: "/project",
      stdin: Readable.from(["Implement the requested change."]),
      stdout,
      async launch() {
        return {
          run: "ok",
          operation: "launch",
          launchId: "launch-1",
          parentTaskId: "parent-1",
          childTaskId: "child-1",
          phase: "ready",
        };
      },
      startSupervisor() {
        throw new Error("spawn unavailable");
      },
    },
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout.json(), {
    run: "partial",
    operation: "create",
    code: "RECOVERY_SUPERVISOR_START_FAILED",
    message: "Task create was committed, but recovery supervision did not start. Do not retry task create.",
    phase: "supervisor_start",
    launchId: "launch-1",
    childTaskId: "child-1",
    state: "ready",
    recommendedAction: "resume_child_task",
  });
});

test("reports committed resume as partial when supervisor startup fails", async () => {
  const stdout = capture();
  const exitCode = await runTaskCli(
    ["resume", "--task", "task-1"],
    {
      cwd: "/project",
      stdout,
      async lifecycle() {
        return {
          run: "ok",
          operation: "resume",
          operationId: "resume-operation",
          taskId: "task-1",
          changedLinks: 1,
          queuedActions: 1,
          deliveredActions: 1,
          pendingActions: 0,
          affectedTaskIds: ["task-1"],
          omitted: 0,
        };
      },
      startSupervisor() {
        throw Object.assign(new Error("spawn unavailable"), {
          code: "RECOVERY_SUPERVISOR_START_FAILED",
        });
      },
    },
  );

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout.json(), {
    run: "partial",
    operation: "resume",
    code: "RECOVERY_SUPERVISOR_START_FAILED",
    message: "Resume was committed, but recovery supervision did not start. Retry the same task resume command.",
    phase: "supervisor_start",
    operationId: "resume-operation",
    taskId: "task-1",
    state: "resumed",
    recommendedAction: "retry_resume",
  });
});

test("rejects invalid lifecycle arguments before execution", async () => {
  const cases = [
    {
      argv: ["accept", "--task", "task-1"],
      code: "TASK_COMMAND_INVALID",
    },
    {
      argv: ["stop", "--task", "contains whitespace"],
      code: "TASK_ID_INVALID",
    },
    {
      argv: ["resume", "--task"],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: ["resume", "--task", "task-1", "--task", "task-2"],
      code: "TASK_CLI_USAGE",
    },
    {
      argv: ["stop", "--parent", "task-1"],
      code: "TASK_CLI_USAGE",
    },
  ];

  for (const current of cases) {
    const stdout = capture();
    let called = false;
    const exitCode = await runTaskCli(current.argv, {
      cwd: "/project",
      stdout,
      async lifecycle() {
        called = true;
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(called, false);
    assert.equal(stdout.json().code, current.code);
  }
});

test("maps lifecycle partial results and errors to bounded CLI output", async () => {
  const partialOutput = capture();
  const partialExit = await runTaskCli(
    ["resume", "--task", "task-1"],
    {
      cwd: "/project",
      stdout: partialOutput,
      async lifecycle() {
        return {
          run: "partial",
          operation: "resume",
          operationId: "resume-operation",
          taskId: "task-1",
          changedLinks: 1,
          queuedActions: 1,
          deliveredActions: 0,
          pendingActions: 1,
          affectedTaskIds: ["task-1"],
          omitted: 0,
        };
      },
      async startSupervisor() {},
    },
  );

  assert.equal(partialExit, 2);
  assert.equal(partialOutput.json().run, "partial");

  const failedOutput = capture();
  const failedExit = await runTaskCli(
    ["stop", "--task", "task-1"],
    {
      cwd: "/project",
      stdout: failedOutput,
      async lifecycle() {
        throw Object.assign(new Error("x".repeat(2_000)), {
          code: "TASK_NOT_MANAGED",
          operation: "stop",
          taskId: "task-1",
          cause: { secret: "must not escape" },
        });
      },
    },
  );
  const failure = failedOutput.json();

  assert.equal(failedExit, 1);
  assert.equal(failure.run, "failed");
  assert.equal(failure.operation, "stop");
  assert.equal(failure.code, "TASK_NOT_MANAGED");
  assert.equal(failure.message.length <= 512, true);
  assert.equal(JSON.stringify(failure).includes("must not escape"), false);
});

test("the lifecycle executable requires an explicit Task ID", () => {
  const script = fileURLToPath(new URL("../../commands/task.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "stop"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).code, "TASK_ID_REQUIRED");
});

test("rejects the removed complete command instead of aliasing it to accept", async () => {
  const stdout = capture();
  const calls = [];
  const exitCode = await runTaskCli(
    ["complete", "--task", "task-1"],
    {
      cwd: "/project",
      stdout,
      async lifecycle(input) {
        calls.push(input);
        return {
          run: "ok",
          operation: input.operation,
          operationId: "accept-operation",
          taskId: input.taskId,
          changedLinks: 1,
          queuedActions: 1,
          deliveredActions: 1,
          pendingActions: 0,
          affectedTaskIds: ["task-1"],
          omitted: 0,
        };
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.equal(stdout.json().code, "TASK_COMMAND_INVALID");
});
