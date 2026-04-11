# Node Server Console

Terminal UI console for Node 20+ server apps with:

- Dynamic title row (updates every second)
- AFK detector with configurable inactivity timeout shown in title state
- Buffer viewport in the middle that always uses remaining space
- Scrollback navigation (PageUp/PageDown, Home/End with empty input, mouse wheel)
- Bottom input anchored to terminal bottom with multiline soft-wrap
- ANSI-decolor-aware line measurement for sizing/wrapping
- UTC timestamps on log lines with runtime seconds to hundredths
- `console.log` interception (`console._log` keeps original)
- Prefix history navigation (`type prefix`, then ArrowUp/ArrowDown)
- Retained output buffer capped at 5000 log entries by default
- Command loader from `commands/*.js`
- Persistent title/wrap/timestamps config in `console_config.json`
- Persistent AFK timeout config (`variabled.afkTimeoutSeconds`) in `console_config.json`
- Persistent input history in `console_history.json` (last 1000 entries)

## Demo

<p align="center">
  <a href="https://materia79.github.io/media/console.mp4" title="Click to open the demo video">
    <img src="https://materia79.github.io/media/console.png" alt="TTY console demo preview" width="720">
  </a>
</p>
<p align="center">
  <sub>Click the preview image to open the demo video.</sub>
</p>

## Index

- [Install](#install)
- [Run demo](#run-demo)
- [Dummy C heartbeat server](#dummy-c-heartbeat-server)
- [Built-in commands](#built-in-commands)
- [Integration](#integration)
- [Game Server Embedding](#game-server-embedding)
- [External Process Embedding (`embeddingExecutable` mode)](#external-process-embedding-embeddingexecutable-mode)
	- [Configuration](#configuration)
	- [What happens technically](#what-happens-technically)
	- [Data flow between processes](#data-flow-between-processes)
	- [Lifecycle and limitations](#lifecycle-and-limitations)
	- [Environment variables in launcher mode](#environment-variables-in-launcher-mode)
	- [Troubleshooting](#troubleshooting)
- [RageMP embedding example (`ragemp-server.exe`)](#ragemp-embedding-example-ragemp-serverexe)
- [Module Consumers (CJS and ESM)](#module-consumers-cjs-and-esm)
- [Command Loader](#command-loader)
- [Persistent Config](#persistent-config)
- [Persistent History](#persistent-history)
- [First Start Behavior](#first-start-behavior)
- [Title API](#title-api)
- [Notes](#notes)
- [Scroll Controls](#scroll-controls)

## Install

```bash
npm install
```

## Run demo

```bash
npm start
```

## Built-in commands

- `help` - Show loaded built-ins
- `toggle title` - Toggle title row and persist state
- `toggle wrap` - Toggle word-wrap and persist state
- `toggle timestamps` - Toggle UTC log timestamps and persist state
- `toggle mouse` - Toggle app mouse mode (wheel scroll) vs native terminal selection/copy/paste mode
- `toggle afk` - Toggle AFK timeout detection on/off and persist state
- `get [filter]` - List stored `variabled.*` values (optionally filtered)
- `set <variable> <value>` - Set and persist `variabled.<variable>`
- `unset <variable>` - Remove and persist `variabled.<variable>`
- `cls` - Clear output buffer
- `mandelbrot [options]` - Draw Mandelbrot sized to visible buffer viewport (`--color` available)
- `r <server side code>` - Evaluate code
- `exit` - Exit console

Commands are plain (no slash prefix).

## Integration

```js
const { createConsole } = require("./index");

const ui = createConsole({
	titleEnabled: true,
	wordWrapEnabled: true,
	prompt: "> "
}).start();

// Optional: expose API globally for your server runtime
global.tty = ui.tty;

// Logs written through console.log go to the buffer with UTC timestamps
console.log("server started");
```

## Game Server Embedding

For embedded usage (for example in a game server), create one `Console` instance and assign its public context to your host object.

```js
// Assuming your game server runtime is `mp` and you want to expose the console API on `mp.tty`:
const { Console } = require("tty-console");

const consoleRuntime = new Console({
	configPath: "./console_config.json",
	historyPath: "./console_history.json",
	commandsDir: "./commands",
	exitOnStop: false
});

// Expose runtime API on host object.
mp.tty = consoleRuntime.tty;

// Optional: run commands programmatically.
await mp.tty.parseCommand("help");
mp.tty.writeLog("game server initialized");
```

Notes:

- `new Console(...)` is safe in embedded/headless mode and does not auto-start the TUI.
- Call `.start()` only if you actually want the terminal UI to render.
- `exitOnStop: false` avoids terminating your host process when `stop()` is called.

## External Process Embedding (`embeddingExecutable` mode)

This mode is different from the in-process embedding above.

- In-process embedding: your host process imports this package and controls `Console` directly.
- `embeddingExecutable` mode: `node index.js` becomes a launcher that starts another executable and bridges terminal I/O to it.

Use this when your real host runtime is an external executable (for example a game server binary) and you still want this terminal UI as a front-end.

### Configuration

Set `embeddingExecutable` in `console_config.json`:

```json
{
	"embeddingExecutable": "ragemp-server.exe"
}
```

When this value is present and non-empty, running `node index.js` spawns that executable instead of starting a standalone local console session.

Inside the spawned process, `EMBEDDED_NATIVE_LOG` is already set, so the launcher path is skipped to prevent recursive self-spawning.

### What happens technically

Startup sequence:

1. `index.js` loads `console_config.json` and resolves `embeddingExecutable`.
2. It creates `<executable-name>_stdout.log` next to the executable.
3. It spawns the executable as a child process.
4. Child `stdout` is piped into that log file.
5. Child `stderr` stays attached to the terminal (`inherit`).
6. Launcher `stdin` is forwarded in raw mode to child `stdin` (including VT/mouse escape sequences).
7. The embedded console runtime tails the log file and renders new output continuously.

This means `node index.js` is the parent launcher process, while the configured executable is the process that actually hosts your real server/runtime behavior.

### Data flow between processes

- Keyboard and mouse input path: terminal -> launcher stdin -> child stdin.
- Output path for normal logs: child stdout -> `<executable-name>_stdout.log` -> console tail reader -> UI buffer.
- Error stream path: child stderr -> terminal directly.

The launcher handles stdin backpressure by pausing terminal reads when child stdin buffers fill, then resuming on drain.

### Lifecycle and limitations

- No auto-restart: if the embedded executable exits or crashes, launcher mode exits too.
- No reconnect flow: restart `node index.js` to start again.
- Built-in commands (`help`, `toggle`, `exit`, etc.) are console-side commands, not a command tunnel to the child process protocol.
- No prompt-detection protocol is implemented for the child process.
- Launcher log cleanup is best-effort on shutdown (with retry on common Windows file lock errors).

### Environment variables in launcher mode

- `EMBEDDED_NATIVE_LOG`: path to the created stdout log file.
- `TTY_LAUNCHER_MARKER`: debug marker used only when internal debug mode is enabled.

### Troubleshooting

- Executable not found: confirm `embeddingExecutable` is correct and resolvable from your environment.
- No live output: check whether `<executable-name>_stdout.log` is created and growing.
- Unexpected immediate exit: the launcher exits when the child process closes.
- Input feels blocked: this may be temporary stdin backpressure handling while child stdin drains.

## RageMP embedding example (`ragemp-server.exe`)

Minimal config:

```json
{
	"embeddingExecutable": "ragemp-server.exe"
}
```

Run:

```bash
node index.js
```

Expected behavior:

1. `node index.js` launches `ragemp-server.exe`.
2. `ragemp-server_stdout.log` is created next to the executable.
3. RageMP stdout is captured into that log and rendered live in the console UI.
4. Terminal input is forwarded to the child process.
5. When `ragemp-server.exe` exits, launcher mode exits as well.

If you need direct API control (`new Console(...)`, `mp.tty`, `parseCommand`, etc.), use the in-process embedding model from the `Game Server Embedding` section instead.

## Module Consumers (CJS and ESM)

CommonJS:

```js
const { Console, createConsole } = require("tty-console");
```

ESM:

```js
import ttyConsole from "tty-console";

const { Console, createConsole } = ttyConsole;
```

## Command Loader

At startup the console scans `commands/` for `.js` files and registers them as commands.

- Filename defines command name (`toggle.js` -> `toggle`)
- Module must export `cmd`
- Optional `help` text is aggregated and displayed by `help`
- Command handlers can be sync or async

`commandsDir` accepts a string (single directory) or an array of strings (multiple directories):

```js
// Single directory (default behavior, backward compatible)
const ui = createConsole({ commandsDir: "./commands" });

// Multiple directories — later entries override earlier ones on name collision
const { Console } = require("tty-console");
const path = require("path");

const ui = new Console({
	commandsDir: [
		path.join(__dirname, "node_modules/tty-console/commands"), // loaded first
		path.join(__dirname, "commands") // loaded second, overrides duplicates
	]
});
```

**Important:** when `commandsDir` is an array, folders are processed in the exact order they appear. If two folders provide the same command name, the later folder in the array overwrites the earlier one.

Non-existent directories in the array are silently skipped. If none of the listed directories exist, the help text shows "No commands directory found."

Command handler signature:

```js
module.exports = {
	cmd: (ctx, args, rawLine) => {
		return "ok";
	},
	help: "example                  - demo"
};
```

See `commands/README.md` for full details.

## Persistent Config

`console_config.json` stores toggle states:

```json
{
	"titleEnabled": true,
	"wordWrapEnabled": true,
	"timestampsEnabled": true,
	"mouseCaptureEnabled": true,
	"afkEnabled": true,
	"variabled": {
		"title": "Console",
		"afkTimeoutSeconds": "300"
	},
	"embeddingExecutable": "ragemp-server.exe"
}
```

`variabled.afkTimeoutSeconds` is measured in seconds. Activity includes terminal keyboard and mouse interaction.

`afkEnabled` controls whether AFK timeout detection is active.

`embeddingExecutable` enables launcher mode. If empty or missing, `index.js` starts in normal local console mode.

The file is loaded on startup and saved by `toggle title`, `toggle wrap`, `toggle timestamps`, `toggle mouse`, `toggle afk`, `set`, and `unset`.

## Persistent History

`console_history.json` stores the submitted input history used by ArrowUp/ArrowDown and prefix matching.

- Stores the newest 1000 non-empty submitted lines
- Loaded on startup and saved on each submitted command
- Restored automatically after restart

## First Start Behavior

Neither persistence file is required ahead of time.

- `console_config.json` is auto-created on first start if missing
- `console_history.json` is auto-created on first start if missing

## Title API

Modern callback fragments:

```js
ui.tty.addConsoleTitle(() => `players: ${global.mp.players.length}`);
```

Compatibility helpers exposed through `ui.tty`:

- `consoleTitleHeader` (array)
- `consoleTitleFooter` (array)
- `addConsoleTitle(fragmentOrExpression)`
- `getConsoleTitle()`

`addConsoleTitle` accepts:

- Function fragments (recommended)
- String expressions (evaluated with `with (globalThis)`) for migration

## Notes

- Buffer rendering currently uses decolored text for deterministic wrap math.
- Input is single logical command line with multiline visual wrapping.
- Viewport is always recalculated from available rows: `rows - titleHeight - inputHeight`.
- While scrolled up in history, newly printed logs do not move your current viewport.

## Scroll Controls

- `PageUp`: scroll up by one page minus one line.
- `PageDown`: scroll down by one page minus one line.
- `Home`: jump to the top of the retained log when the input is empty.
- `End`: jump to the live bottom when the input is empty.
- `Home` / `End` with non-empty input keep their original cursor start/end behavior.
- Mouse wheel up/down scrolls through history in small line steps while app mouse mode is enabled.
- Press `Esc`, click the title line, or run `toggle mouse` to switch between app mouse mode and native terminal selection mode.
- In native selection mode, terminal text selection/copy/paste works as expected, but app mouse wheel scrolling is disabled until switched back.
