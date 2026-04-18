const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VERSION = "0.1.0";
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "cursor-agent-wakatime.js");
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const READ_TOOL_NAMES = new Set([
  "Grep",
  "Glob",
  "LS",
  "List",
  "Read",
  "Search",
]);
const WRITE_TOOL_NAMES = new Set([
  "Create",
  "Delete",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "StrReplace",
  "Write",
]);
const READ_PATTERNS = [
  /```\w*:([^\n`]+)/g,
  /`([^`\s]+\.\w{1,6})`/g,
  /["']([^"'\s]+\.\w{1,6})["']/g,
  /(?:Read|List)\s+`?([^\s`\n]+\.\w{1,6})`?/gi,
];
const WRITE_PATTERN = /(?:Create|Created|Modify|Modified|Update|Updated|Write|Wrote|Edit|Edited|Delete|Deleted)\s+`?([^\s`\n]+\.\w{1,6})`?/gi;

function quotePosixShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
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

function getParentDir(currentPath) {
  const parsed = path.parse(currentPath);

  if (currentPath === parsed.root) {
    return null;
  }

  return path.dirname(currentPath);
}

function hasGitMarker(dirPath) {
  return fs.existsSync(path.join(dirPath, ".git"));
}

function resolveProjectRoot(startPath) {
  if (!startPath) {
    return process.cwd();
  }

  let currentPath = path.resolve(startPath);

  if (!fs.existsSync(currentPath)) {
    currentPath = path.dirname(currentPath);
  } else if (!fs.statSync(currentPath).isDirectory()) {
    currentPath = path.dirname(currentPath);
  }

  while (currentPath) {
    if (hasGitMarker(currentPath)) {
      return currentPath;
    }

    currentPath = getParentDir(currentPath);
  }

  return path.resolve(startPath);
}

function isWindowsAbsolutePath(filePath) {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(filePath);
}

function isValidFilePath(filePath) {
  if (!filePath || filePath.length === 0) {
    return false;
  }

  if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.includes("://")) {
    return false;
  }

  if (/[<>|?*]/.test(filePath)) {
    return false;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (!ext || ext.length > 6) {
    return false;
  }

  return true;
}

function normalizePath(filePath, cwd) {
  const cleaned = filePath.trim();

  if (path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)) {
    return path.normalize(cleaned);
  }

  return path.normalize(path.join(cwd, cleaned));
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

  const usersRoot = process.platform === "win32" ? "C:\\Users" : "/mnt/c/Users";
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

  const candidates = fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredNames.has(entry.name))
    .map((entry) => {
      const win = process.platform === "win32"
        ? path.win32.join(usersRoot, entry.name)
        : `C:\\Users\\${entry.name}`;
      const wsl = process.platform === "win32"
        ? win
        : path.posix.join("/mnt/c/Users", entry.name);
      const profileRoot = process.platform === "win32" ? win : wsl;
      const score = Number(fs.existsSync(process.platform === "win32"
        ? path.win32.join(win, ".wakatime.cfg")
        : path.posix.join(wsl, ".wakatime.cfg")))
        + Number(fs.existsSync(process.platform === "win32"
          ? path.win32.join(win, ".wakatime", "wakatime-cli-windows-amd64.exe")
          : path.posix.join(wsl, ".wakatime", "wakatime-cli-windows-amd64.exe")))
        + Number(entry.name.toLowerCase() === "user")
        + Number(entry.name.toLowerCase() === String(process.env.USER || "").toLowerCase());

      return {
        win,
        wsl: process.platform === "win32" ? toWindowsWslPath(win) : wsl,
        profileRoot,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || left.profileRoot.localeCompare(right.profileRoot));

  if (candidates.length === 0) {
    return null;
  }

  return {
    win: candidates[0].win,
    wsl: candidates[0].wsl,
  };
}

function wslToUnc(posixPath) {
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";

  if (!posixPath || !posixPath.startsWith("/")) {
    return `\\\\wsl.localhost\\${distro}\\home`;
  }

  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

function toHeartbeatPath(filePath) {
  if (filePath.startsWith("/")) {
    return wslToUnc(filePath);
  }

  return filePath;
}

function extractFiles(message, cwd) {
  if (!message || message.length === 0) {
    return [];
  }

  const fileMap = new Map();
  WRITE_PATTERN.lastIndex = 0;

  for (const match of message.matchAll(WRITE_PATTERN)) {
    const filePath = match[1];

    if (filePath && isValidFilePath(filePath)) {
      const normalized = normalizePath(filePath, cwd);
      fileMap.set(normalized, true);
    }
  }

  for (const pattern of READ_PATTERNS) {
    pattern.lastIndex = 0;

    for (const match of message.matchAll(pattern)) {
      const filePath = match[1];

      if (filePath && isValidFilePath(filePath)) {
        const normalized = normalizePath(filePath, cwd);

        if (!fileMap.has(normalized)) {
          fileMap.set(normalized, false);
        }
      }
    }
  }

  return Array.from(fileMap.entries()).map(([filePath, isWrite]) => ({
    path: filePath,
    isWrite,
  }));
}

function mergeFileMapEntry(fileMap, filePath, isWrite, cwd) {
  if (!filePath || !isValidFilePath(filePath)) {
    return;
  }

  const normalized = normalizePath(String(filePath), cwd);
  const previous = fileMap.get(normalized) || false;
  fileMap.set(normalized, previous || isWrite);
}

function extractPathsFromToolInput(input) {
  if (!input || typeof input !== "object") {
    return [];
  }

  const values = [];

  for (const key of ["path", "file_path", "filePath", "target_file", "new_file_path"]) {
    if (typeof input[key] === "string" && input[key].length > 0) {
      values.push(input[key]);
    }
  }

  for (const key of ["paths", "files"]) {
    if (Array.isArray(input[key])) {
      for (const value of input[key]) {
        if (typeof value === "string" && value.length > 0) {
          values.push(value);
        }
      }
    }
  }

  return values;
}

function readJsonLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getLatestAssistantTurnEntries(entries) {
  const turnEntries = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry?.role === "user") {
      break;
    }

    if (entry?.role === "assistant") {
      turnEntries.unshift(entry);
    }
  }

  return turnEntries;
}

function extractFilesFromTranscript(transcriptPath, cwd) {
  const entries = readJsonLines(transcriptPath);

  if (entries.length === 0) {
    return [];
  }

  const fileMap = new Map();
  const turnEntries = getLatestAssistantTurnEntries(entries);

  for (const entry of turnEntries) {
    const content = entry?.message?.content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      if (item?.type !== "tool_use") {
        continue;
      }

      const toolName = String(item.name || "");
      const isWrite = WRITE_TOOL_NAMES.has(toolName);

      if (!isWrite && !READ_TOOL_NAMES.has(toolName)) {
        continue;
      }

      for (const filePath of extractPathsFromToolInput(item.input)) {
        mergeFileMapEntry(fileMap, filePath, isWrite, cwd);
      }
    }
  }

  return Array.from(fileMap.entries()).map(([filePath, isWrite]) => ({
    path: filePath,
    isWrite,
  }));
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
    stateFile: process.platform === "win32"
      ? path.win32.join(windowsHome.win, ".wakatime", "cursor-agent-wakatime.json")
      : path.posix.join(windowsHome.wsl, ".wakatime", "cursor-agent-wakatime.json"),
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

function readState() {
  const { stateFile } = getPaths();

  if (!fs.existsSync(stateFile)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const { stateFile } = getPaths();
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function shouldSendHeartbeat(signature, force = false) {
  if (force) {
    return true;
  }

  const state = readState();
  const lastHeartbeatAt = state.lastHeartbeatAt || 0;
  const lastSignature = state.lastSignature || "";
  const elapsed = Math.floor(Date.now() / 1000) - lastHeartbeatAt;

  if (elapsed >= 60) {
    return true;
  }

  return signature !== lastSignature;
}

function updateLastHeartbeat(signature) {
  writeState({
    lastHeartbeatAt: Math.floor(Date.now() / 1000),
    lastSignature: signature,
  });
}

function sendHeartbeat(params, target) {
  const paths = getPaths();

  if (!fs.existsSync(paths.wakatimeCli)) {
    logDebug(`missing wakatime cli at ${paths.wakatimeCli}`, target);
    return { ok: false, reason: "missing_wakatime_cli" };
  }

  const args = [
    "--entity",
    params.entity,
    "--entity-type",
    params.entityType,
    "--category",
    params.category || "ai coding",
    "--plugin",
    `cursor/1.0.0 cursor-agent-wakatime/${VERSION}`,
    "--config",
    paths.wakatimeConfig,
    "--log-file",
    paths.wakatimeLog,
    "--heartbeat-rate-limit-seconds",
    "60",
    "--timeout",
    "30",
  ];

  if (params.projectFolder) {
    args.push("--project-folder", params.projectFolder);
  }

  if (params.project) {
    args.push("--project", params.project);
  }

  if (params.isWrite) {
    args.push("--write");
  }

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

  logDebug(`heartbeat sent entity=${params.entity}`, target);
  return { ok: true, entity: params.entity };
}

function sendProjectHeartbeat(cwd, target) {
  const projectRoot = resolveProjectRoot(cwd);
  const heartbeatPath = toHeartbeatPath(projectRoot);
  const project = basenameAny(projectRoot);
  return sendHeartbeat({
    entity: heartbeatPath,
    entityType: "app",
    project,
  }, target);
}

function sendFileHeartbeats(files, cwd, target) {
  const projectRoot = resolveProjectRoot(cwd);
  const heartbeatProjectFolder = toHeartbeatPath(projectRoot);
  let sentCount = 0;

  for (const file of files) {
    const heartbeatPath = toHeartbeatPath(file.path);
    logDebug(`sending file heartbeat path=${heartbeatPath} isWrite=${file.isWrite}`, target);
    const result = sendHeartbeat({
      entity: heartbeatPath,
      entityType: "file",
      projectFolder: heartbeatProjectFolder,
      isWrite: file.isWrite,
    }, target);

    if (result.ok) {
      sentCount += 1;
    }
  }

  return sentCount > 0;
}

function buildSignature(files, cwd) {
  if (files.length === 0) {
    return `app:${cwd}`;
  }

  return files
    .map((file) => `${file.isWrite ? "w" : "r"}:${file.path}`)
    .sort()
    .join("|");
}

function buildWslHookEntry() {
  return {
    command: `node ${quotePosixShellArg(BIN_PATH)} hook-wsl`,
    timeout: 30,
  };
}

function buildWindowsHookEntry() {
  const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
  const uncBinPath = toUncRepoPath(BIN_PATH);

  return {
    command: `& "${windowsNode}" "${uncBinPath}" hook-windows`,
    timeout: 30,
  };
}

function isOurWslHookEntry(entry) {
  return entry && typeof entry.command === "string" && entry.command.includes(`${BIN_PATH} hook-wsl`);
}

function isOurWindowsHookEntry(entry) {
  return entry && typeof entry.command === "string" && entry.command.includes("cursor-agent-wakatime") && entry.command.includes("hook-windows");
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

  const workspaceRoot = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.find((root) => typeof root === "string" && root.length > 0) : null;
  const cwd = process.env.CURSOR_PROJECT_DIR || workspaceRoot || process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const transcriptFiles = extractFilesFromTranscript(payload.transcript_path, cwd);
  const extractedFiles = transcriptFiles.length > 0 ? transcriptFiles : extractFiles(text, cwd);
  const files = extractedFiles.filter((file) => {
    const exists = fs.existsSync(file.path);

    if (!exists) {
      logDebug(`skipped missing extracted file path=${file.path}`, target);
    }

    return exists;
  });
  const signature = buildSignature(files, cwd);

  if (!shouldSendHeartbeat(signature)) {
    logDebug("skipped heartbeat due to local rate limit", target);
    writeHookResponse();
    return;
  }

  if (target === "windows") {
    logDebug(`project root=${projectRoot} file source=${transcriptFiles.length > 0 ? "transcript" : "message"} extracted files=${files.length}`, target);
    let sent = false;

    if (files.length > 0) {
      sent = sendFileHeartbeats(files, cwd, target);
    } else {
      sent = sendProjectHeartbeat(cwd, target).ok;
    }

    writeHookResponse();
    if (sent) {
      updateLastHeartbeat(signature);
    }
    return;
  }

  logDebug(`project root=${projectRoot} file source=${transcriptFiles.length > 0 ? "transcript" : "message"} extracted files=${files.length}`, target);
  let sent = false;

  if (files.length > 0) {
    sent = sendFileHeartbeats(files, cwd, target);
  } else {
    sent = sendProjectHeartbeat(cwd, target).ok;
  }

  if (sent) {
    updateLastHeartbeat(signature);
  }
  writeHookResponse();
}

function buildWslHookConfig() {
  return {
    version: 1,
    hooks: {
      afterAgentResponse: [
        buildWslHookEntry(),
      ],
    },
  };
}

function buildWindowsHookConfig() {
  return {
    version: 1,
    hooks: {
      afterAgentResponse: [
        buildWindowsHookEntry(),
      ],
    },
  };
}

function install() {
  const paths = getPaths();
  const existingWsl = readJsonSafe(paths.cursorWslHooks);
  const existingWindows = readJsonSafe(paths.cursorWindowsHooks);
  const wslConfig = existingWsl || { version: 1, hooks: {} };
  const windowsConfig = existingWindows || { version: 1, hooks: {} };

  if (existingWsl) {
    fs.writeFileSync(`${paths.cursorWslHooks}.bak`, `${JSON.stringify(existingWsl, null, 2)}\n`);
  }

  if (existingWindows) {
    fs.writeFileSync(`${paths.cursorWindowsHooks}.bak`, `${JSON.stringify(existingWindows, null, 2)}\n`);
  }

  const wslHooks = Array.isArray(wslConfig.hooks?.afterAgentResponse) ? wslConfig.hooks.afterAgentResponse.filter((entry) => !isOurWslHookEntry(entry)) : [];
  const windowsHooks = Array.isArray(windowsConfig.hooks?.afterAgentResponse) ? windowsConfig.hooks.afterAgentResponse.filter((entry) => !isOurWindowsHookEntry(entry)) : [];

  wslHooks.push(buildWslHookEntry());
  windowsHooks.push(buildWindowsHookEntry());

  wslConfig.version = 1;
  wslConfig.hooks = {
    ...(wslConfig.hooks || {}),
    afterAgentResponse: wslHooks,
  };

  windowsConfig.version = 1;
  windowsConfig.hooks = {
    ...(windowsConfig.hooks || {}),
    afterAgentResponse: windowsHooks,
  };

  writeJson(paths.cursorWslHooks, wslConfig);
  writeJson(paths.cursorWindowsHooks, windowsConfig);
  console.log(`Installed Cursor hooks at ${paths.cursorWslHooks} and ${paths.cursorWindowsHooks}`);
}

function uninstall() {
  const paths = getPaths();
  const existingWsl = readJsonSafe(paths.cursorWslHooks);
  const existingWindows = readJsonSafe(paths.cursorWindowsHooks);

  if (existingWsl?.hooks?.afterAgentResponse) {
    const next = existingWsl.hooks.afterAgentResponse.filter((entry) => !isOurWslHookEntry(entry));
    existingWsl.hooks.afterAgentResponse = next;
    writeJson(paths.cursorWslHooks, existingWsl);
  }

  if (existingWindows?.hooks?.afterAgentResponse) {
    const next = existingWindows.hooks.afterAgentResponse.filter((entry) => !isOurWindowsHookEntry(entry));
    existingWindows.hooks.afterAgentResponse = next;
    writeJson(paths.cursorWindowsHooks, existingWindows);
  }

  console.log(`Removed Cursor hook entries from ${paths.cursorWslHooks} and ${paths.cursorWindowsHooks}`);
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
    stateFile: paths.stateFile,
    wakatimeCli: paths.wakatimeCli,
    installedWslCommand: wslConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
    installedWindowsCommand: windowsConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
  }, null, 2));
}

function test(target) {
  const cwd = target === "windows" ? "C:\\Users\\User\\projects\\cursor-agent-wakatime" : process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const result = sendProjectHeartbeat(cwd, target === "windows" ? "windows" : "wsl");

  console.log(JSON.stringify({
    ...result,
    project: basenameAny(projectRoot),
    projectRoot: target === "windows" ? projectRoot : wslToUnc(projectRoot),
    cwd: target === "windows" ? cwd : wslToUnc(cwd),
  }, null, 2));
  process.exit(result && result.ok ? 0 : 1);
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
    case "uninstall":
      uninstall();
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
      console.log("Usage: cursor-agent-wakatime <install|uninstall|status|test-wsl|test-windows|hook-wsl|hook-windows>");
  }
}

module.exports = {
  run,
};
