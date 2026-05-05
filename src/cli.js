const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageJson = require("../package.json");

const VERSION = packageJson.version;
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.join(ROOT_DIR, "bin", "cursor-agent-wakatime.js");
const HOOK_COMMAND_MARKER = "cursor-agent-wakatime";
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

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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

function resolveProjectRootRaw(startPath) {
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

function getPrimaryWorktreeRoot(projectRoot) {
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) {
    return projectRoot;
  }

  const firstWorktree = result.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "));
  const primaryRoot = firstWorktree ? firstWorktree.slice("worktree ".length).trim() : "";

  if (!primaryRoot || !fs.existsSync(primaryRoot)) {
    return projectRoot;
  }

  return path.resolve(primaryRoot);
}

function canonicalizeGitWorktreePath(filePath, projectRoot) {
  const resolvedPath = path.resolve(filePath);
  const primaryRoot = getPrimaryWorktreeRoot(projectRoot);

  if (primaryRoot === projectRoot || !resolvedPath.startsWith(`${projectRoot}${path.sep}`)) {
    return resolvedPath;
  }

  return path.join(primaryRoot, path.relative(projectRoot, resolvedPath));
}

function resolveProjectRoot(startPath) {
  const rawProjectRoot = resolveProjectRootRaw(startPath);
  return getPrimaryWorktreeRoot(rawProjectRoot);
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

  if (isWindowsAbsolutePath(cleaned) && process.platform !== "win32") {
    return path.normalize(cleaned);
  }

  const candidatePath = path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)
    ? path.normalize(cleaned)
    : path.normalize(path.join(cwd, cleaned));

  return canonicalizeGitWorktreePath(candidatePath, resolveProjectRootRaw(candidatePath));
}

function isInsideDir(filePath, dirPath) {
  const relativePath = path.relative(dirPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function filterTrackableFiles(files, cwd, logger = () => {}) {
  const projectRoot = resolveProjectRoot(cwd);

  return files.filter((file) => {
    if (!fs.existsSync(file.path)) {
      logger(`skipped missing extracted file path=${file.path}`);
      return false;
    }

    const stats = fs.statSync(file.path);

    if (!stats.isFile()) {
      logger(`skipped non-file extracted path=${file.path}`);
      return false;
    }

    if (!isInsideDir(file.path, projectRoot)) {
      logger(`skipped extracted file outside project path=${file.path}`);
      return false;
    }

    return true;
  });
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

function detectRuntime(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "darwin") {
    return "macos";
  }

  if (platform === "win32") {
    return "windows";
  }

  const isExplicitWsl = Object.prototype.hasOwnProperty.call(options, "isWsl")
    ? options.isWsl
    : process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP;

  if (platform === "linux" && isExplicitWsl) {
    return "wsl";
  }

  if (platform === "linux") {
    return "linux";
  }

  throw new Error("Unable to auto-detect supported runtime. Expected macOS, Linux, Windows, or WSL.");
}

function wslToUnc(posixPath, distro = process.env.WSL_DISTRO_NAME || "Ubuntu") {
  if (!posixPath || !posixPath.startsWith("/")) {
    return `\\\\wsl.localhost\\${distro}\\home`;
  }

  return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, "\\")}`;
}

function toHeartbeatPath(filePath, paths = getPaths()) {
  if (paths.runtime === "wsl" && filePath.startsWith("/")) {
    return wslToUnc(filePath, paths.distro);
  }

  return filePath;
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    encoding: "utf8",
    shell: process.platform !== "win32",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

function commandOrFileExists(command) {
  if (!command) {
    return false;
  }

  if (path.isAbsolute(command) || isWindowsAbsolutePath(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }

  return commandExists(command);
}

function findNativeWakatimeCli(homeDir, options = {}) {
  if (options.wakatimeCli) {
    return options.wakatimeCli;
  }

  if (process.env.WAKATIME_CLI_PATH) {
    return process.env.WAKATIME_CLI_PATH;
  }

  const platformName = process.platform === "darwin" ? "darwin" : process.platform;
  const archNames = process.arch === "x64" ? ["amd64", "x64"] : [process.arch];
  const candidates = [
    path.join(homeDir, ".wakatime", "wakatime-cli"),
    ...archNames.map((arch) => path.join(homeDir, ".wakatime", `wakatime-cli-${platformName}-${arch}`)),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));

  if (existing) {
    return existing;
  }

  return commandExists("wakatime-cli") ? "wakatime-cli" : candidates[0];
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

function resolveRuntimePaths(options = {}) {
  const runtime = detectRuntime(options);

  if (runtime === "macos" || runtime === "linux") {
    const homeDir = options.homeDir || os.homedir();
    const cursorHooks = options.cursorHooks || path.join(homeDir, ".cursor", "hooks.json");
    const cursorLog = options.cursorLog || path.join(homeDir, ".cursor", "cursor-agent-wakatime.log");

    return {
      runtime,
      homeDir,
      windowsHome: null,
      distro: null,
      wakatimeCli: findNativeWakatimeCli(homeDir, options),
      wakatimeConfig: options.wakatimeConfig || path.join(homeDir, ".wakatime.cfg"),
      wakatimeLog: options.wakatimeLog || path.join(homeDir, ".wakatime", "wakatime.log"),
      stateFile: options.stateFile || path.join(homeDir, ".wakatime", "cursor-agent-wakatime.json"),
      cursorHooks,
      cursorLog,
      cursorWslHooks: cursorHooks,
      cursorWslLog: cursorLog,
      cursorWindowsHooks: null,
      cursorWindowsLog: null,
    };
  }

  const windowsHome = options.windowsHome || findWindowsUserDir();

  if (!windowsHome) {
    throw new Error(`Unable to find the Windows user profile needed for the ${runtime} runtime.`);
  }

  const isWindowsRuntime = runtime === "windows";
  const homeDir = options.homeDir || os.homedir();
  const defaultWakatimeCli = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".wakatime", "wakatime-cli-windows-amd64.exe")
    : path.posix.join(windowsHome.wsl, ".wakatime", "wakatime-cli-windows-amd64.exe");
  const cursorHooks = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".cursor", "hooks.json")
    : path.posix.join(homeDir, ".cursor", "hooks.json");
  const cursorLog = isWindowsRuntime
    ? path.win32.join(windowsHome.win, ".cursor", "cursor-agent-wakatime.log")
    : path.posix.join(homeDir, ".cursor", "cursor-agent-wakatime.log");
  const cursorWindowsHooks = isWindowsRuntime
    ? null
    : path.posix.join(windowsHome.wsl, ".cursor", "hooks.json");
  const cursorWindowsLog = isWindowsRuntime
    ? null
    : path.posix.join(windowsHome.wsl, ".cursor", "cursor-agent-wakatime.log");

  return {
    runtime,
    homeDir,
    windowsHome,
    distro: options.distro || process.env.WSL_DISTRO_NAME || "Ubuntu",
    wakatimeCli: options.wakatimeCli || process.env.WAKATIME_CLI_PATH || defaultWakatimeCli,
    wakatimeConfig: options.wakatimeConfig || path.win32.join(windowsHome.win, ".wakatime.cfg"),
    wakatimeLog: options.wakatimeLog || path.win32.join(windowsHome.win, ".wakatime", "wakatime.log"),
    stateFile: options.stateFile || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", "cursor-agent-wakatime.json")
      : path.posix.join(windowsHome.wsl, ".wakatime", "cursor-agent-wakatime.json")),
    cursorHooks: options.cursorHooks || cursorHooks,
    cursorLog: options.cursorLog || cursorLog,
    cursorWslHooks: options.cursorHooks || cursorHooks,
    cursorWslLog: options.cursorLog || cursorLog,
    cursorWindowsHooks: options.cursorWindowsHooks || cursorWindowsHooks,
    cursorWindowsLog: options.cursorWindowsLog || cursorWindowsLog,
  };
}

function getPaths(options = {}) {
  return resolveRuntimePaths(options);
}

function logDebug(message, target) {
  const paths = getPaths();
  const logPath = target === "windows" ? paths.cursorWindowsLog || paths.cursorLog : paths.cursorLog;
  if (!logPath) {
    return;
  }
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function validateSetup(paths) {
  const failures = [];

  if (!commandOrFileExists(paths.wakatimeCli)) {
    failures.push(`missing WakaTime CLI: ${paths.wakatimeCli}`);
  }

  if (!fs.existsSync(paths.wakatimeConfig)) {
    failures.push(`missing WakaTime config: ${paths.wakatimeConfig}`);
  }

  if (failures.length > 0) {
    throw new Error(`Setup check failed for ${paths.runtime}:\n- ${failures.join("\n- ")}`);
  }
}

function getSetupChecks(paths) {
  return {
    cursorHooksExists: fs.existsSync(paths.cursorHooks),
    cursorWindowsHooksExists: paths.cursorWindowsHooks ? fs.existsSync(paths.cursorWindowsHooks) : null,
    wakatimeCliExists: commandOrFileExists(paths.wakatimeCli),
    wakatimeConfigExists: fs.existsSync(paths.wakatimeConfig),
  };
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

function isWsl() {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function buildWakatimeLaunch(wakatimeCli) {
  if (isWsl() && /\.exe$/i.test(wakatimeCli) && fs.existsSync("/init")) {
    return {
      command: "/init",
      argsPrefix: [wakatimeCli, "--"],
    };
  }

  return {
    command: wakatimeCli,
    argsPrefix: [],
  };
}

function sendHeartbeat(params, target) {
  const paths = getPaths();

  if (!commandOrFileExists(paths.wakatimeCli)) {
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

  const launch = buildWakatimeLaunch(paths.wakatimeCli);

  if (launch.command !== paths.wakatimeCli) {
    logDebug(`launching wakatime cli through ${launch.command}`, target);
  }

  const result = spawnSync(launch.command, [...launch.argsPrefix, ...args], {
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

function buildWindowsHookEntry(paths = getPaths()) {
  const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
  const scriptPath = paths.runtime === "wsl" ? toUncRepoPath(BIN_PATH) : BIN_PATH;

  return {
    command: `& "${windowsNode}" ${quoteWindowsShellArg(scriptPath)} hook-windows`,
    timeout: 30,
  };
}

function isOurWslHookEntry(entry) {
  return entry
    && typeof entry.command === "string"
    && entry.command.includes(HOOK_COMMAND_MARKER)
    && entry.command.includes("hook-wsl");
}

function isOurWindowsHookEntry(entry) {
  return entry
    && typeof entry.command === "string"
    && entry.command.includes(HOOK_COMMAND_MARKER)
    && entry.command.includes("hook-windows");
}

function parseOptions(args) {
  const options = {
    rest: [],
  };

  for (const arg of args) {
    if (arg === "--skip-checks") {
      options.skipChecks = true;
    } else {
      options.rest.push(arg);
    }
  }

  return options;
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
  const files = filterTrackableFiles(extractedFiles, cwd, (message) => logDebug(message, target));
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

function writeHookConfig(filePath, hookEntry, matcher) {
  const existing = readJsonSafe(filePath);
  const config = existing || { version: 1, hooks: {} };

  if (existing) {
    fs.writeFileSync(`${filePath}.bak`, `${JSON.stringify(existing, null, 2)}\n`);
  }

  const hooks = Array.isArray(config.hooks?.afterAgentResponse)
    ? config.hooks.afterAgentResponse.filter((entry) => !matcher(entry))
    : [];
  hooks.push(hookEntry);

  config.version = 1;
  config.hooks = {
    ...(config.hooks || {}),
    afterAgentResponse: hooks,
  };

  writeJson(filePath, config);
}

function removeHookConfig(filePath, matcher) {
  const existing = readJsonSafe(filePath);

  if (!existing?.hooks?.afterAgentResponse) {
    return false;
  }

  existing.hooks.afterAgentResponse = existing.hooks.afterAgentResponse.filter((entry) => !matcher(entry));
  writeJson(filePath, existing);
  return true;
}

function install(options = {}) {
  const paths = getPaths();

  if (!options.skipChecks) {
    validateSetup(paths);
  }

  if (paths.runtime === "windows") {
    writeHookConfig(paths.cursorHooks, buildWindowsHookEntry(paths), isOurWindowsHookEntry);
    console.log(`Installed Cursor hook at ${paths.cursorHooks}`);
    return;
  }

  writeHookConfig(paths.cursorHooks, buildWslHookEntry(), isOurWslHookEntry);

  if (paths.cursorWindowsHooks) {
    writeHookConfig(paths.cursorWindowsHooks, buildWindowsHookEntry(paths), isOurWindowsHookEntry);
    console.log(`Installed Cursor hooks at ${paths.cursorHooks} and ${paths.cursorWindowsHooks}`);
    return;
  }

  console.log(`Installed Cursor hook at ${paths.cursorHooks}`);
}

function uninstall() {
  const paths = getPaths();
  const primaryMatcher = paths.runtime === "windows" ? isOurWindowsHookEntry : isOurWslHookEntry;
  removeHookConfig(paths.cursorHooks, primaryMatcher);

  if (paths.cursorWindowsHooks) {
    removeHookConfig(paths.cursorWindowsHooks, isOurWindowsHookEntry);
    console.log(`Removed Cursor hook entries from ${paths.cursorHooks} and ${paths.cursorWindowsHooks}`);
    return;
  }

  console.log(`Removed Cursor hook entry from ${paths.cursorHooks}`);
}

function status() {
  const paths = getPaths();
  const primaryConfig = readJson(paths.cursorHooks);
  const windowsConfig = paths.cursorWindowsHooks ? readJson(paths.cursorWindowsHooks) : null;
  const primaryCommand = primaryConfig?.hooks?.afterAgentResponse?.[0]?.command || null;

  console.log(JSON.stringify({
    version: VERSION,
    runtime: paths.runtime,
    rootDir: ROOT_DIR,
    binPath: BIN_PATH,
    cursorHooks: paths.cursorHooks,
    cursorLog: paths.cursorLog,
    cursorWindowsHooks: paths.cursorWindowsHooks,
    cursorWindowsLog: paths.cursorWindowsLog,
    stateFile: paths.stateFile,
    wakatimeCli: paths.wakatimeCli,
    wakatimeConfig: paths.wakatimeConfig,
    checks: {
      ...getSetupChecks(paths),
    },
    installedCommand: primaryCommand,
    installedWslCommand: paths.runtime === "windows" ? null : primaryCommand,
    installedWindowsCommand: windowsConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
  }, null, 2));
}

function doctor() {
  const paths = getPaths();
  const checks = getSetupChecks(paths);

  console.log(JSON.stringify({
    runtime: paths.runtime,
    cursorHooks: paths.cursorHooks,
    cursorWindowsHooks: paths.cursorWindowsHooks,
    wakatimeCli: paths.wakatimeCli,
    wakatimeConfig: paths.wakatimeConfig,
    checks,
  }, null, 2));

  validateSetup(paths);
  console.log("Setup checks passed.");
}

function test(target) {
  const paths = getPaths();

  if (target === "windows" && !paths.windowsHome) {
    console.error("Windows Cursor/WakaTime paths are not available on this machine.");
    process.exit(1);
  }

  const cwd = target === "windows" ? "C:\\Users\\User\\projects\\cursor-agent-wakatime" : process.cwd();
  const projectRoot = resolveProjectRoot(cwd);
  const hookTarget = target === "windows" || paths.runtime === "windows" ? "windows" : "wsl";
  const result = sendProjectHeartbeat(cwd, hookTarget);

  console.log(JSON.stringify({
    ...result,
    project: basenameAny(projectRoot),
    projectRoot: paths.runtime === "wsl" && target !== "windows" ? toHeartbeatPath(projectRoot, paths) : projectRoot,
    cwd: paths.runtime === "wsl" && target !== "windows" ? toHeartbeatPath(cwd, paths) : cwd,
  }, null, 2));
  process.exit(result && result.ok ? 0 : 1);
}

async function run(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);

  switch (command) {
    case "hook-wsl":
      await runHook("wsl");
      return;
    case "hook-windows":
      await runHook("windows");
      return;
    case "install":
      install(options);
      return;
    case "uninstall":
      uninstall();
      return;
    case "status":
      status();
      return;
    case "doctor":
      doctor();
      return;
    case "test":
      test("local");
      return;
    case "test-wsl":
      test("wsl");
      return;
    case "test-windows":
      test("windows");
      return;
    default:
      console.log("Usage: cursor-agent-wakatime <install|uninstall|status|doctor|test|test-wsl|test-windows|hook-wsl|hook-windows> [--skip-checks]");
  }
}

module.exports = {
  run,
  getPaths,
  detectRuntime,
  resolveRuntimePaths,
  toHeartbeatPath,
  validateSetup,
  parseOptions,
  filterTrackableFiles,
  isOurWslHookEntry,
  isOurWindowsHookEntry,
};
