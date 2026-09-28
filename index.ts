import { BoxRenderable, CliRenderEvents, EmbeddedTerminalRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
import { basename } from "node:path"

type Session = { id: string; name: string; path: string; gitNamed: boolean }

const palette = { bg: "#10151e", panel: "#192230", active: "#29445a", text: "#dce7ef", muted: "#8ca3b4", accent: "#7ed6c2" }

async function command(args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: "" } })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, text: text.trim() }
}

async function gitName(path: string): Promise<string | null> {
  if (!path) return null
  const result = await command(["git", "-C", path, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"])
  if (result.code !== 0) return null
  const [root, branch] = result.text.split("\n")
  if (!root || !branch) return null
  return `${basename(root)}-${branch}`.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || null
}

async function listSessions(): Promise<Session[]> {
  const result = await command(["tmux", "list-sessions", "-F", "#{session_id}\t#{session_name}\t#{pane_current_path}\t#{@session_panels_git_named}"])
  if (result.code !== 0) return []
  const sessions = result.text.split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", path = "", marked = ""] = line.split("\t")
    return { id, name, path, gitNamed: marked === "1" }
  })
  const names = new Set(sessions.map((session) => session.name))
  for (const session of sessions) {
    if (session.gitNamed) continue
    const name = await gitName(session.path)
    if (!name) continue
    let unique = name
    let suffix = 2
    while (names.has(unique) && unique !== session.name) unique = `${name}-${suffix++}`
    if (unique !== session.name) {
      const renamed = await command(["tmux", "rename-session", "-t", session.id, unique])
      if (renamed.code !== 0) continue
      names.delete(session.name)
      names.add(unique)
      session.name = unique
    }
    const marked = await command(["tmux", "set-option", "-t", session.id, "@session_panels_git_named", "1"])
    session.gitNamed = marked.code === 0
  }
  return sessions
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run this app in an interactive terminal.")
    process.exitCode = 1
    return
  }
  if ((await command(["tmux", "-V"])).code !== 0) {
    console.error("tmux is not in PATH. Install tmux and try again.")
    process.exitCode = 1
    return
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: palette.bg, useKittyKeyboard: null })
  let sessions: Session[] = []
  let selected: string | null = null
  let sidebarWidth = 27
  let busy = false
  let closing = false
  let confirmExit: BoxRenderable | null = null
  let attachment: ReturnType<typeof Bun.spawn> | null = null
  let terminal: EmbeddedTerminalRenderable | null = null
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSize: { cols: number; rows: number } | null = null
  let appliedSize: { cols: number; rows: number } | null = null
  let status = "Select a session"

  function resizeSidebar(width: number) {
    // Keep enough room for the attached tmux client, even in a narrow terminal.
    const next = Math.max(16, Math.min(width, 60, Math.max(16, renderer.width - 40)))
    if (next !== sidebarWidth) {
      sidebarWidth = next
      sidebar.width = next
    }
  }

  function schedulePtyResize(cols: number, rows: number) {
    if (cols < 1 || rows < 1 || !attachment) return
    pendingSize = { cols, rows }
    if (resizeTimer) clearTimeout(resizeTimer)
    // tmux/terminal apps redraw on every PTY resize. Apply only the final size
    // after a window manager's burst of SIGWINCH events, outside OpenTUI's render.
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      const size = pendingSize
      pendingSize = null
      if (!size || !attachment?.terminal) return
      if (appliedSize?.cols === size.cols && appliedSize.rows === size.rows) return
      attachment.terminal.resize(size.cols, size.rows)
      appliedSize = size
    }, 120)
  }

  const layout = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: "100%", backgroundColor: palette.bg })
  const sidebar = new BoxRenderable(renderer, { width: sidebarWidth, height: "100%", flexDirection: "column", backgroundColor: palette.panel })
  const divider = new BoxRenderable(renderer, {
    width: 1, height: "100%", backgroundColor: palette.active,
    onMouseDrag: (event) => { resizeSidebar(event.x) },
  })
  const content = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", minWidth: 1, height: "100%", backgroundColor: palette.bg })
  const header = new TextRenderable(renderer, { content: " tmux", height: 2, fg: palette.accent, selectable: false })
  const list = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", overflow: "hidden" })
  const actions = new BoxRenderable(renderer, { height: 5, flexDirection: "column" })
  const title = new TextRenderable(renderer, { content: "", height: 1, fg: palette.accent, selectable: false })
  const viewport = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 1, minWidth: 1, overflow: "hidden" })
  sidebar.add(header)
  sidebar.add(list)
  sidebar.add(actions)
  content.add(title)
  content.add(viewport)
  layout.add(sidebar)
  layout.add(divider)
  layout.add(content)
  renderer.root.add(layout)

  function button(text: string, onClick: () => void, active = false, width: number | "100%" = "100%") {
    return new TextRenderable(renderer, {
      content: width === "100%" ? ` ${text}` : text, height: 1, width, fg: active ? palette.accent : palette.text, selectable: false,
      bg: active ? palette.active : palette.panel,
      onMouseOver() { this.bg = palette.active; this.fg = palette.accent },
      onMouseOut() { this.bg = active ? palette.active : palette.panel; this.fg = active ? palette.accent : palette.text },
      onMouseDown: (event) => { if (event.button === 0) onClick() },
    })
  }

  function draw() {
    for (const child of list.getChildren()) {
      list.remove(child)
      child.destroyRecursively()
    }
    sessions.forEach((session, index) => {
      list.add(button(`${index + 1}. ${session.name}`, () => { void select(session.id) }, session.id === selected))
    })
    if (!sessions.length) list.add(new TextRenderable(renderer, { content: "  No sessions", fg: palette.muted, selectable: false }))
    for (const child of actions.getChildren()) {
      actions.remove(child)
      child.destroyRecursively()
    }
    actions.add(button("+ New session", () => { void createSession() }))
    actions.add(button("× Kill session", () => { void killSession() }))
    const resize = new BoxRenderable(renderer, { height: 1, flexDirection: "row", gap: 1 })
    resize.add(button(" − ", () => { resizeSidebar(sidebarWidth - 2) }, false, 3))
    resize.add(button(" + ", () => { resizeSidebar(sidebarWidth + 2) }, false, 3))
    resize.add(new TextRenderable(renderer, { content: " Width", fg: palette.muted, selectable: false }))
    actions.add(resize)
    actions.add(button("Exit", askToExit))
    title.content = selected ? ` ${sessions.find((s) => s.id === selected)?.name ?? "Session"}` : ` ${status}`
  }

  function detach() {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = null
    pendingSize = null
    appliedSize = null
    const old = attachment
    attachment = null
    if (terminal) {
      viewport.remove(terminal)
      terminal.destroy()
      terminal = null
    }
    if (old && old.exitCode === null) old.kill()
    old?.terminal?.close()
    return old
  }

  async function select(id: string) {
    if (selected === id && attachment) { terminal?.focus(); return }
    detach()
    selected = id
    const session = sessions.find((s) => s.id === id)
    if (!session) { selected = null; draw(); return }
    status = "Select a session"
    terminal = new EmbeddedTerminalRenderable(renderer, {
      width: "100%", height: "100%", cols: Math.max(1, renderer.width - sidebarWidth - 1), rows: Math.max(1, renderer.height - 1),
      maxScrollback: 500,
      // "response" contains replies to terminal capability and size queries.
      // Dropping it leaves interactive programs waiting for a reply forever.
      onData: (data) => { attachment?.terminal?.write(data) },
      onTerminalResize: schedulePtyResize,
      onMouseDown: () => { terminal?.focus() },
    })
    viewport.add(terminal)
    const current = terminal
    try {
      const proc = Bun.spawn(["tmux", "attach-session", "-t", id], {
        env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
        terminal: {
          cols: Math.max(1, renderer.width - sidebarWidth - 1), rows: Math.max(1, renderer.height - 1),
          data: (_pty, data) => { if (terminal === current) current.write(data) },
        },
      })
      attachment = proc
      appliedSize = { cols: Math.max(1, renderer.width - sidebarWidth - 1), rows: Math.max(1, renderer.height - 1) }
      void proc.exited.then(() => {
        if (attachment !== proc || closing) return
        detach()
        status = "Detached from session."
        void refresh()
      })
      current.focus()
    } catch (error) {
      detach()
      status = `Could not attach: ${String(error)}`
    }
    draw()
  }

  async function refresh() {
    if (closing) return
    try {
      const next = await listSessions()
      const changed = next.length !== sessions.length || next.some((session, i) => session.id !== sessions[i]?.id || session.name !== sessions[i]?.name)
      sessions = next
      let disconnected = false
      if (selected && !sessions.some((s) => s.id === selected)) {
        detach()
        selected = null
        status = "Session closed."
        disconnected = true
      }
      if (changed || disconnected) draw()
    } catch (error) {
      status = `tmux error: ${String(error)}`
      draw()
    }
  }

  async function createSession() {
    if (busy) return
    busy = true
    try {
      const used = new Set(sessions.map((s) => s.name))
      let number = 1
      while (used.has(`session-${number}`)) number++
      const name = `session-${number}`
      const before = new Set(sessions.map((session) => session.id))
      const result = await command(["tmux", "new-session", "-d", "-s", name, "-c", process.cwd()])
      if (result.code !== 0) throw new Error("Could not create session")
      await refresh()
      const created = sessions.find((s) => !before.has(s.id))
      if (created) await select(created.id)
    } catch (error) { status = String(error); draw() }
    finally { busy = false }
  }

  async function killSession() {
    if (busy || !selected) return
    busy = true
    try {
      const id = selected
      const result = await command(["tmux", "kill-session", "-t", id])
      if (result.code !== 0) throw new Error("Could not kill session")
      detach()
      selected = null
      status = "Session killed."
      await refresh()
    } catch (error) { status = String(error); draw() }
    finally { busy = false }
  }

  function closeConfirmation() {
    if (!confirmExit) return
    renderer.root.remove(confirmExit)
    confirmExit.destroyRecursively()
    confirmExit = null
    terminal?.focus()
  }

  function askToExit() {
    if (confirmExit) return
    terminal?.blur()
    const overlay = new BoxRenderable(renderer, {
      position: "absolute", top: 0, left: 0, width: "100%", height: "100%", zIndex: 100,
      alignItems: "center", justifyContent: "center", backgroundColor: palette.bg,
    })
    const dialog = new BoxRenderable(renderer, {
      width: 43, maxWidth: "90%", height: 7, flexDirection: "column", padding: 1,
      border: true, borderColor: palette.accent, backgroundColor: palette.panel,
    })
    dialog.add(new TextRenderable(renderer, { content: "Exit the app?", fg: palette.text, selectable: false }))
    dialog.add(new TextRenderable(renderer, { content: "Your tmux sessions will keep running.", fg: palette.muted, selectable: false }))
    const choices = new BoxRenderable(renderer, { flexDirection: "row", gap: 2, marginTop: 1 })
    choices.add(button(" Exit ", () => { void shutdown() }, false, 7))
    choices.add(button(" Cancel ", closeConfirmation, false, 9))
    dialog.add(choices)
    overlay.add(dialog)
    confirmExit = overlay
    renderer.root.add(overlay)
  }

  async function shutdown() {
    if (closing) return
    closing = true
    clearInterval(timer)
    const old = detach()
    try {
      if (old) await Promise.race([old.exited, Bun.sleep(500)])
    } finally {
      renderer.destroy()
    }
  }

  const timer = setInterval(() => { void refresh() }, 3000)
  renderer.on(CliRenderEvents.RESIZE, () => { resizeSidebar(sidebarWidth) })
  process.once("SIGTERM", () => { void shutdown() })
  await refresh()
  resizeSidebar(sidebarWidth)
  draw()
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
