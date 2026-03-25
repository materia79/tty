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

## Command Loader

At startup the console scans `commands/` for `.js` files and registers them as commands.

- Filename defines command name (`toggle.js` -> `toggle`)
- Module must export `cmd`
- Optional `help` text is aggregated and displayed by `help`
- Command handlers can be sync or async

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
	}
}
```

`variabled.afkTimeoutSeconds` is measured in seconds. Activity includes terminal keyboard and mouse interaction.

`afkEnabled` controls whether AFK timeout detection is active.

The file is loaded on startup and saved by `toggle title`, `toggle wrap`, `toggle timestamps`, `toggle mouse`, and `toggle afk`.

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
