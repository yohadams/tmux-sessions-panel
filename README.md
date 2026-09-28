# tmux-sessions-panel

A small OpenTUI interface for tmux sessions. Click a session in the sidebar to use it in the embedded terminal. Closing the app does not kill your tmux sessions.

Requires Bun 1.4+ and tmux. Git is optional and used for naming sessions.

```sh
bun install
bun run start
```

Build a single executable for your current platform:

```sh
bun run build
./dist/tmux-sessions-panel
```

The executable does not require Bun or `node_modules` at runtime, but tmux must be in PATH.

Use the mouse to select a session, create or kill one, and resize the sidebar with the `−` and `+` buttons or by dragging the divider. The `Exit` button asks for confirmation and only closes this app, not your tmux sessions. Keyboard input in the right pane goes to tmux.

New sessions initially get names like `session-1`. When the app first detects a Git repository in a session's active pane, it renames the tmux session to `repo-branch`, adding a number if that name is already taken. It does not rename the session again when the branch changes. The session list refreshes every three seconds.

## Resize diagnostics on Linux

If OpenCode freezes or uses too much memory after a window-manager resize, run `bun run diagnose` in the terminal where you can reproduce it. This starts a **separate** tmux server with `opencode --continue`. It verifies an 850 MiB memory limit on the tmux pane's own systemd scope **before** starting OpenCode; if it cannot verify that limit, it refuses to start. It does not touch your regular tmux sessions. The test session is removed when you exit the app. The printed log path records memory usage once per second, not terminal text or prompts. A memory-limit hit can terminate the test.
