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
const DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK = 20;
const MAX_TRACKED_TURNS = 100;
const MAX_QUEUED_EDIT_EVENTS = MAX_TRACKED_TURNS * 20;
const DEFAULT_CONFIG = {
  debug: false,
  maxFileHeartbeats: DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK,
  canonicalWorktree: true,
};
const CONFIG_FILE_NAME = "cursor-agent-wakatime.config.json";
const WRITE_TOOL_NAMES = new Set([
  "Create",
  "Delete",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "StrReplace",
  "Write",
]);
const WRITE_TOOL_NAME_ALIASES = new Set([
  ...Array.from(WRITE_TOOL_NAMES, (name) => name.toLowerCase()),
  "edit_file",
  "multi_edit",
  "notebook_edit",
  "str_replace",
  "write_file",
  "delete_file",
]);
const KNOWN_EXTENSIONLESS_FILENAMES = new Set([
  ".dockerignore",
  ".env",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc",
  "dockerfile",
  "gemfile",
  "justfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);
let cachedConfig;
let activeOptions = {};

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
  if (readConfig().canonicalWorktree !== true) {
    return projectRoot;
  }

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

function canonicalizeGitWorktreePath(filePath, projectRoot, primaryRoot = getPrimaryWorktreeRoot(projectRoot)) {
  const resolvedPath = path.resolve(filePath);

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

function cleanupExtractedPath(filePath) {
  let cleaned = String(filePath || "").trim();

  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  return cleaned
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/[),.;]+$/, "");
}

function isValidFilePath(filePath) {
  const cleaned = cleanupExtractedPath(filePath);

  if (!cleaned || cleaned.length === 0) {
    return false;
  }

  if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.includes("://")) {
    return false;
  }

  if (/[<>"'`|?*\[\]]/.test(cleaned)) {
    return false;
  }

  const ext = path.extname(cleaned).slice(1).toLowerCase();
  const basename = basenameAny(cleaned).toLowerCase();

  if (!ext && !/[\\/]/.test(cleaned) && !KNOWN_EXTENSIONLESS_FILENAMES.has(basename)) {
    return false;
  }

  if (ext && (ext.length > 6 || /^\d+$/.test(ext))) {
    return false;
  }

  return true;
}

function normalizePath(filePath, cwd) {
  const cleaned = cleanupExtractedPath(filePath);

  if (isWindowsAbsolutePath(cleaned) && process.platform !== "win32") {
    return path.normalize(cleaned);
  }

  const candidatePath = path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)
    ? path.normalize(cleaned)
    : path.normalize(path.join(cwd, cleaned));

  return candidatePath;
}

function isInsideDir(filePath, dirPath) {
  const relativePath = path.relative(dirPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function filterTrackableFiles(files, cwd, logger = () => {}, projectRoot = resolveProjectRoot(cwd), rawProjectRoot = projectRoot) {

  return files.map((file) => {
    if (!fs.existsSync(file.path)) {
      logger(`skipped missing extracted file path=${file.path}`);
      return null;
    }

    const stats = fs.statSync(file.path);

    if (!stats.isFile()) {
      logger(`skipped non-file extracted path=${file.path}`);
      return null;
    }

    if (!isInsideDir(file.path, rawProjectRoot)) {
      logger(`skipped extracted file outside project path=${file.path}`);
      return null;
    }

    return {
      ...file,
      path: canonicalizeGitWorktreePath(file.path, rawProjectRoot, projectRoot),
    };
  }).filter(Boolean);
}

function toWindowsWslPath(windowsPath) {
  return windowsPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

function toReadableHostPath(filePath) {
  if (process.platform !== "win32" && isWindowsAbsolutePath(filePath)) {
    return toWindowsWslPath(filePath);
  }

  return filePath;
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

function findCommand(command) {
  if (!command) {
    return null;
  }

  const result = process.platform === "win32"
    ? spawnSync("where", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
    : spawnSync("/bin/sh", ["-c", "command -v \"$1\"", "sh", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

  if (result.status !== 0) {
    return null;
  }

  const resolved = result.stdout.trim().split(/\r?\n/)[0];
  return resolved || null;
}

function commandExists(command) {
  return Boolean(findCommand(command));
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

  const globalCandidates = [
    findCommand("wakatime-cli"),
    "/opt/homebrew/bin/wakatime-cli",
    "/usr/local/bin/wakatime-cli",
  ].filter(Boolean);
  const globalExisting = globalCandidates.find((candidate) => fs.existsSync(candidate));

  if (globalExisting) {
    return globalExisting;
  }

  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const platformName = platform === "darwin" ? "darwin" : platform;
  const archNames = arch === "x64" ? ["amd64", "x64"] : [arch];
  const localCandidates = [
    path.join(homeDir, ".wakatime", "wakatime-cli"),
    ...archNames.map((arch) => path.join(homeDir, ".wakatime", `wakatime-cli-${platformName}-${arch}`)),
  ];
  const localExisting = localCandidates.find((candidate) => fs.existsSync(candidate));

  return localExisting || localCandidates[0];
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

  for (const key of [
    "file",
    "file_path",
    "filePath",
    "new_file_path",
    "newFilePath",
    "old_file_path",
    "oldFilePath",
    "path",
    "target_file",
    "targetFile",
    "uri",
  ]) {
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

function isWriteToolName(toolName) {
  return WRITE_TOOL_NAME_ALIASES.has(String(toolName || "").toLowerCase());
}

function filesFromPathValues(values, cwd) {
  const fileMap = new Map();

  for (const filePath of values) {
    mergeFileMapEntry(fileMap, filePath, true, cwd);
  }

  return Array.from(fileMap.entries()).map(([filePath, isWrite]) => ({
    path: filePath,
    isWrite,
  }));
}

function extractEditedFilesFromHookPayload(payload, cwd) {
  const eventName = String(payload?.hook_event_name || "").toLowerCase();

  if (eventName === "afterfileedit") {
    return filesFromPathValues(extractPathsFromToolInput(payload), cwd);
  }

  if (eventName !== "posttooluse") {
    return [];
  }

  const toolName = payload.tool_name || payload.toolName || payload.name;

  if (!isWriteToolName(toolName)) {
    return [];
  }

  return filesFromPathValues([
    ...extractPathsFromToolInput(payload.tool_input),
    ...extractPathsFromToolInput(payload.toolInput),
    ...extractPathsFromToolInput(payload.input),
  ], cwd);
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
      configFile: options.configFile || path.join(homeDir, ".wakatime", CONFIG_FILE_NAME),
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
    configFile: options.configFile || (isWindowsRuntime
      ? path.win32.join(windowsHome.win, ".wakatime", CONFIG_FILE_NAME)
      : path.posix.join(homeDir, ".wakatime", CONFIG_FILE_NAME)),
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

function getConfigFilePath(options = {}) {
  if (options.configFile) {
    return options.configFile;
  }

  if (activeOptions.configFile) {
    return activeOptions.configFile;
  }

  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, ".wakatime", CONFIG_FILE_NAME);
}

function getStateFilePath(options = {}) {
  if (options.stateFile) {
    return options.stateFile;
  }

  if (activeOptions.stateFile) {
    return activeOptions.stateFile;
  }

  return getPaths(options).stateFile;
}

function readConfig(options = {}) {
  if (!options.configFile && cachedConfig) {
    return cachedConfig;
  }

  const config = readJsonSafe(toReadableHostPath(getConfigFilePath(options))) || {};
  const normalized = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  if (!options.configFile) {
    cachedConfig = normalized;
  }

  return normalized;
}

function ensureConfigFile(paths) {
  const readableConfigFile = toReadableHostPath(paths.configFile);

  if (!fs.existsSync(readableConfigFile)) {
    writeJson(readableConfigFile, DEFAULT_CONFIG);
  }
}

function isDebugEnabled() {
  return readConfig().debug === true;
}

function logDebug(message, target) {
  if (!isDebugEnabled()) {
    return;
  }

  const paths = getPaths();
  const logPath = target === "windows"
    ? activeOptions.cursorWindowsLog || activeOptions.cursorLog || paths.cursorWindowsLog || paths.cursorLog
    : activeOptions.cursorLog || paths.cursorLog;
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

  if (!fs.existsSync(toReadableHostPath(paths.wakatimeConfig))) {
    failures.push(`missing WakaTime config: ${paths.wakatimeConfig}`);
  }

  if (failures.length > 0) {
    throw new Error(`Setup check failed for ${paths.runtime}:\n- ${failures.join("\n- ")}`);
  }
}

function warnOnInvalidSetup(paths) {
  try {
    validateSetup(paths);
  } catch (error) {
    console.warn(`Warning: ${error.message}`);
    console.warn("Installed hooks anyway. Run `cursor-agent-wakatime doctor` for setup details.");
  }
}

function getSetupChecks(paths) {
  return {
    cursorHooksExists: fs.existsSync(paths.cursorHooks),
    cursorWindowsHooksExists: paths.cursorWindowsHooks ? fs.existsSync(paths.cursorWindowsHooks) : null,
    wakatimeCliExists: commandOrFileExists(paths.wakatimeCli),
    wakatimeConfigExists: fs.existsSync(toReadableHostPath(paths.wakatimeConfig)),
  };
}

function writeHookResponse() {
  process.stdout.write("{}\n");
}

function readState() {
  const stateFile = getStateFilePath();

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
  const stateFile = getStateFilePath();
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function shouldSendHeartbeat(signature, force = false, state = readState()) {
  if (force) {
    return true;
  }

  const lastHeartbeatAt = state.lastHeartbeatAt || 0;
  const lastSignature = state.lastSignature || "";
  const elapsed = Math.floor(Date.now() / 1000) - lastHeartbeatAt;

  if (elapsed >= 60) {
    return true;
  }

  return signature !== lastSignature;
}

function updateLastHeartbeat(signature, state = readState()) {
  writeState({
    ...state,
    lastHeartbeatAt: Math.floor(Date.now() / 1000),
    lastSignature: signature,
  });
}

function getTurnStateKeys(payload, cwd) {
  const conversationId = payload?.conversation_id || payload?.conversationId || payload?.session_id || payload?.sessionId;
  const generationId = payload?.generation_id || payload?.generationId || payload?.request_id || payload?.requestId;
  const keys = [];

  if (conversationId && generationId) {
    keys.push(`${conversationId}:${generationId}`);
  }

  if (conversationId) {
    keys.push(`${conversationId}:latest`);
  }

  if (generationId) {
    keys.push(`generation:${generationId}`);
  }

  keys.push(`cwd:${cwd}`);
  return Array.from(new Set(keys));
}

function mergeFiles(existingFiles, newFiles) {
  const fileMap = new Map();

  for (const file of [...existingFiles, ...newFiles]) {
    if (file?.path) {
      fileMap.set(file.path, {
        path: file.path,
        isWrite: Boolean(file.isWrite),
      });
    }
  }

  return Array.from(fileMap.values());
}

function getTurnFilesPath() {
  return path.join(path.dirname(getStateFilePath()), "cursor-agent-wakatime-turns", "events.jsonl");
}

function pruneQueuedTurnFiles() {
  const filePath = getTurnFilesPath();

  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length <= MAX_QUEUED_EDIT_EVENTS) {
    return;
  }

  fs.writeFileSync(filePath, `${lines.slice(-MAX_QUEUED_EDIT_EVENTS).join("\n")}\n`);
}

function appendTurnFiles(turnKeys, files) {
  if (turnKeys.length === 0 || files.length === 0) {
    return;
  }

  const filePath = getTurnFilesPath();
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify({
    updatedAt: Math.floor(Date.now() / 1000),
    keys: turnKeys,
    files,
  })}\n`);
}

function queuedEntryMatches(entry, turnKeySet) {
  return Array.isArray(entry.keys) && entry.keys.some((key) => turnKeySet.has(key));
}

function readQueuedTurnFiles(turnKeys) {
  if (turnKeys.length === 0) {
    return [];
  }

  const filePath = getTurnFilesPath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const turnKeySet = new Set(turnKeys);
  const files = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (queuedEntryMatches(entry, turnKeySet) && Array.isArray(entry.files)) {
        files.push(...entry.files);
      }
    } catch {
      // Ignore a partial line if a hook process was interrupted mid-write.
    }
  }

  return mergeFiles([], files);
}

function clearQueuedTurnFiles(turnKeys) {
  if (turnKeys.length === 0) {
    return;
  }

  const filePath = getTurnFilesPath();

  if (!fs.existsSync(filePath)) {
    return;
  }

  const turnKeySet = new Set(turnKeys);
  const retainedLines = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (!queuedEntryMatches(entry, turnKeySet)) {
        retainedLines.push(line);
      }
    } catch {
      retainedLines.push(line);
    }
  }

  if (retainedLines.length === 0) {
    fs.unlinkSync(filePath);
    return;
  }

  fs.writeFileSync(filePath, `${retainedLines.join("\n")}\n`);
}

function rememberTurnFiles(payload, files, cwd) {
  if (files.length === 0) {
    return;
  }

  appendTurnFiles(getTurnStateKeys(payload, cwd), files);
}

function readTurnFiles(payload, cwd, state = readState()) {
  pruneQueuedTurnFiles();

  const turnKeys = getTurnStateKeys(payload, cwd);
  const turnFiles = state.turnFiles && typeof state.turnFiles === "object" ? state.turnFiles : {};
  const stateFiles = turnKeys.flatMap((turnKey) => (
    Array.isArray(turnFiles[turnKey]?.files) ? turnFiles[turnKey].files : []
  ));

  return mergeFiles([], [...stateFiles, ...readQueuedTurnFiles(turnKeys)]);
}

function clearTurnFiles(payload, cwd) {
  const turnKeys = getTurnStateKeys(payload, cwd);
  clearQueuedTurnFiles(turnKeys);

  const state = readState();

  if (!state.turnFiles || typeof state.turnFiles !== "object") {
    return;
  }

  const turnFiles = { ...state.turnFiles };

  for (const turnKey of getTurnStateKeys(payload, cwd)) {
    delete turnFiles[turnKey];
  }

  writeState({
    ...state,
    turnFiles,
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

function sendProjectHeartbeat(cwd, target, projectRoot = resolveProjectRoot(cwd)) {
  const heartbeatPath = toHeartbeatPath(projectRoot);
  const project = basenameAny(projectRoot);
  return sendHeartbeat({
    entity: heartbeatPath,
    entityType: "app",
    project,
  }, target);
}

function getMaxFileHeartbeats() {
  const configuredLimit = Number(readConfig().maxFileHeartbeats);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : DEFAULT_MAX_FILE_HEARTBEATS_PER_HOOK;
}

function sendFileHeartbeats(files, cwd, target, projectRoot = resolveProjectRoot(cwd)) {
  const heartbeatProjectFolder = toHeartbeatPath(projectRoot);
  const filesToSend = files.slice(0, getMaxFileHeartbeats());
  let sentCount = 0;

  if (files.length > filesToSend.length) {
    logDebug(`limiting file heartbeats sent=${filesToSend.length} tracked=${files.length}`, target);
  }

  for (const file of filesToSend) {
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

function buildWslHookEntry(paths = getPaths()) {
  return {
    command: [
      "node",
      quotePosixShellArg(BIN_PATH),
      "hook-wsl",
      "--state-file",
      quotePosixShellArg(paths.stateFile),
      "--config-file",
      quotePosixShellArg(paths.configFile),
      "--cursor-log",
      quotePosixShellArg(paths.cursorLog),
    ].join(" "),
    timeout: 30,
  };
}

function getWindowsHookRuntimePaths(paths = getPaths()) {
  if (!paths.windowsHome?.win) {
    return {
      stateFile: paths.stateFile,
      configFile: paths.configFile,
      cursorLog: paths.cursorWindowsLog || paths.cursorLog,
    };
  }

  return {
    stateFile: path.win32.join(paths.windowsHome.win, ".wakatime", "cursor-agent-wakatime.json"),
    configFile: path.win32.join(paths.windowsHome.win, ".wakatime", CONFIG_FILE_NAME),
    cursorLog: path.win32.join(paths.windowsHome.win, ".cursor", "cursor-agent-wakatime.log"),
  };
}

function buildWindowsHookEntry(paths = getPaths()) {
  const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
  const scriptPath = paths.runtime === "wsl" ? toUncRepoPath(BIN_PATH) : BIN_PATH;
  const runtimePaths = getWindowsHookRuntimePaths(paths);

  return {
    command: [
      `& "${windowsNode}"`,
      quoteWindowsShellArg(scriptPath),
      "hook-windows",
      "--state-file",
      quoteWindowsShellArg(runtimePaths.stateFile),
      "--config-file",
      quoteWindowsShellArg(runtimePaths.configFile),
      "--cursor-windows-log",
      quoteWindowsShellArg(runtimePaths.cursorLog),
    ].join(" "),
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

function removeOurHookEntries(entries = [], matcher) {
  return Array.isArray(entries) ? entries.filter((entry) => !matcher(entry)) : [];
}

function parseOptions(args) {
  const options = {
    rest: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--skip-checks") {
      options.skipChecks = true;
    } else if (arg === "--state-file") {
      options.stateFile = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--state-file=")) {
      options.stateFile = arg.slice("--state-file=".length);
    } else if (arg === "--config-file") {
      options.configFile = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--config-file=")) {
      options.configFile = arg.slice("--config-file=".length);
    } else if (arg === "--cursor-log") {
      options.cursorLog = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--cursor-log=")) {
      options.cursorLog = arg.slice("--cursor-log=".length);
    } else if (arg === "--cursor-windows-log") {
      options.cursorWindowsLog = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--cursor-windows-log=")) {
      options.cursorWindowsLog = arg.slice("--cursor-windows-log=".length);
    } else {
      options.rest.push(arg);
    }
  }

  return options;
}

async function runHook(target, options = {}) {
  activeOptions = options;
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

  const workspaceRoot = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.find((root) => typeof root === "string" && root.length > 0) : null;
  const cwd = process.env.CURSOR_PROJECT_DIR || payload.cwd || workspaceRoot || process.cwd();
  const eventName = String(payload.hook_event_name || "").toLowerCase();

  if (eventName === "afterfileedit" || eventName === "posttooluse") {
    const files = extractEditedFilesFromHookPayload(payload, cwd);

    if (files.length > 0) {
      rememberTurnFiles(payload, files, cwd);
    }

    logDebug(`recorded edit event=${eventName} files=${files.length}`, target);
    writeHookResponse();
    return;
  }

  if (eventName && eventName !== "afteragentresponse" && eventName !== "stop") {
    logDebug(`skipped unsupported hook event=${eventName}`, target);
    writeHookResponse();
    return;
  }

  const state = readState();
  const rawProjectRoot = resolveProjectRootRaw(cwd);
  const projectRoot = getPrimaryWorktreeRoot(rawProjectRoot);
  const files = filterTrackableFiles(readTurnFiles(payload, cwd, state), cwd, (message) => logDebug(message, target), projectRoot, rawProjectRoot);
  const signature = buildSignature(files, cwd);

  if (!shouldSendHeartbeat(signature, false, state)) {
    logDebug("skipped heartbeat due to local rate limit", target);
    clearTurnFiles(payload, cwd);
    writeHookResponse();
    return;
  }

  if (target === "windows") {
    logDebug(`project root=${projectRoot} tracked edited files=${files.length}`, target);
    let sent = false;

    if (files.length > 0) {
      sent = sendFileHeartbeats(files, cwd, target, projectRoot);
    } else {
      sent = sendProjectHeartbeat(cwd, target, projectRoot).ok;
    }

    writeHookResponse();
    if (sent) {
      updateLastHeartbeat(signature, state);
    }
    clearTurnFiles(payload, cwd);
    return;
  }

  logDebug(`project root=${projectRoot} tracked edited files=${files.length}`, target);
  let sent = false;

  if (files.length > 0) {
    sent = sendFileHeartbeats(files, cwd, target, projectRoot);
  } else {
    sent = sendProjectHeartbeat(cwd, target, projectRoot).ok;
  }

  if (sent) {
    updateLastHeartbeat(signature, state);
  }
  clearTurnFiles(payload, cwd);
  writeHookResponse();
}

function writeHookConfig(filePath, hookEntry, matcher) {
  const existing = readJsonSafe(filePath);
  const config = existing || { version: 1, hooks: {} };

  if (existing) {
    fs.writeFileSync(`${filePath}.bak`, `${JSON.stringify(existing, null, 2)}\n`);
  }

  const nextHooks = { ...(config.hooks || {}) };

  for (const eventName of ["afterAgentResponse", "afterFileEdit", "postToolUse"]) {
    nextHooks[eventName] = removeOurHookEntries(nextHooks[eventName], matcher);
  }

  nextHooks.afterAgentResponse = [
    ...(nextHooks.afterAgentResponse || []),
    hookEntry,
  ];
  nextHooks.afterFileEdit = [
    ...(nextHooks.afterFileEdit || []),
    hookEntry,
  ];
  nextHooks.postToolUse = [
    ...(nextHooks.postToolUse || []),
    hookEntry,
  ];

  config.version = 1;
  config.hooks = nextHooks;

  writeJson(filePath, config);
}

function removeHookConfig(filePath, matcher) {
  const existing = readJsonSafe(filePath);

  if (!existing?.hooks) {
    return false;
  }

  let changed = false;

  for (const eventName of ["afterAgentResponse", "afterFileEdit", "postToolUse"]) {
    if (!Array.isArray(existing.hooks[eventName])) {
      continue;
    }

    const filtered = existing.hooks[eventName].filter((entry) => !matcher(entry));
    changed ||= filtered.length !== existing.hooks[eventName].length;

    if (filtered.length > 0) {
      existing.hooks[eventName] = filtered;
    } else {
      delete existing.hooks[eventName];
    }
  }

  if (!changed) {
    return false;
  }

  writeJson(filePath, existing);
  return true;
}

function ensureWindowsConfigFile(paths) {
  if (!paths.windowsHome?.wsl || !paths.cursorWindowsHooks) {
    return;
  }

  const configFile = path.posix.join(paths.windowsHome.wsl, ".wakatime", CONFIG_FILE_NAME);

  if (!fs.existsSync(configFile)) {
    writeJson(configFile, DEFAULT_CONFIG);
  }
}

function install(options = {}) {
  const paths = getPaths(options);
  ensureConfigFile(paths);
  ensureWindowsConfigFile(paths);

  if (!options.skipChecks) {
    warnOnInvalidSetup(paths);
  }

  if (paths.runtime === "windows") {
    writeHookConfig(paths.cursorHooks, buildWindowsHookEntry(paths), isOurWindowsHookEntry);
    console.log(`Installed Cursor hook at ${paths.cursorHooks}`);
    return;
  }

  writeHookConfig(paths.cursorHooks, buildWslHookEntry(paths), isOurWslHookEntry);

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

function status(options = {}) {
  const paths = getPaths(options);
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
    configFile: paths.configFile,
    config: readConfig({ configFile: paths.configFile }),
    wakatimeCli: paths.wakatimeCli,
    wakatimeConfig: paths.wakatimeConfig,
    checks: {
      ...getSetupChecks(paths),
    },
    installedCommand: primaryCommand,
    installedWslCommand: paths.runtime === "windows" ? null : primaryCommand,
    installedWindowsCommand: windowsConfig?.hooks?.afterAgentResponse?.[0]?.command || null,
    installedAfterFileEditCommand: primaryConfig?.hooks?.afterFileEdit?.[0]?.command || null,
    installedPostToolUseCommand: primaryConfig?.hooks?.postToolUse?.[0]?.command || null,
  }, null, 2));
}

function doctor(options = {}) {
  const paths = getPaths(options);
  const checks = getSetupChecks(paths);

  console.log(JSON.stringify({
    runtime: paths.runtime,
    cursorHooks: paths.cursorHooks,
    cursorWindowsHooks: paths.cursorWindowsHooks,
    wakatimeCli: paths.wakatimeCli,
    wakatimeConfig: paths.wakatimeConfig,
    configFile: paths.configFile,
    config: readConfig({ configFile: paths.configFile }),
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
      await runHook("wsl", options);
      return;
    case "hook-windows":
      await runHook("windows", options);
      return;
    case "install":
      install(options);
      return;
    case "uninstall":
      uninstall();
      return;
    case "status":
      status(options);
      return;
    case "doctor":
      doctor(options);
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
  warnOnInvalidSetup,
  install,
  parseOptions,
  toReadableHostPath,
  filterTrackableFiles,
  isOurWslHookEntry,
  isOurWindowsHookEntry,
  extractEditedFilesFromHookPayload,
};
