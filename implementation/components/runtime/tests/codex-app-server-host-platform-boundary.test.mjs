import assert from "node:assert/strict";
import test from "node:test";

import {
  createDarwinCodexAppServerHostAdapter,
} from "../source/codex-app-server-host-darwin.mjs";
import {
  createWin32CodexAppServerHostAdapter,
} from "../source/codex-app-server-host-win32.mjs";

test("host transports expose explicit platform adapter boundaries", () => {
  const darwin = createDarwinCodexAppServerHostAdapter();
  const win32 = createWin32CodexAppServerHostAdapter();

  assert.equal(darwin.platform, "darwin");
  assert.equal(win32.platform, "win32");
});
