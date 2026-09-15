import assert from "node:assert/strict";
import test from "node:test";

import {
  overrideTaskRunContext,
  taskRunContextFromSettings,
  threadSettingsFromTaskRunContext,
  turnSettingsFromTaskRunContext,
} from "../source/task-run-context.mjs";

const PROFILE_SETTINGS = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  serviceTier: "priority",
  approvalPolicy: "on-request",
  activePermissionProfile: {
    id: "project-maintainer",
    extends: ":workspace",
  },
  sandboxPolicy: { type: "workspaceWrite" },
});

test("normalizes a named permission profile as the active authority", () => {
  const context = taskRunContextFromSettings(PROFILE_SETTINGS);

  assert.deepEqual(context, {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    permission: {
      type: "profile",
      id: "project-maintainer",
    },
  });
  assert.deepEqual(turnSettingsFromTaskRunContext(context), {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    permissions: "project-maintainer",
  });
  assert.deepEqual(threadSettingsFromTaskRunContext(context), {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    permissions: "project-maintainer",
  });
});

test("normalizes a sandbox authority for turn and thread protocols", () => {
  const context = taskRunContextFromSettings({
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: null,
    approvalPolicy: "never",
    activePermissionProfile: null,
    sandboxPolicy: { type: "workspaceWrite" },
  });

  assert.deepEqual(turnSettingsFromTaskRunContext(context), {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: null,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
    },
  });
  assert.deepEqual(threadSettingsFromTaskRunContext(context), {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: null,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
});

test("execution overrides cannot change inherited authority", () => {
  const inherited = taskRunContextFromSettings(PROFILE_SETTINGS);
  const overridden = overrideTaskRunContext(inherited, {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: null,
  });

  assert.deepEqual(overridden, {
    ...inherited,
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: null,
  });
  assert.deepEqual(overridden.permission, inherited.permission);
  assert.deepEqual(overridden.approvalPolicy, inherited.approvalPolicy);
});

test("fails closed for missing or unrepresentable authority", () => {
  const base = {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    approvalPolicy: "on-request",
    activePermissionProfile: null,
  };

  assert.throws(
    () => taskRunContextFromSettings(base),
    /permission/i,
  );
  assert.throws(
    () => threadSettingsFromTaskRunContext(
      taskRunContextFromSettings({
        ...base,
        sandboxPolicy: { type: "externalSandbox" },
      }),
    ),
    /cannot be represented/i,
  );
  assert.throws(
    () => threadSettingsFromTaskRunContext(
      taskRunContextFromSettings({
        ...base,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/project"],
          customRestriction: true,
        },
      }),
    ),
    /Unsupported workspace sandbox details/i,
  );
});
