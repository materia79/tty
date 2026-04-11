"use strict";

const blessed = require("neo-blessed");
const util = require("util");
const EventEmitter = require("events");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_TITLE_NAME = "node-server";
const CONFIG_SAVE_DEBOUNCE_MS = 250;
const DEFAULT_AFK_TIMEOUT_SECONDS = 300;
const DEFAULT_REFRESH_INTERVAL_MS = 1000;
const DEFAULT_AFK_REFRESH_INTERVAL_MS = 10000;
const TTY_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.TTY_DEBUG || ""));
const TTY_DEBUG_MOUSE_LEVEL = (() => {
  const raw = process.env.TTY_DEBUG_MOUSE_LEVEL || process.env.TTY_DEBUG_MOUSE || "0";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
})();
const TTY_DEBUG_ACTIVE = TTY_DEBUG_ENABLED || TTY_DEBUG_MOUSE_LEVEL > 0;
const TTY_DEBUG_FILE = TTY_DEBUG_ACTIVE
  ? (process.env.TTY_DEBUG_FILE || path.join(process.cwd(), "mouse_debug.log"))
  : "";
let TTY_DEBUG_FILE_INITIALIZED = false;
let TTY_DEBUG_FILE_ERROR_REPORTED = false;

function debugLog(scope, message, details) {
  if (!TTY_DEBUG_ACTIVE) {
    return;
  }

  const timestamp = new Date().toISOString();
  let line = `[tty-debug ${timestamp} pid=${process.pid} ${scope}] ${message}`;

  if (typeof details !== "undefined") {
    try {
      line += ` ${JSON.stringify(details)}`;
    } catch {
      line += ` ${String(details)}`;
    }
  }

  try {
    console.log(`${line}\n`);
  } catch {
    // Ignore debug write failures.
  }

  if (TTY_DEBUG_FILE.length > 0) {
    try {
      if (!TTY_DEBUG_FILE_INITIALIZED) {
        TTY_DEBUG_FILE_INITIALIZED = true;
        fs.appendFileSync(
          TTY_DEBUG_FILE,
          `\n=== tty debug start pid=${process.pid} ppid=${process.ppid} ${new Date().toISOString()} ===\n`,
          "utf8"
        );
      }

      fs.appendFileSync(TTY_DEBUG_FILE, `${line}\n`, "utf8");
    } catch (error) {
      if (!TTY_DEBUG_FILE_ERROR_REPORTED) {
        TTY_DEBUG_FILE_ERROR_REPORTED = true;
        try {
          process.stderr.write(
            `[tty-debug-file] failed path=${TTY_DEBUG_FILE} message=${error.message}\n`
          );
        } catch {
          // Ignore secondary failures.
        }
      }
    }
  }
}

function mouseDebug(level, message, details) {
  if (TTY_DEBUG_MOUSE_LEVEL < level) {
    return;
  }

  debugLog("mouse", message, details);
}

if (TTY_DEBUG_ACTIVE) {
  try {
    process.stderr.write(`[tty-debug-file] path=${TTY_DEBUG_FILE}\n`);
  } catch {
    // Ignore startup debug print failures.
  }
}

function normalizeAfkTimeoutSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_AFK_TIMEOUT_SECONDS;
  }

  return Math.max(1, Math.floor(numeric));
}

function normalizeRefreshIntervalMs(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(numeric));
}

function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

function hasAnsi(text) {
  ANSI_PATTERN.lastIndex = 0;
  return ANSI_PATTERN.test(String(text ?? ""));
}

function endsWithAnsiReset(text) {
  const input = String(text ?? "");
  const trailingWhitespace = input.match(/\s*$/)?.[0] ?? "";
  const base = trailingWhitespace.length > 0
    ? input.slice(0, -trailingWhitespace.length)
    : input;

  return /\u001b\[0m$/i.test(base);
}

function ensureAnsiResetAtEnd(text) {
  const input = String(text ?? "");
  if (!hasAnsi(input) || endsWithAnsiReset(input)) {
    return input;
  }

  const trailingWhitespace = input.match(/\s*$/)?.[0] ?? "";
  if (trailingWhitespace.length === 0) {
    return `${input}\u001b[0m`;
  }

  const base = input.slice(0, -trailingWhitespace.length);
  return `${base}\u001b[0m${trailingWhitespace}`;
}

function splitPhysicalRows(text) {
  const normalized = String(text ?? "").replace(/\r\n|\r/g, "\n");
  return normalized.split("\n");
}

function wrapPlainLine(text, width) {
  const input = String(text ?? "");
  if (width <= 0) {
    return [""];
  }

  if (input.length === 0) {
    return [""];
  }

  const out = [];
  let line = "";

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (ch === "\n") {
      out.push(line);
      line = "";
      continue;
    }

    line += ch;
    if (line.length >= width) {
      out.push(line);
      line = "";
    }
  }

  if (line.length > 0 || out.length === 0) {
    out.push(line);
  }

  return out;
}

function wrapPlain(text, width) {
  const rows = String(text ?? "").split("\n");
  const out = [];

  for (const row of rows) {
    out.push(...wrapPlainLine(row, width));
  }

  return out.length > 0 ? out : [""];
}

function wrapAnsiLine(text, width) {
  const input = String(text ?? "");
  if (width <= 0) {
    return [""];
  }

  if (input.length === 0) {
    return [""];
  }

  const out = [];
  let line = "";
  let visible = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (ch === "\u001b" && input[i + 1] === "[") {
      let j = i + 2;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) {
          j += 1;
          break;
        }
        j += 1;
      }

      line += input.slice(i, j);
      i = j - 1;
      continue;
    }

    line += ch;
    visible += 1;
    if (visible >= width) {
      // Absorb trailing ANSI sequences so they stay attached to this wrapped line.
      while (i + 2 < input.length && input[i + 1] === "\u001b" && input[i + 2] === "[") {
        let j = i + 3;
        while (j < input.length) {
          const code = input.charCodeAt(j);
          if (code >= 0x40 && code <= 0x7e) {
            j += 1;
            break;
          }
          j += 1;
        }

        line += input.slice(i + 1, j);
        i = j - 1;
      }

      out.push(line);
      line = "";
      visible = 0;
    }
  }

  if (line.length > 0 || out.length === 0) {
    out.push(line);
  }

  return out;
}

function wrapAnsi(text, width) {
  const rows = String(text ?? "").split("\n");
  const out = [];

  for (const row of rows) {
    out.push(...wrapAnsiLine(row, width));
  }

  return out.length > 0 ? out : [""];
}

function wrapDisplayRow(text, width, treatAsAnsi) {
  if (treatAsAnsi) {
    return wrapAnsiLine(text, width);
  }

  return wrapPlainLine(text, width);
}

function padToWidth(text, width) {
  const line = String(text ?? "");
  const visible = stripAnsi(line).length;
  if (visible >= width) {
    return line;
  }

  return line + " ".repeat(width - visible);
}

function padNumber(value, width = 2) {
  return String(value).padStart(width, "0");
}

function makeEvalFragment(expression) {
  const evaluator = new Function("ctx", `with (ctx) { return (${expression}); }`);
  return () => {
    try {
      const value = evaluator(globalThis);
      return String(value ?? "");
    } catch {
      return String(expression);
    }
  };
}

class Console extends EventEmitter {
  constructor(options = {}) {
    super();

    debugLog("console", "constructor-start", {
      ppid: process.ppid,
      cwd: process.cwd(),
      hasNativeLogEnv: Boolean(process.env.EMBEDDED_NATIVE_LOG),
      nativeLogEnv: process.env.EMBEDDED_NATIVE_LOG || null,
      stdinIsTTY: Boolean(process.stdin && process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout && process.stdout.isTTY),
      stderrIsTTY: Boolean(process.stderr && process.stderr.isTTY)
    });

    const rawCommandsDir = options.commandsDir ?? path.join(__dirname, "commands");
    const commandsDirList = Array.isArray(rawCommandsDir) ? rawCommandsDir : [rawCommandsDir];
    this.commandsDirs = commandsDirList.map((dir) => {
      const entry = String(dir ?? "");
      return path.isAbsolute(entry) ? entry : path.resolve(process.cwd(), entry);
    });
    this.configPath = options.configPath ?? path.join(process.cwd(), "console_config.json");
    this.historyPath = options.historyPath ?? path.join(process.cwd(), "console_history.json");
    this.maxHistoryEntries = options.maxHistoryEntries ?? 1000;
    this.exitOnStop = options.exitOnStop ?? true;
    const persistedConfig = this.loadConfig();
    this.embeddingExecutable = persistedConfig.embeddingExecutable || null;
    const persistedVariabled =
      persistedConfig.variabled &&
        typeof persistedConfig.variabled === "object" &&
        !Array.isArray(persistedConfig.variabled)
        ? persistedConfig.variabled
        : {};

    this.options = {
      maxBufferLines: options.maxBufferLines ?? 5000,
      prompt: options.prompt ?? "> ",
      titleEnabled: options.titleEnabled ?? persistedConfig.titleEnabled ?? true,
      wordWrapEnabled: options.wordWrapEnabled ?? persistedConfig.wordWrapEnabled ?? true,
      timestampsEnabled: options.timestampsEnabled ?? persistedConfig.timestampsEnabled ?? true,
      afkEnabled: options.afkEnabled ?? persistedConfig.afkEnabled ?? true,
      afkTimeoutSeconds: normalizeAfkTimeoutSeconds(
        options.afkTimeoutSeconds ?? persistedVariabled.afkTimeoutSeconds ?? persistedConfig.afkTimeoutSeconds
      ),
      refreshIntervalMs: normalizeRefreshIntervalMs(
        options.refreshIntervalMs ?? persistedVariabled.refreshIntervalMs ?? persistedConfig.refreshIntervalMs,
        DEFAULT_REFRESH_INTERVAL_MS
      ),
      afkRefreshIntervalMs: normalizeRefreshIntervalMs(
        options.afkRefreshIntervalMs ?? persistedVariabled.afkRefreshIntervalMs ?? persistedConfig.afkRefreshIntervalMs,
        DEFAULT_AFK_REFRESH_INTERVAL_MS
      ),
      hideTitleName: Boolean(options.hideTitleName),
      hideTitleUptime: Boolean(options.hideTitleUptime),
      hideTitleCPU: Boolean(options.hideTitleCPU),
      hideTitleMem: Boolean(options.hideTitleMem),
      hideTitleAfk: Boolean(options.hideTitleAfk),
      hideTitleMouse: Boolean(options.hideTitleMouse)
    };

    this.state = {
      buffer: [],
      commands: {},
      helpText: "",
      input: "",
      cursor: 0,
      prompt: this.options.prompt,
      history: this.loadHistory(),
      historyPrefix: null,
      historyCursor: -1,
      historyMatches: [],
      historyDraft: "",
      wrapEnabled: this.options.wordWrapEnabled,
      titleEnabled: this.options.titleEnabled,
      timestampsEnabled: this.options.timestampsEnabled,
      afkEnabled: this.options.afkEnabled,
      variabled: {
        title: DEFAULT_TITLE_NAME,
        ...persistedVariabled
      },
      titleFragments: [],
      titleHeader: [],
      titleFooter: [],
      slashRotate: ["|", "/", "-", "\\"],
      slashState: 0,
      delimiter: " :: ",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      isAfk: false,
      afkTimeoutSeconds: this.options.afkTimeoutSeconds,
      refreshIntervalMs: this.options.refreshIntervalMs,
      afkRefreshIntervalMs: this.options.afkRefreshIntervalMs,
      bufferScrollOffset: 0,
      mouseCaptureEnabled: persistedConfig.mouseCaptureEnabled ?? true,
      pendingRender: false,
      destroyed: false
    };

    this.screen = null;
    this.titleBox = null;
    this.bufferBox = null;
    this.inputBox = null;

    this.tty = {
      delimiter: this.state.delimiter,
      slashRotate: this.state.slashRotate,
      slashState: this.state.slashState,
      consoleTitleHeader: this.state.titleHeader,
      consoleTitleFooter: this.state.titleFooter,
      addConsoleTitle: (fragment) => this.addConsoleTitle(fragment),
      getConsoleTitle: () => this.getTitleLine(),
      getCPUUsage: () => this.getCPUUsage(),
      getMemUsage: () => this.getMemUsage(),
      uptime: () => this.getUptime(),
      writeLog: (...args) => this.writeLog(util.format(...args)),
      commands: this.state.commands,
      help: this.state.helpText,
      parseCommand: async (line) => this.parseCommand(line),
      setPrompt: (prompt) => this.setPrompt(prompt),
      setWrapEnabled: (enabled, persist = false) => this.setWrapEnabled(enabled, { persist }),
      setTitleEnabled: (enabled, persist = false) => this.setTitleEnabled(enabled, { persist }),
      setTimestampsEnabled: (enabled, persist = false) => this.setTimestampsEnabled(enabled, { persist }),
      setMouseCaptureEnabled: (enabled, persist = false) =>
        this.setMouseCaptureEnabled(enabled, { persist }),
      getMouseCaptureEnabled: () => this.state.mouseCaptureEnabled,
      setAfkTimeoutSeconds: (seconds, persist = false) =>
        this.setAfkTimeoutSeconds(seconds, { persist }),
      getAfkTimeoutSeconds: () => this.state.afkTimeoutSeconds,
      setRefreshIntervalMs: (value, persist = false) =>
        this.setRefreshIntervalMs(value, { persist }),
      getRefreshIntervalMs: () => this.state.refreshIntervalMs,
      setAfkRefreshIntervalMs: (value, persist = false) =>
        this.setAfkRefreshIntervalMs(value, { persist }),
      getAfkRefreshIntervalMs: () => this.state.afkRefreshIntervalMs,
      setAfkEnabled: (enabled, persist = false) => this.setAfkEnabled(enabled, { persist }),
      getAfkEnabled: () => this.state.afkEnabled,
      getAfkState: () => (this.state.isAfk ? "afk" : "active"),
      saveConfig: () => this.saveConfig(),
      saveHistory: () => this.saveHistory()
    };

    this.titleTimer = null;
    this.afkTimeoutHandle = null;
    this.configSaveTimer = null;
    this.configSaveQueued = false;
    this.configSaveDelayMs = options.configSaveDelayMs ?? CONFIG_SAVE_DEBOUNCE_MS;
    this.logPath = options.logPath ?? path.resolve(process.cwd(), "server.log");
    this.logWriteErrorPrinted = false;
    this.originalConsoleLog = null;
    this.originalConsoleWarn = null;
    this.originalConsoleInfo = null;
    this.originalStdoutWrite = null;
    this.originalStderrWrite = null;
    this.stdoutPending = "";
    this.stderrPending = "";
    this.nextBufferEntryId = 1;
    this.nextBufferGroupId = 1;
    this.suppressExternalStreamInterception = false;
    this.hasRenderedOnce = false;
    this.isRendering = false;
    this.dedicatedTtyOutput = null;
    this.dedicatedTtyInput = null;
    this.nativeLogPath = process.env.EMBEDDED_NATIVE_LOG || null;
    debugLog("console", "constructor-native-log", {
      nativeLogPath: this.nativeLogPath,
      nativeLogExists: this.nativeLogPath ? fs.existsSync(this.nativeLogPath) : false
    });
    this.nativeLogFd = null;
    this.nativeLogOffset = 0;
    this.nativeLogPending = "";
    this.nativeLogTimer = null;
    this.boundKeypress = (ch, key) => this.handleKeypress(ch, key);
    this.boundResize = () => this.scheduleRender();
    this.boundMouse = (data) => this.handleMouse(data);
    this.boundProgramMouse = (data) => this.handleMouse(data);
    this.boundRawInputData = (chunk) => this.handleRawInputData(chunk);
    this.boundProcessStdinData = (chunk) => this.handleRawInputData(chunk);
    this.boundTitleClick = () => this.handleTitleClick();
    this.boundWheelUp = () => this.handleWheel(1);
    this.boundWheelDown = () => this.handleWheel(-1);
    this.rawMousePending = "";
    this.lastParsedWheelAtMs = 0;
    this.lastEmbeddedPageWheelAtMs = 0;
    this.resizePollTimer = null;
    this._lastKnownCols = 0;
    this._lastKnownRows = 0;
    this.isWindowsTerminal =
      process.platform === "win32" &&
      Boolean(process.env.WT_SESSION || process.env.WT_PROFILE_ID);

    this.installDefaultTitle();
    this.initCommands();
  }

  initializeScreen() {
    if (this.screen) {
      return;
    }

    debugLog("screen", "initialize-start", {
      nativeLogPath: this.nativeLogPath,
      stdinIsTTY: Boolean(process.stdin && process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout && process.stdout.isTTY),
      stderrIsTTY: Boolean(process.stderr && process.stderr.isTTY)
    });

    const screenOpts = {
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      autoPadding: false,
      mouse: true
    };

    if (this.nativeLogPath) {
      if (process.stderr && process.stderr.isTTY) {
        this.dedicatedTtyOutput = process.stderr;
        this.dedicatedTtyInput = process.stdin;
        screenOpts.output = this.dedicatedTtyOutput;
        screenOpts.input = this.dedicatedTtyInput;
        debugLog("screen", "using-stderr-for-blessed", {
          outputFd: typeof this.dedicatedTtyOutput.fd === "number" ? this.dedicatedTtyOutput.fd : null
        });
      } else {
        debugLog("screen", "native-log-disabled-non-tty-stderr", {
          stderrIsTTY: Boolean(process.stderr && process.stderr.isTTY)
        });
        this.nativeLogPath = null;
      }
    }

    this.screen = blessed.screen(screenOpts);
    debugLog("screen", "initialize-complete", {
      hasScreen: Boolean(this.screen),
      usedDedicatedOutput: Boolean(screenOpts.output),
      usedDedicatedInput: Boolean(screenOpts.input)
    });

    this.titleBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      mouse: true,
      tags: false,
      style: { fg: "black", bg: "green" }
    });

    this.bufferBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: "100%",
      height: 1,
      mouse: true,
      tags: false,
      style: { fg: "white", bg: "black" }
    });

    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      style: { fg: "white", bg: "blue" }
    });
  }

  configureMouseTracking() {
    this.runWithExternalStreamInterceptionSuppressed(() => {
      if (!this.screen || !this.screen.program) {
        mouseDebug(1, "configure-skip-no-screen");
        return;
      }

      mouseDebug(1, "configure-start", {
        captureEnabled: this.state.mouseCaptureEnabled,
        isWindowsTerminal: this.isWindowsTerminal,
        hasEnableMouse: typeof this.screen.program.enableMouse === "function",
        hasDisableMouse: typeof this.screen.program.disableMouse === "function",
        hasSetMouse: typeof this.screen.program.setMouse === "function"
      });

      if (!this.state.mouseCaptureEnabled) {
        if (typeof this.screen.program.disableMouse === "function") {
          this.screen.program.disableMouse();
          mouseDebug(1, "configure-disabled");
        }
        this.forceTerminalMouseMode(false);
        return;
      }

      this.screen.enableMouse(this.bufferBox);
      mouseDebug(2, "configure-enable-mouse-box");

      if (typeof this.screen.program.setMouse === "function") {
        this.screen.program.setMouse(
          {
            vt200Mouse: true,
            sgrMouse: true,
            utfMouse: false,
            cellMotion: true,
            allMotion: true,
            sendFocus: true
          },
          true
        );
        mouseDebug(1, "configure-setMouse-sgr");
      }

      if (typeof this.screen.program.enableMouse === "function") {
        this.screen.program.enableMouse();
        mouseDebug(1, "configure-enableMouse");
      }

      this.forceTerminalMouseMode(true);
    });
  }

  forceTerminalMouseMode(enabled) {
    const target =
      (this.screen && this.screen.program && this.screen.program.output) ||
      this.dedicatedTtyOutput ||
      process.stderr;

    if (!target || typeof target.write !== "function") {
      mouseDebug(1, "force-mouse-mode-skip-no-target", { enabled });
      return;
    }

    const enableSeq = "\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1015l";
    const disableSeq = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l";

    try {
      target.write(enabled ? enableSeq : disableSeq);
      mouseDebug(1, "force-mouse-mode-written", {
        enabled,
        outputFd: typeof target.fd === "number" ? target.fd : null,
        outputIsTTY: Boolean(target.isTTY)
      });
    } catch (error) {
      mouseDebug(1, "force-mouse-mode-write-failed", {
        enabled,
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  setMouseCaptureEnabled(enabled, options = {}) {
    const next = Boolean(enabled);

    if (this.state.mouseCaptureEnabled === next) {
      return false;
    }

    this.state.mouseCaptureEnabled = next;
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.configureMouseTracking();
    this.scheduleRender();
    return true;
  }

  handleTitleClick() {
    const next = !this.state.mouseCaptureEnabled;
    this.setMouseCaptureEnabled(next, { persist: true });
    this.writeLog(
      next
        ? "Mouse capture enabled: app wheel handling active."
        : "Mouse capture disabled: native terminal selection/copy/paste active."
    );
  }

  getWindowsClipboardText() {
    if (process.platform !== "win32") {
      return "";
    }

    try {
      return String(
        childProcess.execFileSync(
          "powershell",
          ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        )
      );
    } catch {
      return "";
    }
  }

  tryHandleWindowsRightClickPaste(data) {
    if (!this.isWindowsTerminal || !data) {
      return false;
    }

    const action = typeof data.action === "string" ? data.action.toLowerCase() : "";
    const button = typeof data.button === "string" ? data.button.toLowerCase() : "";
    const isRightButton =
      button === "right" || button === "rightbutton" || button === "button3" || button === "mouse3";

    if (!isRightButton || (action !== "" && action !== "mousedown")) {
      return false;
    }

    const clipboardText = this
      .getWindowsClipboardText()
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n+/g, " ");

    if (clipboardText.length === 0) {
      return false;
    }

    this.insertText(clipboardText);
    return true;
  }

  start() {
    this.initializeScreen();
    this.ensurePersistenceFiles();
    this.installConsoleLogWrapper();
    this.installStdStreamCapture();
    this.startNativeLogTail();

    this.screen.on("keypress", this.boundKeypress);
    this.screen.on("resize", this.boundResize);
    this.screen.on("mouse", this.boundMouse);
    this.screen.on("wheelup", this.boundWheelUp);
    this.screen.on("wheeldown", this.boundWheelDown);
    if (this.screen.program && typeof this.screen.program.on === "function") {
      this.screen.program.on("mouse", this.boundProgramMouse);
      mouseDebug(2, "listener-program-mouse-attached");
    }
    if (this.screen.program && this.screen.program.input && typeof this.screen.program.input.on === "function") {
      this.screen.program.input.on("data", this.boundRawInputData);
      mouseDebug(2, "listener-raw-input-attached");
    }
    if (process.stdin && typeof process.stdin.on === "function") {
      const inputStream = this.screen && this.screen.program ? this.screen.program.input : null;
      if (inputStream !== process.stdin) {
        process.stdin.on("data", this.boundProcessStdinData);
        mouseDebug(2, "listener-stdin-raw-attached");
      }
    }
    this.titleBox.on("click", this.boundTitleClick);
    this.bufferBox.on("wheelup", this.boundWheelUp);
    this.bufferBox.on("wheeldown", this.boundWheelDown);
    this.configureMouseTracking();

    // In embedded mode, the launcher stdin relay consumes WINDOW_BUFFER_SIZE
    // events from the console input queue, preventing SIGWINCH delivery to this
    // process. Poll the dedicated TTY output for actual terminal dimensions.
    if (this.nativeLogPath && this.dedicatedTtyOutput &&
        typeof this.dedicatedTtyOutput.getWindowSize === "function") {
      // Use _handle.getWindowSize() to get LIVE OS values. The public
      // getWindowSize() returns cached .columns/.rows that are only refreshed
      // on SIGWINCH — which never fires because our stdin is a pipe.
      const _pollLiveSize = (stream) => {
        if (stream._handle && typeof stream._handle.getWindowSize === "function") {
          const out = [0, 0];
          const err = stream._handle.getWindowSize(out);
          if (err === 0) return out;
        }
        return stream.getWindowSize();
      };
      const initSize = _pollLiveSize(this.dedicatedTtyOutput);
      this._lastKnownCols = initSize[0];
      this._lastKnownRows = initSize[1];
      debugLog("resize-poll", "started", {
        cols: this._lastKnownCols,
        rows: this._lastKnownRows,
        outputIsTTY: Boolean(this.dedicatedTtyOutput.isTTY),
        outputFd: typeof this.dedicatedTtyOutput.fd === "number" ? this.dedicatedTtyOutput.fd : null,
        usesHandleDirect: Boolean(this.dedicatedTtyOutput._handle && typeof this.dedicatedTtyOutput._handle.getWindowSize === "function")
      });
      this.resizePollTimer = setInterval(() => {
        if (this.state.destroyed || !this.dedicatedTtyOutput) return;
        let size;
        try { size = _pollLiveSize(this.dedicatedTtyOutput); } catch { return; }
        const [cols, rows] = size;
        if (cols !== this._lastKnownCols || rows !== this._lastKnownRows) {
          debugLog("resize-poll", "detected", {
            oldCols: this._lastKnownCols, oldRows: this._lastKnownRows,
            newCols: cols, newRows: rows
          });
          this._lastKnownCols = cols;
          this._lastKnownRows = rows;
          this.dedicatedTtyOutput.columns = cols;
          this.dedicatedTtyOutput.rows = rows;
          if (this.screen && this.screen.program) {
            this.screen.program.cols = cols;
            this.screen.program.rows = rows;
            this.screen.program.emit("resize");
          }
        }
      }, 300);
    } else {
      debugLog("resize-poll", "skipped", {
        nativeLogPath: this.nativeLogPath || null,
        hasDedicatedTtyOutput: Boolean(this.dedicatedTtyOutput),
        hasGetWindowSize: Boolean(this.dedicatedTtyOutput && typeof this.dedicatedTtyOutput.getWindowSize === "function")
      });
    }

    this.screen.key(["C-c"], () => this.stop());

    this.restartTitleTimer();

    this.scheduleAfkTimeout();

    this.scheduleRender();
    return this;
  }

  loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        return {};
      }

      const data = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") {
        return {};
      }

      return parsed;
    } catch {
      return {};
    }
  }

  loadHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) {
        return [];
      }

      const data = fs.readFileSync(this.historyPath, "utf8");
      const parsed = JSON.parse(data);

      let values = [];
      if (Array.isArray(parsed)) {
        values = parsed;
      } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.history)) {
        values = parsed.history;
      }

      return values
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0)
        .slice(-this.maxHistoryEntries);
    } catch {
      return [];
    }
  }

  ensurePersistenceFiles() {
    if (!fs.existsSync(this.configPath)) {
      this.saveConfig();
    }

    if (!fs.existsSync(this.historyPath)) {
      this.saveHistory();
    }
  }

  saveConfig() {
    const payload = {
      titleEnabled: this.state.titleEnabled,
      wordWrapEnabled: this.state.wrapEnabled,
      timestampsEnabled: this.state.timestampsEnabled,
      mouseCaptureEnabled: this.state.mouseCaptureEnabled,
      afkEnabled: this.state.afkEnabled,
      variabled: {
        ...this.state.variabled,
        afkTimeoutSeconds: String(this.state.afkTimeoutSeconds),
        refreshIntervalMs: String(this.state.refreshIntervalMs),
        afkRefreshIntervalMs: String(this.state.afkRefreshIntervalMs)
      }
    };

    if (this.embeddingExecutable) {
      payload.embeddingExecutable = this.embeddingExecutable;
    }

    const tempPath = `${this.configPath}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.configPath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup failure.
      }
      this.writeLog(`Failed to save config: ${error.message}`);
    }
  }

  scheduleConfigSave() {
    if (this.state.destroyed) {
      return;
    }

    this.configSaveQueued = true;
    if (this.configSaveTimer) {
      clearTimeout(this.configSaveTimer);
    }

    this.configSaveTimer = setTimeout(() => {
      this.configSaveTimer = null;
      if (!this.configSaveQueued || this.state.destroyed) {
        return;
      }

      this.configSaveQueued = false;
      this.saveConfig();
    }, this.configSaveDelayMs);
  }

  flushPendingConfigSave() {
    if (this.configSaveTimer) {
      clearTimeout(this.configSaveTimer);
      this.configSaveTimer = null;
    }

    if (!this.configSaveQueued) {
      return;
    }

    this.configSaveQueued = false;
    this.saveConfig();
  }

  saveHistory() {
    const payload = this.state.history.slice(-this.maxHistoryEntries);
    const tempPath = `${this.historyPath}.tmp`;

    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.historyPath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup failure.
      }
      this.writeLog(`Failed to save history: ${error.message}`);
    }
  }

  appendHistory(entry) {
    const value = String(entry ?? "").trim();
    if (value.length === 0) {
      return;
    }

    const existingIndex = this.state.history.lastIndexOf(value);
    if (existingIndex !== -1) {
      this.state.history.splice(existingIndex, 1);
    }

    this.state.history.push(value);
    if (this.state.history.length > this.maxHistoryEntries) {
      this.state.history = this.state.history.slice(-this.maxHistoryEntries);
    }

    this.saveHistory();
  }

  initCommands() {
    this.state.commands = {};
    const ungroupedHelpEntries = [];
    const groupedHelpEntries = new Map();
    let loadedAnyDir = false;

    for (const dir of this.commandsDirs) {
      if (!fs.existsSync(dir)) {
        continue;
      }

      loadedAnyDir = true;

      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .sort();

      for (const filename of files) {
        const commandName = filename.slice(0, -3).toLowerCase();
        const fullPath = path.resolve(dir, filename);
        let commandModule;

        try {
          delete require.cache[require.resolve(fullPath)];
          commandModule = require(fullPath);
        } catch (error) {
          this.writeLog(`Failed to load command ${commandName}: ${error.message}`);
          continue;
        }

        if (!commandModule || typeof commandModule.cmd !== "function") {
          continue;
        }

        this.state.commands[commandName] = commandModule.cmd;

        // Remove any prior help entry for this command name so that
        // later directories cleanly override earlier ones.
        const existingUngrouped = ungroupedHelpEntries.findIndex(
          (e) => e.commandName === commandName
        );
        if (existingUngrouped !== -1) {
          ungroupedHelpEntries.splice(existingUngrouped, 1);
        }
        for (const entries of groupedHelpEntries.values()) {
          const idx = entries.findIndex((e) => e.commandName === commandName);
          if (idx !== -1) {
            entries.splice(idx, 1);
          }
        }

        if (typeof commandModule.help === "string" && commandModule.help.length > 0) {
          const helpLine = commandModule.help.replace(/\s+$/, "");
          const groupName =
            typeof commandModule.group === "string" ? commandModule.group.trim() : "";

          if (groupName.length === 0) {
            ungroupedHelpEntries.push({ commandName, helpLine });
            continue;
          }

          if (!groupedHelpEntries.has(groupName)) {
            groupedHelpEntries.set(groupName, []);
          }

          groupedHelpEntries.get(groupName).push({ commandName, helpLine });
        }
      }
    }

    if (!loadedAnyDir) {
      this.state.helpText = "No commands directory found.";
      this.tty.commands = this.state.commands;
      this.tty.help = this.state.helpText;
      return;
    }

    ungroupedHelpEntries.sort((a, b) => a.commandName.localeCompare(b.commandName));

    for (const entries of groupedHelpEntries.values()) {
      entries.sort((a, b) => a.commandName.localeCompare(b.commandName));
    }

    const helpLines = ungroupedHelpEntries.map((entry) => entry.helpLine);
    const sortedGroups = Array.from(groupedHelpEntries.keys()).sort((a, b) =>
      a.localeCompare(b),
    );

    for (const groupName of sortedGroups) {
      if (helpLines.length > 0) {
        helpLines.push("");
      }

      helpLines.push(`   ${groupName}`);
      helpLines.push(...groupedHelpEntries.get(groupName).map((entry) => entry.helpLine));
    }

    this.state.helpText = helpLines.join("\n");
    this.tty.commands = this.state.commands;
    this.tty.help = this.state.helpText;
  }

  stop() {
    if (this.state.destroyed) {
      return;
    }

    this.state.destroyed = true;

    if (this.titleTimer) {
      clearTimeout(this.titleTimer);
      this.titleTimer = null;
    }

    if (this.afkTimeoutHandle) {
      clearTimeout(this.afkTimeoutHandle);
      this.afkTimeoutHandle = null;
    }

    if (this.resizePollTimer) {
      clearInterval(this.resizePollTimer);
      this.resizePollTimer = null;
    }

    this.flushPendingConfigSave();

    this.stopNativeLogTail();
    this.uninstallStdStreamCapture();
    this.uninstallConsoleLogWrapper();
    if (process.stdin) {
      if (typeof process.stdin.off === "function") {
        process.stdin.off("data", this.boundProcessStdinData);
      } else if (typeof process.stdin.removeListener === "function") {
        process.stdin.removeListener("data", this.boundProcessStdinData);
      }
    }
    if (this.screen && this.screen.program) {
      if (typeof this.screen.program.off === "function") {
        this.screen.program.off("mouse", this.boundProgramMouse);
      } else if (typeof this.screen.program.removeListener === "function") {
        this.screen.program.removeListener("mouse", this.boundProgramMouse);
      }
      if (this.screen.program.input) {
        if (typeof this.screen.program.input.off === "function") {
          this.screen.program.input.off("data", this.boundRawInputData);
        } else if (typeof this.screen.program.input.removeListener === "function") {
          this.screen.program.input.removeListener("data", this.boundRawInputData);
        }
      }
      this.screen.program.showCursor();
    }
    if (this.screen) {
      this.screen.destroy();
    }
    this.dedicatedTtyOutput = null;
    this.dedicatedTtyInput = null;
    if (this.exitOnStop) {
      process.exit(0);
    }
  }

  installDefaultTitle() {
    this.state.titleHeader.length = 0;
    this.state.titleFooter.length = 0;

    this.state.titleHeader.push(() => `[${this.state.slashRotate[this.state.slashState]}]`);
    if (!this.options.hideTitleName) {
      this.state.titleHeader.push(() => {
        const configuredTitle =
          typeof this.state.variabled.title === "undefined"
            ? ""
            : String(this.state.variabled.title ?? "").trim();

        return configuredTitle.length > 0 ? configuredTitle : DEFAULT_TITLE_NAME;
      });
    }

    if (!this.options.hideTitleUptime) {
      this.state.titleFooter.push(() => `${this.state.delimiter}up: ${this.getUptime()}`);
    }
    if (!this.options.hideTitleCPU) {
      this.state.titleFooter.push(() => `${this.state.delimiter}CPU: ${this.getCPUUsage()}%`);
    }
    if (!this.options.hideTitleMem) {
      this.state.titleFooter.push(() => `${this.state.delimiter}Mem: ${this.getMemUsage()}`);
    }
    if (!this.options.hideTitleAfk) {
      this.state.titleFooter.push(
        () => `${this.state.delimiter}state: ${this.state.afkEnabled ? (this.state.isAfk ? "AFK" : "active") : "disabled"}`
      );
    }
    if (!this.options.hideTitleMouse) {
      this.state.titleFooter.push(
        () => `${this.state.delimiter}mouse: ${this.state.mouseCaptureEnabled ? "app" : "native"}`
      );
    }
  }

  setAfkState(isAfk) {
    const next = Boolean(isAfk);
    if (next === this.state.isAfk) {
      return false;
    }

    this.state.isAfk = next;
    this.restartTitleTimer();
    this.scheduleRender();
    return true;
  }

  getTitleRefreshIntervalMs() {
    return this.state.isAfk ? this.state.afkRefreshIntervalMs : this.state.refreshIntervalMs;
  }

  restartTitleTimer() {
    if (this.state.destroyed) {
      return;
    }

    if (this.titleTimer) {
      clearTimeout(this.titleTimer);
      this.titleTimer = null;
    }

    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      if (this.state.destroyed) {
        return;
      }

      this.state.slashState = (this.state.slashState + 1) % this.state.slashRotate.length;
      this.tty.slashState = this.state.slashState;
      this.scheduleRender();
      this.restartTitleTimer();
    }, this.getTitleRefreshIntervalMs());
  }

  scheduleAfkTimeout() {
    if (this.state.destroyed || !this.state.afkEnabled) {
      if (this.afkTimeoutHandle) {
        clearTimeout(this.afkTimeoutHandle);
        this.afkTimeoutHandle = null;
      }
      return;
    }

    if (this.afkTimeoutHandle) {
      clearTimeout(this.afkTimeoutHandle);
    }

    this.afkTimeoutHandle = setTimeout(() => {
      this.afkTimeoutHandle = null;
      if (this.state.destroyed) {
        return;
      }

      this.setAfkState(true);
    }, this.state.afkTimeoutSeconds * 1000);
  }

  markActivity() {
    if (this.state.destroyed) {
      return;
    }

    this.state.lastActivityAt = Date.now();
    this.setAfkState(false);
    this.scheduleAfkTimeout();
  }

  setAfkEnabled(enabled, options = {}) {
    const next = Boolean(enabled);
    if (next === this.state.afkEnabled) {
      return false;
    }

    this.state.afkEnabled = next;
    if (options.persist) {
      this.scheduleConfigSave();
    }

    if (!next) {
      this.setAfkState(false);
    }
    this.scheduleAfkTimeout();
    this.scheduleRender();
    return true;
  }

  addConsoleTitle(fragment) {
    if (typeof fragment === "function") {
      this.state.titleHeader.push(fragment);
      this.scheduleRender();
      return;
    }

    if (typeof fragment === "string") {
      this.state.titleHeader.push(makeEvalFragment(fragment));
      this.scheduleRender();
      return;
    }

    this.state.titleHeader.push(() => String(fragment ?? ""));
    this.scheduleRender();
  }

  getTitleLine() {
    const headerFragments = [];
    const footerFragments = [];

    for (const part of this.state.titleHeader) {
      try {
        const value = typeof part === "function" ? part() : part;
        headerFragments.push(String(value ?? ""));
      } catch {
        headerFragments.push("<title-error>");
      }
    }

    for (const part of this.state.titleFooter) {
      try {
        const value = typeof part === "function" ? part() : part;
        footerFragments.push(String(value ?? ""));
      } catch {
        footerFragments.push("<title-error>");
      }
    }

    const header = headerFragments.join(" ");
    const footer = footerFragments.join("");

    if (!header) {
      return footer;
    }

    return `${header}${footer}`;
  }

  setPrompt(prompt) {
    this.state.prompt = String(prompt ?? "");
    this.scheduleRender();
  }

  setVariable(name, value, options = {}) {
    const key = String(name ?? "").trim();
    if (key.length === 0) {
      return false;
    }

    const nextValue = String(value ?? "");
    this.state.variabled[key] = nextValue;
    if (key === "afkTimeoutSeconds") {
      const normalized = normalizeAfkTimeoutSeconds(nextValue);
      this.state.afkTimeoutSeconds = normalized;
      this.state.variabled.afkTimeoutSeconds = String(normalized);
      this.markActivity();
    }
    if (key === "refreshIntervalMs") {
      const normalized = normalizeRefreshIntervalMs(nextValue, DEFAULT_REFRESH_INTERVAL_MS);
      this.state.refreshIntervalMs = normalized;
      this.state.variabled.refreshIntervalMs = String(normalized);
      this.restartTitleTimer();
    }
    if (key === "afkRefreshIntervalMs") {
      const normalized = normalizeRefreshIntervalMs(nextValue, DEFAULT_AFK_REFRESH_INTERVAL_MS);
      this.state.afkRefreshIntervalMs = normalized;
      this.state.variabled.afkRefreshIntervalMs = String(normalized);
      this.restartTitleTimer();
    }
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.scheduleRender();
    return true;
  }

  unsetVariable(name, options = {}) {
    const key = String(name ?? "").trim();
    if (key.length === 0) {
      return false;
    }

    if (!Object.prototype.hasOwnProperty.call(this.state.variabled, key)) {
      return false;
    }

    delete this.state.variabled[key];
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.scheduleRender();
    return true;
  }

  setWrapEnabled(enabled, options = {}) {
    this.state.wrapEnabled = Boolean(enabled);
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.scheduleRender();
  }

  setTitleEnabled(enabled, options = {}) {
    this.state.titleEnabled = Boolean(enabled);
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.scheduleRender();
  }

  setTimestampsEnabled(enabled, options = {}) {
    this.state.timestampsEnabled = Boolean(enabled);
    if (options.persist) {
      this.scheduleConfigSave();
    }
    this.scheduleRender();
  }

  setAfkTimeoutSeconds(seconds, options = {}) {
    const next = normalizeAfkTimeoutSeconds(seconds);
    if (next === this.state.afkTimeoutSeconds) {
      return false;
    }

    this.state.afkTimeoutSeconds = next;
    this.state.variabled.afkTimeoutSeconds = String(next);
    if (options.persist) {
      this.scheduleConfigSave();
    }

    this.markActivity();
    return true;
  }

  setRefreshIntervalMs(value, options = {}) {
    const next = normalizeRefreshIntervalMs(value, DEFAULT_REFRESH_INTERVAL_MS);
    if (next === this.state.refreshIntervalMs) {
      return false;
    }

    this.state.refreshIntervalMs = next;
    this.state.variabled.refreshIntervalMs = String(next);
    if (options.persist) {
      this.scheduleConfigSave();
    }

    this.restartTitleTimer();
    this.scheduleRender();
    return true;
  }

  setAfkRefreshIntervalMs(value, options = {}) {
    const next = normalizeRefreshIntervalMs(value, DEFAULT_AFK_REFRESH_INTERVAL_MS);
    if (next === this.state.afkRefreshIntervalMs) {
      return false;
    }

    this.state.afkRefreshIntervalMs = next;
    this.state.variabled.afkRefreshIntervalMs = String(next);
    if (options.persist) {
      this.scheduleConfigSave();
    }

    this.restartTitleTimer();
    this.scheduleRender();
    return true;
  }

  getLogTimestamp(date = new Date()) {
    const runtimeSeconds = Math.max(0, Math.floor((date.getTime() - this.state.startedAt) / 10) / 100);
    return `${date.getUTCFullYear()}-${padNumber(date.getUTCMonth() + 1)}-${padNumber(date.getUTCDate())} ${padNumber(date.getUTCHours())}:${padNumber(date.getUTCMinutes())}:${padNumber(date.getUTCSeconds())} (${runtimeSeconds.toFixed(2)})`;
  }

  getUptime() {
    const uptimeHours = (Date.now() - this.state.startedAt) / 3600000;

    if (uptimeHours >= 24) {
      const uptimeDays = Math.floor(uptimeHours / 0.24) / 100;
      return `${uptimeDays.toFixed(2)}d`;
    }

    const truncatedHours = Math.floor(uptimeHours * 100) / 100;
    return `${truncatedHours.toFixed(2)}h`;
  }

  getCPUUsage() {
    const usage = process.cpuUsage();
    const micros = usage.user + usage.system;
    const pct = Math.min(99.9, (micros / 1000000) % 100);
    return pct.toFixed(1);
  }

  getMemUsage() {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    return `${rssMb.toFixed(1)}MB`;
  }

  installConsoleLogWrapper() {
    if (console._log) {
      this.originalConsoleLog = console._log;
    } else {
      this.originalConsoleLog = console.log.bind(console);
      console._log = this.originalConsoleLog;
      console.log = (...args) => {
        const line = util.format(...args);
        this.writeLog(line);
      };
    }

    if (console._warn) {
      this.originalConsoleWarn = console._warn;
    } else {
      this.originalConsoleWarn = console.warn.bind(console);
      console._warn = this.originalConsoleWarn;
      console.warn = (...args) => {
        const line = util.format(...args);
        this.writeLog(line);
      };
    }

    if (console._info) {
      this.originalConsoleInfo = console._info;
    } else {
      this.originalConsoleInfo = console.info.bind(console);
      console._info = this.originalConsoleInfo;
      console.info = (...args) => {
        const line = util.format(...args);
        this.writeLog(line);
      };
    }
  }

  uninstallConsoleLogWrapper() {
    if (console._log) {
      console.log = console._log;
      delete console._log;
    }

    if (console._warn) {
      console.warn = console._warn;
      delete console._warn;
    }

    if (console._info) {
      console.info = console._info;
      delete console._info;
    }
  }

  decodeStreamChunk(chunk, encoding) {
    if (typeof chunk === "string") {
      return chunk;
    }

    if (Buffer.isBuffer(chunk)) {
      return chunk.toString(typeof encoding === "string" ? encoding : "utf8");
    }

    return String(chunk ?? "");
  }

  sanitizeCapturedStreamText(text) {
    return stripAnsi(String(text ?? ""))
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\t/g, "    ")
      .replace(/\r/g, "");
  }

  appendHostStdoutLine(line) {
    const text = String(line ?? "");
    if (text.length === 0) {
      return;
    }

    this.writeLog(`[stdout] ${text}`);
  }

  startNativeLogTail() {
    if (!this.nativeLogPath) {
      debugLog("tail", "skip-no-native-log-path");
      return;
    }

    debugLog("tail", "open-attempt", {
      path: this.nativeLogPath,
      exists: fs.existsSync(this.nativeLogPath)
    });

    try {
      this.nativeLogFd = fs.openSync(this.nativeLogPath, "r");
      let size = -1;
      try {
        size = fs.statSync(this.nativeLogPath).size;
      } catch {
        // Ignore stat errors for debug only.
      }
      debugLog("tail", "open-success", {
        fd: this.nativeLogFd,
        initialSize: size
      });
    } catch {
      debugLog("tail", "open-failed", {
        path: this.nativeLogPath
      });
      this.nativeLogPath = null;
      return;
    }

    this.nativeLogOffset = 0;
    this.nativeLogPending = "";

    const buf = Buffer.alloc(4096);
    let tickCount = 0;
    this.nativeLogTimer = setInterval(() => {
      if (this.state.destroyed || this.nativeLogFd === null) {
        return;
      }

      tickCount += 1;

      let totalRead = 0;
      for (; ;) {
        let bytesRead;
        try {
          bytesRead = fs.readSync(this.nativeLogFd, buf, 0, buf.length, this.nativeLogOffset);
        } catch {
          break;
        }

        if (bytesRead === 0) {
          break;
        }

        this.nativeLogOffset += bytesRead;
        totalRead += bytesRead;

        const raw = buf.toString("utf8", 0, bytesRead);
        const text = this.sanitizeCapturedStreamText(raw);
        const combined = this.nativeLogPending + text;
        const rows = combined.split(/\r\n|\n|\r/g);
        this.nativeLogPending = rows.pop() ?? "";

        for (const row of rows) {
          if (row.length > 0) {
            this.appendHostStdoutLine(row);
          }
        }

        if (totalRead > 65536) {
          break;
        }
      }

      if (tickCount <= 20 || totalRead > 0) {
        debugLog("tail", "tick", {
          tick: tickCount,
          totalRead,
          offset: this.nativeLogOffset,
          pendingLen: this.nativeLogPending.length
        });
      }
    }, 100);
  }

  stopNativeLogTail() {
    if (this.nativeLogTimer) {
      clearInterval(this.nativeLogTimer);
      this.nativeLogTimer = null;
    }

    if (this.nativeLogPending && this.nativeLogPending.length > 0) {
      this.appendHostStdoutLine(this.nativeLogPending);
      this.nativeLogPending = "";
    }

    if (this.nativeLogFd !== null) {
      try { fs.closeSync(this.nativeLogFd); } catch { }
      this.nativeLogFd = null;
    }
  }

  runWithExternalStreamInterceptionSuppressed(fn) {
    this.suppressExternalStreamInterception = true;
    try {
      return fn();
    } finally {
      this.suppressExternalStreamInterception = false;
    }
  }

  captureDirectStreamText(kind, chunk, encoding) {
    const decoded = this.decodeStreamChunk(chunk, encoding);
    if (decoded.length === 0) {
      return;
    }

    const text = this.sanitizeCapturedStreamText(decoded);
    if (text.length === 0) {
      return;
    }

    const key = kind === "stderr" ? "stderrPending" : "stdoutPending";
    const combined = this[key] + text;
    const rows = combined.split(/\r\n|\n|\r/g);
    this[key] = rows.pop() ?? "";

    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }

      if (kind === "stdout") {
        this.appendHostStdoutLine(row);
      } else {
        this.writeLog(row);
      }
    }
  }

  shouldCaptureStdoutChunk(chunk, encoding) {
    if (
      this.state.destroyed ||
      this.isRendering ||
      this.suppressExternalStreamInterception ||
      !this.hasRenderedOnce
    ) {
      return false;
    }

    const text = this.decodeStreamChunk(chunk, encoding);
    if (text.length === 0) {
      return false;
    }

    if (!this.nativeLogPath && text.includes("\u001b")) {
      return false;
    }

    const sanitized = this.sanitizeCapturedStreamText(text);
    return sanitized.length > 0 || /\r|\n/.test(text);
  }

  installStdStreamCapture() {
    if (this.originalStdoutWrite || this.originalStderrWrite) {
      return;
    }

    const blessedUsesStderr = this.dedicatedTtyOutput === process.stderr;

    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = (chunk, encoding, callback) => {
      if (this.shouldCaptureStdoutChunk(chunk, encoding)) {
        this.captureDirectStreamText("stdout", chunk, encoding);
        if (typeof callback === "function") {
          callback();
        }
        return true;
      }

      return this.originalStdoutWrite(chunk, encoding, callback);
    };

    if (!blessedUsesStderr) {
      this.originalStderrWrite = process.stderr.write.bind(process.stderr);

      process.stderr.write = (chunk, encoding, callback) => {
        if (this.shouldCaptureStdoutChunk(chunk, encoding)) {
          this.captureDirectStreamText("stderr", chunk, encoding);
          if (typeof callback === "function") {
            callback();
          }
          return true;
        }

        return this.originalStderrWrite(chunk, encoding, callback);
      };
    }
  }

  uninstallStdStreamCapture() {
    if (this.stdoutPending.length > 0) {
      this.writeLog(this.stdoutPending);
      this.stdoutPending = "";
    }

    if (this.stderrPending.length > 0) {
      this.writeLog(this.stderrPending);
      this.stderrPending = "";
    }

    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }

    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }
  }

  appendToServerLog(line) {
    try {
      fs.appendFileSync(this.logPath, `${line}\n`, "utf8");
      this.logWriteErrorPrinted = false;
    } catch (error) {
      if (this.logWriteErrorPrinted) {
        return;
      }

      this.logWriteErrorPrinted = true;
      const fallbackLog = console._log || this.originalConsoleLog;
      if (typeof fallbackLog === "function") {
        try {
          fallbackLog(`Failed to append server log (${this.logPath}): ${error.message}`);
        } catch {
          // Ignore fallback log write failures.
        }
      }
    }
  }

  writeLog(line, options = {}) {
    const text = String(line ?? "");
    const cols = this.getScreenCols();
    const keepViewportStable = this.state.bufferScrollOffset > 0;
    const withTimestamp = options.timestamp === false
      ? text
      : this.state.timestampsEnabled
        ? `${this.getLogTimestamp()} ${text}`
        : text;
    const normalized = ensureAnsiResetAtEnd(withTimestamp);
    const groupId = this.nextBufferGroupId;
    this.nextBufferGroupId += 1;
    const rows = splitPhysicalRows(normalized);
    const nextEntries = rows.map((row, rowIndex) => {
      const entryId = this.nextBufferEntryId;
      this.nextBufferEntryId += 1;
      return {
        id: entryId,
        groupId,
        rowIndex,
        rowCount: rows.length,
        raw: row,
        plain: stripAnsi(row)
      };
    });

    let addedVisibleLines = 0;
    for (const entry of nextEntries) {
      this.state.buffer.push(entry);
      if (keepViewportStable) {
        addedVisibleLines += this.getVisibleLineCountForEntry(entry, cols);
      }
    }

    while (this.state.buffer.length > this.options.maxBufferLines) {
      this.state.buffer.shift();
    }

    if (keepViewportStable) {
      this.state.bufferScrollOffset = Math.max(
        0,
        this.state.bufferScrollOffset + addedVisibleLines
      );
    }

    this.appendToServerLog(normalized);

    if (!this.state.isAfk || !this.state.afkEnabled) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    if (this.state.pendingRender || this.state.destroyed) {
      return;
    }

    this.state.pendingRender = true;
    setImmediate(() => {
      this.state.pendingRender = false;
      this.render();
    });
  }

  handleKeypress(ch, key) {
    this.markActivity();

    if (!key) {
      if (typeof ch === "string" && ch.length > 0) {
        this.insertText(ch);
      }
      return;
    }

    if (key.name === "escape") {
      this.handleTitleClick();
      return;
    }

    if (key.full === "C-c") {
      this.stop();
      return;
    }

    if (key.full === "C-u") {
      this.state.input = "";
      this.state.cursor = 0;
      this.resetHistoryNavigation();
      this.scheduleRender();
      return;
    }

    if (key.name === "enter" || key.name === "return") {
      this.submitInput();
      return;
    }

    if (key.name === "left") {
      this.state.cursor = Math.max(0, this.state.cursor - 1);
      this.scheduleRender();
      return;
    }

    if (key.name === "right") {
      this.state.cursor = Math.min(this.state.input.length, this.state.cursor + 1);
      this.scheduleRender();
      return;
    }

    if (key.name === "pageup") {
      if (Date.now() - this.lastEmbeddedPageWheelAtMs <= 50) {
        mouseDebug(2, "pageup-suppressed-after-embedded-wheel");
        return;
      }
      this.scrollBufferBy(this.getPageScrollStep());
      return;
    }

    if (key.name === "pagedown") {
      if (Date.now() - this.lastEmbeddedPageWheelAtMs <= 50) {
        mouseDebug(2, "pagedown-suppressed-after-embedded-wheel");
        return;
      }
      this.scrollBufferBy(-this.getPageScrollStep());
      return;
    }

    if (key.name === "home") {
      if (this.state.input.length === 0) {
        this.scrollBufferToTop();
        return;
      }

      this.state.cursor = 0;
      this.scheduleRender();
      return;
    }

    if (key.name === "end") {
      if (this.state.input.length === 0) {
        this.scrollBufferToBottom();
        return;
      }

      this.state.cursor = this.state.input.length;
      this.scheduleRender();
      return;
    }

    if (key.name === "backspace") {
      if (this.state.cursor > 0) {
        this.state.input =
          this.state.input.slice(0, this.state.cursor - 1) +
          this.state.input.slice(this.state.cursor);
        this.state.cursor -= 1;
        this.resetHistoryNavigation();
        this.scheduleRender();
      }
      return;
    }

    if (key.name === "delete") {
      if (this.state.cursor < this.state.input.length) {
        this.state.input =
          this.state.input.slice(0, this.state.cursor) +
          this.state.input.slice(this.state.cursor + 1);
        this.resetHistoryNavigation();
        this.scheduleRender();
      }
      return;
    }

    if (key.name === "up") {
      this.navigateHistory(-1);
      return;
    }

    if (key.name === "down") {
      this.navigateHistory(1);
      return;
    }

    if (typeof ch === "string" && ch.length > 0 && !key.ctrl && !key.meta) {
      this.insertText(ch);
    }
  }

  handleMouse(data) {
    this.markActivity();

    mouseDebug(3, "event", {
      action: data && typeof data.action === "string" ? data.action : null,
      button: data && typeof data.button === "string" ? data.button : null,
      x: data && typeof data.x !== "undefined" ? data.x : null,
      y: data && typeof data.y !== "undefined" ? data.y : null,
      type: data && typeof data.type === "string" ? data.type : null,
      name: data && typeof data.name === "string" ? data.name : null
    });

    if (this.tryHandleWindowsRightClickPaste(data)) {
      mouseDebug(2, "handled-right-click-paste");
      return;
    }

    if (!data || typeof data.action !== "string") {
      if (data && typeof data.button === "string") {
        if (data.button === "wheelup") {
          mouseDebug(2, "wheel-via-button", { direction: 1 });
          this.handleWheel(1);
          return;
        }

        if (data.button === "wheeldown") {
          mouseDebug(2, "wheel-via-button", { direction: -1 });
          this.handleWheel(-1);
        }
      }

      return;
    }

    if (data.action === "wheelup" || data.action === "mousewheelup") {
      this.lastParsedWheelAtMs = Date.now();
      mouseDebug(2, "wheel-via-action", { action: data.action, direction: 1 });
      this.handleWheel(1);
      return;
    }

    if (data.action === "wheeldown" || data.action === "mousewheeldown") {
      this.lastParsedWheelAtMs = Date.now();
      mouseDebug(2, "wheel-via-action", { action: data.action, direction: -1 });
      this.handleWheel(-1);
    }
  }

  handleRawInputData(chunk) {
    if (!this.state.mouseCaptureEnabled) {
      return;
    }

    const text = Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk ?? "");
    if (text.length === 0) {
      return;
    }

    if (TTY_DEBUG_MOUSE_LEVEL >= 3 && (text.includes("\u001b") || text.includes("\u009b"))) {
      const preview = text
        .slice(0, 64)
        .replace(/\u001b/g, "<ESC>")
        .replace(/\u009b/g, "<CSI>")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
      mouseDebug(3, "raw-input-chunk", {
        len: text.length,
        preview
      });
    }

    let payload = this.rawMousePending + text;

    const sgr = /(?:\x1b\[|\x9b)<(\d+);(\d+);(\d+)([mM])/g;
    payload = payload.replace(sgr, (match, buttonRaw, xRaw, yRaw, suffix) => {
      const button = Number(buttonRaw);
      if (!Number.isFinite(button)) {
        return "";
      }

      if ((button & 64) === 0) {
        return "";
      }

      const direction = (button & 1) === 1 ? -1 : 1;
      if (Date.now() - this.lastParsedWheelAtMs <= 25) {
        mouseDebug(3, "wheel-via-raw-sgr-suppressed", { button, direction });
        return "";
      }
      mouseDebug(2, "wheel-via-raw-sgr", {
        button,
        x: Number(xRaw),
        y: Number(yRaw),
        suffix,
        direction
      });
      this.handleWheel(direction);
      return "";
    });

    const urxvt = /(?:\x1b\[|\x9b)(\d+);(\d+);(\d+)M/g;
    payload = payload.replace(urxvt, (match, buttonRaw, xRaw, yRaw) => {
      const button = Number(buttonRaw) - 32;
      if (!Number.isFinite(button) || (button & 64) === 0) {
        return "";
      }

      const direction = (button & 1) === 1 ? -1 : 1;
      if (Date.now() - this.lastParsedWheelAtMs <= 25) {
        mouseDebug(3, "wheel-via-raw-urxvt-suppressed", { button, direction });
        return "";
      }
      mouseDebug(2, "wheel-via-raw-urxvt", {
        button,
        x: Number(xRaw),
        y: Number(yRaw),
        direction
      });
      this.handleWheel(direction);
      return "";
    });

    // Some embedded Windows host chains forward wheel notches as page-up/page-down
    // key-like CSI sequences instead of mouse reports. Treat those as wheel fallback
    // only in embedding mode so wheel stays usable without breaking resize.
    if (this.nativeLogPath) {
      const pageLike = /(?:\x1b\[|\x9b)(5|6)~/g;
      payload = payload.replace(pageLike, (match, code) => {
        const direction = code === "5" ? 1 : -1;
        const now = Date.now();
        this.lastEmbeddedPageWheelAtMs = now;
        mouseDebug(2, "wheel-via-raw-page-seq", {
          sequence: match.replace(/\u001b/g, "<ESC>").replace(/\u009b/g, "<CSI>"),
          direction
        });
        this.handleWheel(direction);
        return "";
      });
    }

    let rebuilt = "";
    for (let i = 0; i < payload.length; i += 1) {
      const isEscX10 = payload[i] === "\u001b" && payload[i + 1] === "[" && payload[i + 2] === "M";
      const isCsiX10 = payload[i] === "\u009b" && payload[i + 1] === "M";

      if (isEscX10 || isCsiX10) {
        const x10Start = i + (isEscX10 ? 3 : 2);
        if (x10Start + 2 >= payload.length) {
          rebuilt += payload.slice(i);
          break;
        }

        const button = payload.charCodeAt(x10Start) - 32;
        const x = payload.charCodeAt(x10Start + 1) - 32;
        const y = payload.charCodeAt(x10Start + 2) - 32;

        if ((button & 64) !== 0) {
          const direction = (button & 1) === 1 ? -1 : 1;
          if (Date.now() - this.lastParsedWheelAtMs <= 25) {
            mouseDebug(3, "wheel-via-raw-x10-suppressed", { button, direction });
            i = x10Start + 2;
            continue;
          }
          mouseDebug(2, "wheel-via-raw-x10", { button, x, y, direction });
          this.handleWheel(direction);
        }

        i = x10Start + 2;
        continue;
      }

      rebuilt += payload[i];
    }

    this.rawMousePending = rebuilt.slice(-16);
  }

  handleWheel(direction) {
    this.markActivity();

    const beforeOffset = this.state.bufferScrollOffset;

    const step = 1;
    this.scrollBufferBy(direction * step);

    mouseDebug(1, "handleWheel", {
      direction,
      step,
      beforeOffset,
      afterOffset: this.state.bufferScrollOffset
    });
  }

  insertText(text) {
    this.state.input =
      this.state.input.slice(0, this.state.cursor) +
      text +
      this.state.input.slice(this.state.cursor);
    this.state.cursor += text.length;
    this.resetHistoryNavigation();
    this.scheduleRender();
  }

  resetHistoryNavigation() {
    this.state.historyPrefix = null;
    this.state.historyCursor = -1;
    this.state.historyMatches = [];
    this.state.historyDraft = "";
  }

  navigateHistory(direction) {
    if (this.state.historyPrefix === null) {
      this.state.historyPrefix = this.state.input;
      this.state.historyDraft = this.state.input;
      this.state.historyMatches = this.state.history.filter((entry) =>
        entry.startsWith(this.state.historyPrefix)
      );
      this.state.historyCursor = this.state.historyMatches.length;
    }

    if (this.state.historyMatches.length === 0) {
      return;
    }

    this.state.historyCursor += direction;

    if (this.state.historyCursor < 0) {
      this.state.historyCursor = 0;
    }

    if (this.state.historyCursor >= this.state.historyMatches.length) {
      this.state.historyCursor = this.state.historyMatches.length;
      this.state.input = this.state.historyDraft;
      this.state.cursor = this.state.input.length;
      this.scheduleRender();
      return;
    }

    this.state.input = this.state.historyMatches[this.state.historyCursor];
    this.state.cursor = this.state.input.length;
    this.scheduleRender();
  }

  submitInput() {
    const cmd = this.state.input.trim();
    if (cmd.length > 0) {
      this.appendHistory(cmd);
      this.writeLog(`${this.state.prompt}${cmd}`, { timestamp: false });
      this.executeCommand(cmd);
      this.emit("command", cmd);
    }

    this.state.input = "";
    this.state.cursor = 0;
    this.resetHistoryNavigation();
    this.scheduleRender();
  }

  async executeCommand(raw) {
    try {
      const output = await this.parseCommand(raw);
      if (typeof output !== "undefined" && output !== null && String(output).length > 0) {
        this.writeLog(String(output));
      }
    } catch (error) {
      this.writeLog(`Command error: ${error.message}`);
    }
  }

  async parseCommand(raw) {
    const line = String(raw ?? "").trim();
    if (line.length === 0) {
      return "";
    }

    this.tty.window_width = this.getScreenCols();
    this.tty.window_height = this.getScreenRows();

    const args = line.split(/\s+/);
    const cmd = String(args[0] ?? "").toLowerCase();

    if (!this.state.commands[cmd]) {
      return `Unknown command \`${cmd}\`. Try \`help\`.`;
    }

    const ctx = {
      app: this,
      tty: this.tty,
      state: this.state,
      writeLog: (msg) => this.writeLog(msg),
      setVariable: (name, value, persist = false) => this.setVariable(name, value, { persist }),
      unsetVariable: (name, persist = false) => this.unsetVariable(name, { persist }),
      setTitleEnabled: (enabled, persist = false) => this.setTitleEnabled(enabled, { persist }),
      setWrapEnabled: (enabled, persist = false) => this.setWrapEnabled(enabled, { persist }),
      setTimestampsEnabled: (enabled, persist = false) => this.setTimestampsEnabled(enabled, { persist }),
      setAfkTimeoutSeconds: (seconds, persist = false) =>
        this.setAfkTimeoutSeconds(seconds, { persist }),
      setAfkEnabled: (enabled, persist = false) => this.setAfkEnabled(enabled, { persist }),
      setMouseCaptureEnabled: (enabled, persist = false) =>
        this.setMouseCaptureEnabled(enabled, { persist }),
      saveConfig: () => this.saveConfig(),
      saveHistory: () => this.saveHistory(),
      stop: () => this.stop()
    };

    const result = this.state.commands[cmd](ctx, args, line);
    if (result && typeof result.then === "function") {
      return await result;
    }

    return result;
  }

  buildInputLines(cols) {
    const full = `${this.state.prompt}${this.state.input}`;
    return wrapPlain(full, cols);
  }

  buildTitleLines(cols) {
    if (!this.state.titleEnabled) {
      return [];
    }

    const title = this.getTitleLine();
    return wrapPlain(title, cols);
  }

  getScreenCols() {
    const screenWidth = this.screen && Number.isFinite(this.screen.width)
      ? this.screen.width
      : 0;
    const ttyWidth = this.dedicatedTtyOutput && Number.isFinite(this.dedicatedTtyOutput.columns)
      ? this.dedicatedTtyOutput.columns
      : 0;
    const stdoutWidth = process.stdout && Number.isFinite(process.stdout.columns)
      ? process.stdout.columns
      : 0;
    return Math.max(1, screenWidth || ttyWidth || stdoutWidth || 80);
  }

  getScreenRows() {
    const screenHeight = this.screen && Number.isFinite(this.screen.height)
      ? this.screen.height
      : 0;
    const ttyHeight = this.dedicatedTtyOutput && Number.isFinite(this.dedicatedTtyOutput.rows)
      ? this.dedicatedTtyOutput.rows
      : 0;
    const stdoutHeight = process.stdout && Number.isFinite(process.stdout.rows)
      ? process.stdout.rows
      : 0;
    return Math.max(1, screenHeight || ttyHeight || stdoutHeight || 24);
  }

  getVisibleLineCountForEntry(entry, cols) {
    if (!entry) {
      return 0;
    }

    if (!this.state.wrapEnabled) {
      return 1;
    }

    const display = typeof entry.raw === "string" ? entry.raw : entry.plain;
    return wrapDisplayRow(display, cols, hasAnsi(display)).length;
  }

  buildDisplayLineRecordsForEntry(entry, cols) {
    const display = typeof entry.raw === "string" ? entry.raw : entry.plain;
    const parentEntryId = Number.isFinite(entry?.id) ? entry.id : null;
    const groupId = Number.isFinite(entry?.groupId) ? entry.groupId : null;
    const rowIndex = Number.isFinite(entry?.rowIndex) ? entry.rowIndex : null;
    const rowCount = Number.isFinite(entry?.rowCount) ? entry.rowCount : null;

    if (!this.state.wrapEnabled) {
      const visibleRow = wrapDisplayRow(display, cols, hasAnsi(display))[0] ?? "";
      return [{
        text: visibleRow,
        fullText: display,
        parentEntryId,
        groupId,
        rowIndex,
        rowCount,
        softWrapIndex: 0,
        softWrapCount: 1,
        previousSoftWrapLineId: null,
        nextSoftWrapLineId: null,
        isSoftWrappedContinuation: false
      }];
    }

    const wrappedLines = wrapDisplayRow(display, cols, hasAnsi(display));
    const softWrapCount = wrappedLines.length;

    return wrappedLines.map((line, softWrapIndex) => {
      const selfId = parentEntryId === null
        ? null
        : `${parentEntryId}:${softWrapIndex}`;

      return {
        text: line,
        parentEntryId,
        groupId,
        rowIndex,
        rowCount,
        softWrapIndex,
        softWrapCount,
        previousSoftWrapLineId: softWrapIndex > 0 && parentEntryId !== null
          ? `${parentEntryId}:${softWrapIndex - 1}`
          : null,
        nextSoftWrapLineId: softWrapIndex < softWrapCount - 1 && parentEntryId !== null
          ? `${parentEntryId}:${softWrapIndex + 1}`
          : null,
        isSoftWrappedContinuation: softWrapIndex > 0,
        lineId: selfId
      };
    });
  }

  buildDisplayLinesForEntry(entry, cols) {
    return this.buildDisplayLineRecordsForEntry(entry, cols).map((record) => record.text);
  }

  buildBufferLineRecords(cols) {
    const records = [];

    for (const entry of this.state.buffer) {
      records.push(...this.buildDisplayLineRecordsForEntry(entry, cols));
    }

    return records;
  }

  buildBufferViewportRecords(cols, rows, scrollOffset = 0) {
    if (rows <= 0) {
      return [];
    }

    const allLineRecords = this.buildBufferLineRecords(cols);
    const maxOffset = Math.max(0, allLineRecords.length - rows);
    const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset));
    const start = Math.max(0, allLineRecords.length - rows - clampedOffset);
    const out = allLineRecords.slice(start, start + rows);

    while (out.length < rows) {
      out.unshift({
        text: "",
        parentEntryId: null,
        groupId: null,
        rowIndex: null,
        rowCount: null,
        softWrapIndex: 0,
        softWrapCount: 1,
        previousSoftWrapLineId: null,
        nextSoftWrapLineId: null,
        isSoftWrappedContinuation: false,
        lineId: null
      });
    }

    return out;
  }

  buildBufferLines(cols) {
    return this.buildBufferLineRecords(cols).map((record) => record.text);
  }

  getBufferRenderContext() {
    const cols = this.getScreenCols();
    const rows = this.getScreenRows();
    const titleLines = this.buildTitleLines(cols);
    const inputLines = this.buildInputLines(cols);
    const titleHeight = titleLines.length;
    const inputHeight = Math.min(inputLines.length, rows);
    const showBuffer = !(this.state.afkEnabled && this.state.isAfk);
    const bufferRows = Math.max(0, rows - titleHeight - inputHeight);

    return {
      cols,
      rows,
      titleLines,
      inputLines,
      titleHeight,
      inputHeight,
      bufferRows,
      showBuffer
    };
  }

  getMaxBufferScrollOffset(cols, bufferRows) {
    if (bufferRows <= 0) {
      return 0;
    }

    const totalBufferLines = this.buildBufferLines(cols).length;
    return Math.max(0, totalBufferLines - bufferRows);
  }

  setBufferScrollOffset(nextOffset, cols, bufferRows) {
    const maxOffset = this.getMaxBufferScrollOffset(cols, bufferRows);
    const clamped = Math.max(0, Math.min(maxOffset, nextOffset));

    if (clamped === this.state.bufferScrollOffset) {
      return false;
    }

    this.state.bufferScrollOffset = clamped;
    return true;
  }

  getPageScrollStep() {
    const { bufferRows } = this.getBufferRenderContext();
    return Math.max(1, bufferRows - 1);
  }

  scrollBufferBy(delta) {
    const { cols, bufferRows } = this.getBufferRenderContext();
    if (bufferRows <= 0) {
      mouseDebug(2, "scroll-skip-no-buffer-rows", { delta, cols, bufferRows });
      return;
    }

    const beforeOffset = this.state.bufferScrollOffset;
    if (this.setBufferScrollOffset(this.state.bufferScrollOffset + delta, cols, bufferRows)) {
      mouseDebug(2, "scroll-applied", {
        delta,
        cols,
        bufferRows,
        beforeOffset,
        afterOffset: this.state.bufferScrollOffset
      });
      this.scheduleRender();
      return;
    }

    mouseDebug(2, "scroll-no-change", {
      delta,
      cols,
      bufferRows,
      offset: this.state.bufferScrollOffset
    });
  }

  scrollBufferToTop() {
    const { cols, bufferRows } = this.getBufferRenderContext();
    if (bufferRows <= 0) {
      return;
    }

    if (this.setBufferScrollOffset(Number.MAX_SAFE_INTEGER, cols, bufferRows)) {
      this.scheduleRender();
    }
  }

  scrollBufferToBottom() {
    if (this.state.bufferScrollOffset !== 0) {
      this.state.bufferScrollOffset = 0;
      this.scheduleRender();
    }
  }

  buildBufferViewport(cols, rows, scrollOffset = 0) {
    return this.buildBufferViewportRecords(cols, rows, scrollOffset).map((record) => record.text);
  }

  moveCursor(rows, cols, inputLines) {
    if (rows <= 0 || cols <= 0) {
      return;
    }

    const absolute = this.state.prompt.length + this.state.cursor;
    const line = Math.floor(absolute / cols);
    const col = absolute % cols;

    const inputHeight = inputLines.length;
    const startRow = Math.max(0, rows - inputHeight);
    const row = Math.min(rows - 1, startRow + line);

    this.screen.program.showCursor();
    this.screen.program.cup(row, col);
  }

  render() {
    if (
      this.state.destroyed ||
      !this.screen ||
      !this.titleBox ||
      !this.bufferBox ||
      !this.inputBox
    ) {
      return;
    }

    const {
      cols,
      rows,
      titleLines,
      inputLines,
      titleHeight,
      inputHeight,
      bufferRows,
      showBuffer
    } = this.getBufferRenderContext();

    this.setBufferScrollOffset(this.state.bufferScrollOffset, cols, bufferRows);

    this.titleBox.hidden = titleHeight === 0;
    if (titleHeight > 0) {
      this.titleBox.top = 0;
      this.titleBox.height = titleHeight;
      this.titleBox.setContent(titleLines.map((line) => padToWidth(line, cols)).join("\n"));
    }

    this.bufferBox.hidden = bufferRows === 0;
    if (bufferRows > 0) {
      const bufferLines = showBuffer
        ? this.buildBufferViewport(cols, bufferRows, this.state.bufferScrollOffset)
        : Array.from({ length: bufferRows }, () => "");
      this.bufferBox.top = titleHeight;
      this.bufferBox.height = bufferRows;
      this.bufferBox.setContent(bufferLines.map((line) => padToWidth(line, cols)).join("\n"));
    }

    this.inputBox.top = rows - inputHeight;
    this.inputBox.height = inputHeight;
    this.inputBox.setContent(inputLines.map((line) => padToWidth(line, cols)).join("\n"));

    this.isRendering = true;
    try {
      this.screen.render();
      this.hasRenderedOnce = true;
      this.moveCursor(rows, cols, inputLines);
    } finally {
      this.isRendering = false;
    }
  }
}

function createConsole(options) {
  return new Console(options);
}

module.exports = {
  createConsole,
  Console
};

function loadConfigFile() {
  const candidates = [
    path.join(process.cwd(), "console_config.json"),
    path.join(__dirname, "console_config.json")
  ];

  debugLog("launcher", "config-candidates", { candidates });

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        debugLog("launcher", "config-missing", { candidate });
        continue;
      }

      const data = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        debugLog("launcher", "config-loaded", { candidate });
        return parsed;
      }
    } catch {
      debugLog("launcher", "config-read-failed", { candidate });
      // Ignore parse errors, try next candidate.
    }
  }

  debugLog("launcher", "config-fallback-empty");
  return {};
}

function resolveExecutable(name) {
  if (path.isAbsolute(name)) {
    return fs.existsSync(name) ? name : null;
  }

  const fromCwd = path.resolve(process.cwd(), name);
  if (fs.existsSync(fromCwd)) {
    return fromCwd;
  }

  const fromDir = path.resolve(__dirname, name);
  if (fs.existsSync(fromDir)) {
    return fromDir;
  }

  return null;
}

function launchEmbeddedHost() {
  if (process.env.EMBEDDED_NATIVE_LOG) {
    debugLog("launcher", "skip-already-embedded", {
      nativeLogPath: process.env.EMBEDDED_NATIVE_LOG
    });
    return false;
  }

  const config = loadConfigFile();
  const exe = typeof config.embeddingExecutable === "string"
    ? config.embeddingExecutable.trim()
    : "";

  if (exe.length === 0) {
    debugLog("launcher", "skip-no-embedding-executable");
    return false;
  }

  const exePath = resolveExecutable(exe);
  if (!exePath) {
    debugLog("launcher", "executable-not-found", { exe });
    process.stderr.write(`[tty-launcher] Executable not found: ${exe}\n`);
    process.exit(1);
  }

  debugLog("launcher", "resolved-executable", {
    exe,
    exePath,
    spawnCwd: path.dirname(exePath),
    cwd: process.cwd()
  });

  const logPrefix = path.parse(exePath).name;
  const logName = `${logPrefix}_stdout.log`;
  const logPath = path.join(path.dirname(exePath), logName);

  // Create the empty log file so the embedded console can open it for tailing
  // immediately, even before any native output arrives.
  fs.writeFileSync(logPath, "", "utf8");
  debugLog("launcher", "native-log-created", {
    logPath,
    exists: fs.existsSync(logPath)
  });

  const env = { ...process.env, EMBEDDED_NATIVE_LOG: logPath };
  debugLog("launcher", "spawn-env", {
    nativeLogPath: env.EMBEDDED_NATIVE_LOG,
    stdinIsTTY: Boolean(process.stdin && process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout && process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr && process.stderr.isTTY)
  });

  // Use "pipe" for stdin so the launcher can relay raw terminal input
  // (including mouse sequences) that the host EXE would otherwise filter.
  // Use "pipe" for stdout to capture native output to the log file.
  // Keep stderr inherited so blessed can render to the real terminal.
  const child = childProcess.spawn(exePath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
    cwd: path.dirname(exePath)
  });
  debugLog("launcher", "spawn-called", { pid: child.pid || null });

  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  child.stdout.pipe(logStream);

  // Relay terminal stdin to child so raw VT mouse sequences reach the
  // embedded runtime. The host EXE filters mouse input when it reads
  // from the console directly, but passes pipe data through.
  if (process.stdin && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      debugLog("launcher", "stdin-setRawMode-failed", { message: err.message });
    }
  }
  if (process.stdin && typeof process.stdin.on === "function") {
    process.stdin.resume();
    const onParentStdinData = (chunk) => {
      if (!child.killed && child.stdin && child.stdin.writable) {
        const ok = child.stdin.write(chunk);
        if (!ok) {
          process.stdin.pause();
          child.stdin.once("drain", () => {
            if (!child.killed) process.stdin.resume();
          });
        }
      }
    };
    process.stdin.on("data", onParentStdinData);
    child.on("exit", () => {
      try { process.stdin.removeListener("data", onParentStdinData); } catch {}
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
    });
  }

  let exitingViaSignal = false;
  let cleanupStarted = false;
  let cleanupFinished = false;
  const cleanupCallbacks = [];

  const completeCleanup = () => {
    if (cleanupFinished) {
      return;
    }

    cleanupFinished = true;
    while (cleanupCallbacks.length > 0) {
      const callback = cleanupCallbacks.shift();
      try {
        callback();
      } catch {
        // Ignore cleanup callback errors.
      }
    }
  };

  const removeLogWithRetry = (attempt = 0) => {
    try {
      fs.unlinkSync(logPath);
      debugLog("launcher", "cleanup-log-deleted", { logPath, attempt });
      completeCleanup();
      return;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        completeCleanup();
        return;
      }

      const retriable = error && (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES");
      if (retriable && attempt < 20) {
        setTimeout(() => removeLogWithRetry(attempt + 1), 100);
        return;
      }

      debugLog("launcher", "cleanup-log-delete-failed", {
        logPath,
        attempt,
        code: error && error.code,
        message: error && error.message
      });
      completeCleanup();
    }
  };

  const cleanup = (onDone) => {
    if (typeof onDone === "function") {
      cleanupCallbacks.push(onDone);
    }

    if (cleanupFinished) {
      completeCleanup();
      return;
    }

    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;

    debugLog("launcher", "cleanup", {
      logPath,
      existsBeforeDelete: fs.existsSync(logPath)
    });

    try {
      child.stdout.unpipe(logStream);
    } catch {
      // Ignore unpipe errors.
    }

    const finalizeDelete = () => {
      removeLogWithRetry(0);
    };

    let streamClosed = false;
    logStream.once("close", () => {
      streamClosed = true;
      finalizeDelete();
    });

    try {
      logStream.end();
    } catch {
      // Ignore stream end errors.
    }

    setTimeout(() => {
      if (!streamClosed) {
        try {
          logStream.destroy();
        } catch {
          // Ignore stream destroy errors.
        }
        finalizeDelete();
      }
    }, 500).unref();
  };

  const exitAfterCleanup = (code) => {
    cleanup(() => {
      process.exit(code);
    });
  };

  const handleSignal = (signal) => {
    if (exitingViaSignal) {
      return;
    }

    exitingViaSignal = true;
    debugLog("launcher", "signal", { signal, childPid: child.pid || null });

    try {
      if (!child.killed) {
        child.kill(signal);
      }
    } catch {
      // Ignore child kill errors.
    }

    exitAfterCleanup(130);
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  child.stdout.on("data", (chunk) => {
    debugLog("launcher", "child-stdout", {
      bytes: Buffer.isBuffer(chunk) ? chunk.length : String(chunk ?? "").length
    });
  });

  child.on("spawn", () => {
    debugLog("launcher", "child-spawn", { pid: child.pid || null });
  });

  child.on("exit", (code, signal) => {
    debugLog("launcher", "child-exit", { code, signal });
  });

  child.on("close", (code) => {
    debugLog("launcher", "child-close", { code });
    exitAfterCleanup(code ?? 1);
  });

  child.on("error", (err) => {
    debugLog("launcher", "child-error", { message: err.message });
    process.stderr.write(`[tty-launcher] Failed to start ${exe}: ${err.message}\n`);
    exitAfterCleanup(1);
  });

  return true;
}

if (require.main === module) {
  if (!launchEmbeddedHost()) {
    const tty = createConsole({
      titleEnabled: true,
      wordWrapEnabled: true
    }).start();

    globalThis.tty = tty.tty;
  }
}
