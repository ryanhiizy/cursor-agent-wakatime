const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");

test("runtime detection covers macos, linux, windows, and wsl", () => {
  assert.equal(cli.detectRuntime({ platform: "darwin" }), "macos");
  assert.equal(cli.detectRuntime({ platform: "linux", isWsl: false }), "linux");
  assert.equal(cli.detectRuntime({ platform: "linux", isWsl: true }), "wsl");
  assert.equal(cli.detectRuntime({ platform: "win32" }), "windows");
});

test("macos runtime uses native Cursor and WakaTime paths", () => {
  const home = path.join(os.tmpdir(), "cursor-wakatime-mac-home");
  const paths = cli.resolveRuntimePaths({
    platform: "darwin",
    homeDir: home,
  });

  assert.equal(paths.runtime, "macos");
  assert.equal(paths.cursorHooks, path.join(home, ".cursor", "hooks.json"));
  assert.equal(paths.cursorWindowsHooks, null);
  assert.equal(paths.wakatimeCli, path.join(home, ".wakatime", "wakatime-cli"));
  assert.equal(paths.wakatimeConfig, path.join(home, ".wakatime.cfg"));
  assert.equal(cli.toHeartbeatPath("/Users/example/project/app.js", paths), "/Users/example/project/app.js");
});

test("native linux runtime uses native Cursor and WakaTime paths", () => {
  const home = path.join(os.tmpdir(), "cursor-wakatime-linux-home");
  const paths = cli.resolveRuntimePaths({
    platform: "linux",
    isWsl: false,
    homeDir: home,
  });

  assert.equal(paths.runtime, "linux");
  assert.equal(paths.cursorHooks, path.join(home, ".cursor", "hooks.json"));
  assert.equal(paths.cursorWindowsHooks, null);
  assert.equal(paths.wakatimeConfig, path.join(home, ".wakatime.cfg"));
});

test("wsl runtime keeps Windows WakaTime paths and installs both Cursor hook files", () => {
  const home = path.join(os.tmpdir(), "cursor-wakatime-wsl-home");
  const paths = cli.resolveRuntimePaths({
    platform: "linux",
    isWsl: true,
    homeDir: home,
    windowsHome: {
      win: "C:\\Users\\User",
      wsl: "/mnt/c/Users/User",
    },
    distro: "Ubuntu",
  });

  assert.equal(paths.runtime, "wsl");
  assert.equal(paths.cursorHooks, path.join(home, ".cursor", "hooks.json"));
  assert.equal(paths.cursorWindowsHooks, "/mnt/c/Users/User/.cursor/hooks.json");
  assert.equal(paths.wakatimeCli, "/mnt/c/Users/User/.wakatime/wakatime-cli-windows-amd64.exe");
  assert.equal(paths.wakatimeConfig, "C:\\Users\\User\\.wakatime.cfg");
  assert.equal(cli.toHeartbeatPath("/home/user/project/app.js", paths), "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\app.js");
});

test("wsl setup checks read Windows config through the mounted host path", () => {
  assert.equal(cli.toReadableHostPath("C:\\Users\\User\\.wakatime.cfg"), "/mnt/c/Users/User/.wakatime.cfg");
});

test("windows runtime uses native Windows paths and hook shape", () => {
  const paths = cli.resolveRuntimePaths({
    platform: "win32",
    windowsHome: {
      win: "C:\\Users\\User",
      wsl: "/mnt/c/Users/User",
    },
  });

  assert.equal(paths.runtime, "windows");
  assert.equal(paths.cursorHooks, "C:\\Users\\User\\.cursor\\hooks.json");
  assert.equal(paths.cursorWindowsHooks, null);
  assert.equal(paths.wakatimeCli, "C:\\Users\\User\\.wakatime\\wakatime-cli-windows-amd64.exe");
  assert.equal(paths.wakatimeConfig, "C:\\Users\\User\\.wakatime.cfg");
});

test("hook matching replaces old installs from different package paths", () => {
  assert.equal(cli.isOurWslHookEntry({
    command: "node '/tmp/local/cursor-agent-wakatime/bin/cursor-agent-wakatime.js' hook-wsl",
  }), true);
  assert.equal(cli.isOurWslHookEntry({
    command: "node '/usr/local/lib/node_modules/cursor-agent-wakatime/bin/cursor-agent-wakatime.js' hook-wsl",
  }), true);
  assert.equal(cli.isOurWindowsHookEntry({
    command: '& "C:\\Program Files\\nodejs\\node.exe" "\\\\wsl.localhost\\Ubuntu\\repo\\cursor-agent-wakatime\\bin\\cursor-agent-wakatime.js" hook-windows',
  }), true);
  assert.equal(cli.isOurWslHookEntry({
    command: "node '/tmp/other-tool/bin/other-tool.js' hook-wsl",
  }), false);
});

test("wsl runtime accepts WAKATIME_CLI_PATH override", () => {
  const previous = process.env.WAKATIME_CLI_PATH;
  process.env.WAKATIME_CLI_PATH = "/custom/wakatime-cli";

  try {
    const paths = cli.resolveRuntimePaths({
      platform: "linux",
      isWsl: true,
      windowsHome: {
        win: "C:\\Users\\User",
        wsl: "/mnt/c/Users/User",
      },
    });

    assert.equal(paths.wakatimeCli, "/custom/wakatime-cli");
  } finally {
    if (previous === undefined) {
      delete process.env.WAKATIME_CLI_PATH;
    } else {
      process.env.WAKATIME_CLI_PATH = previous;
    }
  }
});

test("parseOptions keeps command flags out of positional arguments", () => {
  const options = cli.parseOptions(["--skip-checks", "extra"]);

  assert.equal(options.skipChecks, true);
  assert.deepEqual(options.rest, ["extra"]);
});

test("filterTrackableFiles keeps only existing files inside the project", () => {
  const cwd = path.join(os.tmpdir(), "cursor-wakatime-filter-project");
  const sourceFile = path.join(cwd, "src", "cli.js");
  const nestedDir = path.join(cwd, "src", "folder.js");
  const outsideFile = path.join(os.tmpdir(), "cursor-wakatime-outside.js");

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(sourceFile, "");
  fs.writeFileSync(outsideFile, "");

  const files = cli.filterTrackableFiles([
    { path: sourceFile, isWrite: true },
    { path: nestedDir, isWrite: true },
    { path: outsideFile, isWrite: false },
    { path: path.join(cwd, "missing.js"), isWrite: false },
  ], cwd);

  assert.deepEqual(files, [
    { path: sourceFile, isWrite: true },
  ]);
});

test("extractEditedFilesFromHookPayload captures afterFileEdit paths", () => {
  const cwd = path.join(os.tmpdir(), "cursor-wakatime-after-file-edit-project");
  const sourceFile = path.join(cwd, "src", "cli.js");

  assert.deepEqual(cli.extractEditedFilesFromHookPayload({
    hook_event_name: "afterFileEdit",
    file_path: "src/cli.js",
  }, cwd), [
    { path: sourceFile, isWrite: true },
  ]);
});

test("extractEditedFilesFromHookPayload only accepts write postToolUse tools", () => {
  const cwd = path.join(os.tmpdir(), "cursor-wakatime-post-tool-use-project");
  const sourceFile = path.join(cwd, "src", "cli.js");

  assert.deepEqual(cli.extractEditedFilesFromHookPayload({
    hook_event_name: "postToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "src/cli.js" },
  }, cwd), [
    { path: sourceFile, isWrite: true },
  ]);

  assert.deepEqual(cli.extractEditedFilesFromHookPayload({
    hook_event_name: "postToolUse",
    tool_name: "Read",
    tool_input: { file_path: "src/cli.js" },
  }, cwd), []);
});

test("install writes response and structured edit hooks", () => {
  const home = path.join(os.tmpdir(), "cursor-wakatime-install-home");
  const wakatimeCli = path.join(home, ".wakatime", "wakatime-cli");
  const wakatimeConfig = path.join(home, ".wakatime.cfg");
  const cursorHooks = path.join(home, ".cursor", "hooks.json");

  fs.mkdirSync(path.dirname(wakatimeCli), { recursive: true });
  fs.writeFileSync(wakatimeCli, "");
  fs.writeFileSync(wakatimeConfig, "");

  const originalLog = console.log;
  console.log = () => {};

  try {
    cli.install({
      homeDir: home,
      cursorHooks,
      wakatimeCli,
      wakatimeConfig,
      platform: "darwin",
    });
  } finally {
    console.log = originalLog;
  }

  const hooks = JSON.parse(fs.readFileSync(cursorHooks, "utf8")).hooks;

  assert.equal(hooks.afterAgentResponse.length, 1);
  assert.equal(hooks.afterFileEdit.length, 1);
  assert.equal(hooks.postToolUse.length, 1);
  assert.equal(cli.isOurWslHookEntry(hooks.afterAgentResponse[0]), true);
});

test("install writes hooks even when setup validation warns", () => {
  const home = path.join(os.tmpdir(), "cursor-wakatime-install-warning-home");
  const cursorHooks = path.join(home, ".cursor", "hooks.json");
  const originalLog = console.log;
  const originalWarn = console.warn;
  const warnings = [];

  console.log = () => {};
  console.warn = (message) => warnings.push(message);

  try {
    cli.install({
      homeDir: home,
      cursorHooks,
      wakatimeCli: path.join(home, ".wakatime", "missing-cli"),
      wakatimeConfig: path.join(home, ".wakatime.cfg"),
      platform: "darwin",
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const hooks = JSON.parse(fs.readFileSync(cursorHooks, "utf8")).hooks;

  assert.match(warnings.join("\n"), /Setup check failed/);
  assert.equal(hooks.afterAgentResponse.length, 1);
  assert.equal(hooks.afterFileEdit.length, 1);
  assert.equal(hooks.postToolUse.length, 1);
});
