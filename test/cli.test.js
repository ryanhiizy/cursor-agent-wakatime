const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../src/cli");

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

test("getPaths accepts WAKATIME_CLI_PATH override", () => {
  const previous = process.env.WAKATIME_CLI_PATH;
  process.env.WAKATIME_CLI_PATH = "/custom/wakatime-cli";

  try {
    assert.equal(cli.getPaths().wakatimeCli, "/custom/wakatime-cli");
  } finally {
    if (previous === undefined) {
      delete process.env.WAKATIME_CLI_PATH;
    } else {
      process.env.WAKATIME_CLI_PATH = previous;
    }
  }
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
