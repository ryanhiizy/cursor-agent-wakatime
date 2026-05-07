# cursor-agent-wakatime

WakaTime heartbeats for Cursor Agent.

> This package tracks Cursor Agent activity through Cursor hooks. It is not a replacement for the official WakaTime editor plugin for normal typing/editing time.

## What It Does

- Installs Cursor `afterAgentResponse`, `afterFileEdit`, and `postToolUse` hooks.
- Records files edited by Cursor Agent file-edit and write-tool events during a turn.
- Sends a WakaTime heartbeat after completed Cursor Agent responses.
- Attributes activity to the edited files when Cursor exposes them through hook payloads.
- Falls back to project-level app activity when no file path is available.

> All Cursor Agent activity is tracked. When there is no detected file edit, WakaTime may show that activity as project-level `Other` time.

## Prerequisites

- Node.js 18 or newer.
- Cursor with hook support.
- WakaTime installed and configured before installing this package.
- A working WakaTime config at `~/.wakatime.cfg` or `C:\Users\<user>\.wakatime.cfg`.

WakaTime CLI lookup:

| Environment | CLI path |
| --- | --- |
| Windows + WSL | `WAKATIME_CLI_PATH` or `/mnt/c/Users/<user>/.wakatime/wakatime-cli-windows-amd64.exe` |
| macOS/native Linux | `WAKATIME_CLI_PATH`, `~/.wakatime/wakatime-cli`, `~/.wakatime/wakatime-cli-<platform>-<arch>`, or `wakatime-cli` on `PATH` |

> For Cursor installed on Windows but working on a project inside WSL, install and configure WakaTime on Windows. The hook runs from WSL but sends heartbeats through the Windows WakaTime CLI.

## Install

```bash
npm install -g cursor-agent-wakatime
cursor-agent-wakatime install
```

Restart Cursor after installing or changing hooks.

### Existing Hooks

Install keeps existing hooks from other tools, replaces any previous `cursor-agent-wakatime` entry, and backs up previous hook files to `hooks.json.bak`. On Windows + WSL, it installs both WSL and Windows Cursor hooks.

## Commands

| Command | Purpose |
| --- | --- |
| `cursor-agent-wakatime install` | Add Cursor `afterAgentResponse`, `afterFileEdit`, and `postToolUse` hooks. |
| `cursor-agent-wakatime uninstall` | Remove only this package's Cursor hook entries. |
| `cursor-agent-wakatime status` | Print hook, log, state, WakaTime CLI, and installed command paths. |
| `cursor-agent-wakatime doctor` | Check that WakaTime CLI/config paths are available. |
| `cursor-agent-wakatime test` | Send one project heartbeat for the current directory. |
| `cursor-agent-wakatime test-wsl` | Compatibility alias for WSL installs. |
| `cursor-agent-wakatime test-windows` | Send one test heartbeat through the Windows hook path when available. |

## Files Written

macOS/native Linux:

| File | Purpose |
| --- | --- |
| `~/.cursor/hooks.json` | Cursor hook configuration. |
| `~/.cursor/cursor-agent-wakatime.log` | Hook debug log. |
| `~/.wakatime/cursor-agent-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |

Windows Cursor working on a WSL project:

| File | Purpose |
| --- | --- |
| `~/.cursor/hooks.json` | WSL Cursor hook configuration. |
| `~/.cursor/cursor-agent-wakatime.log` | WSL hook debug log. |
| `/mnt/c/Users/<user>/.cursor/hooks.json` | Windows Cursor hook configuration. |
| `/mnt/c/Users/<user>/.cursor/cursor-agent-wakatime.log` | Windows hook debug log. |
| `/mnt/c/Users/<user>/.wakatime/cursor-agent-wakatime.json` | Stores the last heartbeat timestamp/signature so repeated hook runs do not spam duplicate WakaTime heartbeats. |

## Troubleshooting

```bash
cursor-agent-wakatime status
cursor-agent-wakatime test
```

If `test` reports `missing_wakatime_cli`, install or initialize WakaTime first, or set:

```bash
export WAKATIME_CLI_PATH=/absolute/path/to/wakatime-cli
```

On WSL, set this if Windows profile detection picks the wrong user:

```bash
export WAKATIME_WINDOWS_HOME='C:\Users\YourName'
```
