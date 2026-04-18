const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VERSION = "0.1.0";
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "cursor-agent-wakatime.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function basenameAny(value) {
  return String(value || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "project";
}

function toWindowsWslPath(windowsPath) {
  return windowsPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

function findWindowsUserDir() {
  const explicitWindowsHome = process.env.WAKATIME_WINDOWS_HOME || process.env.USERPROFILE;

  if (explicitWindowsHome && /^[A-Za-z]:\\/.test(explicitWindowsHome)) {
    const wslPath = toWindowsWslPath(explicitWindowsHome);
    const exists = process.platform === "win32" ? fs.existsSync(explicitWindowsHome) : fs.existsSync(wslPath);

    if (exists) {
      return {
        win: explicitWindowsHome,
        wsl: wslPath,
      };
    }
  }

  const defaultDir = process.platform === "win32" ? "C:\\Users\\User" : "/mnt/c/Users/User";

  if (fs.existsSync(defaultDir)) {
    return {
      win: "C:\\Users\\User",
      wsl: toWindowsWslPath("C:\\Users\\User"),
    };
  }

  if (process.platform === "win32") {
    return null;
  }

  const usersRoot = "/mnt/c/Users";
  const ignoredNames = new Set([
    "All Users",
    "Default",
    "Default User",
    "Public",
    "defaultuser0",
    "desktop.ini",
  ]);

  if (!fs.existsSync(usersRoot)) {
    return null;
  }

  const match = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))[0];

  if (!match) {
    return null;
  }

  return {
    win: `C:\\Users\\${match.name}`,
    wsl: path.posix.join(usersRoot, match.name),
  };
}

function wslToUnc(posixPath) {
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";

  if (!posixPath || !posixPath.startsWith("/")) {
    return `\\\\wsl.localhost\\${distro}\\home`;
  }

  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

function toUncRepoPath(posixPath) {
  return wslToUnc(posixPath);
}

function getPaths() {
  const windowsHome = findWindowsUserDir();
  const homeDir = process.env.HOME || os.homedir();

  if (!windowsHome) {
    throw new Error("Unable to find the Windows user profile needed for WakaTime.");
  }

  const wakatimeCli = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".wakatime", "wakatime-cli-windows-amd64.exe")
    : path.posix.join(windowsHome.wsl, ".wakatime", "wakatime-cli-windows-amd64.exe");

  const cursorWindowsHooks = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".cursor", "hooks.json")
    : path.posix.join(windowsHome.wsl, ".cursor", "hooks.json");

  const cursorWindowsLog = process.platform === "win32"
    ? path.win32.join(windowsHome.win, ".cursor", "cursor-agent-wakatime.log")
    : path.posix.join(windowsHome.wsl, ".cursor", "cursor-agent-wakatime.log");

  return {
    windowsHome,
    wakatimeCli,
    wakatimeConfig: `${windowsHome.win}\\.wakatime.cfg`,
    wakatimeLog: `${windowsHome.win}\\.wakatime\\wakatime.log`,
    cursorWslHooks: path.posix.join(homeDir, ".cursor", "hooks.json"),
    cursorWslLog: path.posix.join(homeDir, ".cursor", "cursor-agent-wakatime.log"),
    cursorWindowsHooks,
    cursorWindowsLog,
  };
}

function logDebug(message, target) {
  const paths = getPaths();
  const logPath = target === "windows" ? paths.cursorWindowsLog : paths.cursorWslLog;
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function writeHookResponse() {
  process.stdout.write("{}\n");
}

function sendHeartbeat(entityPath, target) {
  const paths = getPaths();
  const resolvedEntityPath = entityPath || process.cwd();
  const project = basenameAny(resolvedEntityPath);

  if (!fs.existsSync(paths.wakatimeCli)) {
    logDebug(`missing wakatime cli at ${paths.wakatimeCli}`, target);
    return { ok: false, reason: "missing_wakatime_cli" };
  }

  const args = [
    "--entity",
    resolvedEntityPath,
    "--entity-type",
    "app",
    "--category",
    "ai coding",
    "--plugin",
    `cursor/1.0.0 cursor-agent-wakatime/${VERSION}`,
    "--project",
    project,
    "--config",
    paths.wakatimeConfig,
    "--log-file",
    paths.wakatimeLog,
    "--heartbeat-rate-limit-seconds",
    "60",
    "--timeout",
    "30",
    "--sync-ai-disabled",
  ];

  const result = spawnSync(paths.wakatimeCli, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (result.error) {
    logDebug(`wakatime spawn error=${result.error.message}`, target);
    return { ok: false, reason: "spawn_error", error: result.error.message };
  }

  if (result.status !== 0) {
    logDebug(`wakatime failed status=${result.status} stderr=${(result.stderr || "").trim()}`, target);
    return { ok: false, reason: "non_zero_exit", status: result.status };
  }

  logDebug(`heartbeat sent cwd=${resolvedEntityPath}`, target);
  return { ok: true, project, cwd: resolvedEntityPath };
}

async function runHook(target) {
  const rawInput = await readStdin();
  logDebug(`received input bytes=${rawInput.length}`, target);

  if (!rawInput.trim()) {
    logDebug("skipped empty input", target);
    writeHookResponse();
    return;
  }

  let payload;

  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    logDebug(`invalid hook payload=${error.message}`, target);
    writeHookResponse();
    return;
  }

  const text = payload.text;

  if (!text || !String(text).trim()) {
    logDebug("skipped empty response text", target);
    writeHookResponse();
    return;
  }

  if (target === "windows") {
    sendHeartbeat(process.env.CURSOR_PROJECT_DIR || process.cwd(), target);
    writeHookResponse();
    return;
  }

  const cwd = process.env.CURSOR_PROJECT_DIR || process.cwd();
  sendHeartbeat(wslToUnc(cwd), target);
  writeHookResponse();
}

function buildWslHookConfig() {
  return {
    version: 1,
    hooks: {
      afterAgentResponse: [
        {
          command: `node ${BIN_PATH} hook-wsl`,
          timeout: 30,
        },
      ],
    },
  };
}

function buildWindowsHookConfig() {
  const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
  const uncBinPath = toUncRepoPath(BIN_PATH);

  return {
    version: 1,
    hooks: {
      afterAgentResponse: [
        {
          command: `& "${windowsNode}" "${uncBinPath}" hook-windows`,
          timeout: 30,
        },
      ],
    },
  };
}

function install() {
  const paths = getPaths();
  const existingWsl = readJson(paths.cursorWslHooks);
  const existingWindows = readJson(paths.cursorWindowsHooks);

  if (existingWsl) {
    fs.writeFileSync(`${paths.cursorWslHooks}.bak`, `${JSON.stringify(existingWsl, null, 2)}\n`);
  }

  if (existingWindows) {
    fs.writeFileSync(`${paths.cursorWindowsHooks}.bak`, `${JSON.stringify(existingWindows, null, 2)}\n`);
  }

  writeJson(paths.cursorWslHooks, buildWslHookConfig());
  writeJson(paths.cursorWindowsHooks, buildWindowsHookConfig());
  console.log(`Installed Cursor hooks at ${paths.cursorWslHooks} and ${paths.cursorWindowsHooks}`);
}

function status() {
  const paths = getPaths();
  const wslConfig = readJson(paths.cursorWslHooks);
  const windowsConfig = readJson(paths.cursorWindowsHooks);

  console.log(JSON.stringify({
    version: VERSION,
    rootDir: ROOT_DIR,
    binPath: BIN_PATH,
    cursorWslHooks: paths.cursorWslHooks,
    cursorWindowsHooks: paths.cursorWindowsHooks,
    cursorWslLog: paths.cursorWslLog,
    cursorWindowsLog: paths.cursorWindowsLog,
    wakatimeCli: paths.wakatimeCli,
    installedWslCommand: wslConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
    installedWindowsCommand: windowsConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
  }, null, 2));
}

function test(target) {
  const result = target === "windows"
    ? sendHeartbeat("C:\\Users\\User\\projects\\cursor-agent-wakatime", "windows")
    : sendHeartbeat(wslToUnc(process.cwd()), "wsl");

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

async function run(argv) {
  const [command] = argv;

  switch (command) {
    case "hook-wsl":
      await runHook("wsl");
      return;
    case "hook-windows":
      await runHook("windows");
      return;
    case "install":
      install();
      return;
    case "status":
      status();
      return;
    case "test-wsl":
      test("wsl");
      return;
    case "test-windows":
      test("windows");
      return;
    default:
      console.log("Usage: cursor-agent-wakatime <install|status|test-wsl|test-windows|hook-wsl|hook-windows>");
  }
}

module.exports = {
  run,
};
