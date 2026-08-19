import {
  createDarwinCodexAppServerHostAdapter,
} from "./codex-app-server-host-darwin.mjs";
import {
  platformError,
} from "./codex-app-server-host-platform-shared.mjs";
import {
  createWin32CodexAppServerHostAdapter,
} from "./codex-app-server-host-win32.mjs";

export function createCodexAppServerHostPlatform({
  platform = process.platform,
  ...options
} = {}) {
  if (platform === "darwin") {
    return createDarwinCodexAppServerHostAdapter(options);
  }
  if (platform === "win32") {
    return createWin32CodexAppServerHostAdapter(options);
  }
  throw platformError(
    "APP_SERVER_HOST_PLATFORM_UNSUPPORTED",
    `Codex Small Loop has no app-server host transport for ${platform}.`,
  );
}
