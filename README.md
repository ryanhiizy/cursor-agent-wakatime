# cursor-agent-wakatime

WakaTime heartbeats for Cursor Agent Chat and Cmd+K hooks.

This package installs `afterAgentResponse` hooks for both the WSL Cursor profile and the Windows Cursor profile. Each completed response with a non-empty `text` payload sends one app-level WakaTime heartbeat.

## Scope

- Cursor `afterAgentResponse`
- WSL workspace flow
- Optional Windows profile wiring through a UNC path back into this repo
- Windows WakaTime CLI

## Commands

```bash
node ./bin/cursor-agent-wakatime.js install
node ./bin/cursor-agent-wakatime.js status
node ./bin/cursor-agent-wakatime.js test-wsl
node ./bin/cursor-agent-wakatime.js test-windows
```

## Notes

- WSL heartbeats are sent with a `\\wsl.localhost\\...` entity path so the Windows WakaTime CLI attributes them to the same project tree you see in Cursor.
- Heartbeats are sent with the plugin string `cursor/1.0.0 cursor-agent-wakatime/0.1.0`.
- The hook always returns valid `{}` output, even when WakaTime is unavailable.
