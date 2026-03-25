"use strict";

const blessed = require("neo-blessed");
const util = require("node:util");
const EventEmitter = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_TITLE_NAME = "node-server";
const CONFIG_SAVE_DEBOUNCE_MS = 250;
const DEFAULT_AFK_TIMEOUT_SECONDS = 300;

function normalizeAfkTimeoutSeconds(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		return DEFAULT_AFK_TIMEOUT_SECONDS;
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

		this.configPath = options.configPath ?? path.join(__dirname, "console_config.json");
		this.historyPath = options.historyPath ?? path.join(__dirname, "console_history.json");
		this.commandsDir = options.commandsDir ?? path.join(__dirname, "commands");
		this.maxHistoryEntries = options.maxHistoryEntries ?? 1000;
		this.exitOnStop = options.exitOnStop ?? true;
		const persistedConfig = this.loadConfig();
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
			)
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
		this.originalConsoleLog = null;
		this.boundKeypress = (ch, key) => this.handleKeypress(ch, key);
		this.boundResize = () => this.scheduleRender();
		this.boundMouse = (data) => this.handleMouse(data);
		this.boundTitleClick = () => this.handleTitleClick();
		this.boundWheelUp = () => this.handleWheel(1);
		this.boundWheelDown = () => this.handleWheel(-1);
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

		this.screen = blessed.screen({
			smartCSR: true,
			fullUnicode: true,
			dockBorders: true,
			autoPadding: false,
			mouse: true
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
		if (!this.screen || !this.screen.program) {
			return;
		}

		if (!this.state.mouseCaptureEnabled) {
			if (typeof this.screen.program.disableMouse === "function") {
				this.screen.program.disableMouse();
			}
			return;
		}

		this.screen.enableMouse(this.bufferBox);

		if (this.isWindowsTerminal) {
			// Avoid forcing SGR/VT mouse modes in Windows Terminal so right-click paste can keep working.
			if (typeof this.screen.program.enableMouse === "function") {
				this.screen.program.enableMouse();
			}
			return;
		}

		if (typeof this.screen.program.setMouse === "function") {
			// Prefer SGR mouse mode for Windows terminal compatibility.
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
			return;
		}

		if (typeof this.screen.program.enableMouse === "function") {
			this.screen.program.enableMouse();
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

		this.screen.on("keypress", this.boundKeypress);
		this.screen.on("resize", this.boundResize);
		this.screen.on("mouse", this.boundMouse);
		this.screen.on("wheelup", this.boundWheelUp);
		this.screen.on("wheeldown", this.boundWheelDown);
		this.titleBox.on("click", this.boundTitleClick);
		this.bufferBox.on("wheelup", this.boundWheelUp);
		this.bufferBox.on("wheeldown", this.boundWheelDown);
		this.configureMouseTracking();
		this.screen.key(["C-c"], () => this.stop());

		this.titleTimer = setInterval(() => {
			if (this.state.isAfk) {
				return;
			}

			this.state.slashState = (this.state.slashState + 1) % this.state.slashRotate.length;
			this.tty.slashState = this.state.slashState;
			this.scheduleRender();
		}, 1000);

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
				afkTimeoutSeconds: String(this.state.afkTimeoutSeconds)
			}
		};

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

		if (!fs.existsSync(this.commandsDir)) {
			this.state.helpText = "No commands directory found.";
			this.tty.commands = this.state.commands;
			this.tty.help = this.state.helpText;
			return;
		}

		const files = fs
			.readdirSync(this.commandsDir)
			.filter((name) => name.endsWith(".js"))
			.sort();

		for (const filename of files) {
			const commandName = filename.slice(0, -3).toLowerCase();
			const fullPath = path.join(this.commandsDir, filename);
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
			clearInterval(this.titleTimer);
			this.titleTimer = null;
		}

		if (this.afkTimeoutHandle) {
			clearTimeout(this.afkTimeoutHandle);
			this.afkTimeoutHandle = null;
		}

		this.flushPendingConfigSave();

		this.uninstallConsoleLogWrapper();
		if (this.screen && this.screen.program) {
			this.screen.program.showCursor();
		}
		if (this.screen) {
			this.screen.destroy();
		}
		if (this.exitOnStop) {
			process.exit(0);
		}
	}

	installDefaultTitle() {
		this.state.titleHeader.length = 0;
		this.state.titleFooter.length = 0;

		this.state.titleHeader.push(() => `[${this.state.slashRotate[this.state.slashState]}]`);
		this.state.titleHeader.push(() => {
			const configuredTitle =
				typeof this.state.variabled.title === "undefined"
					? ""
					: String(this.state.variabled.title ?? "").trim();

			return configuredTitle.length > 0 ? configuredTitle : DEFAULT_TITLE_NAME;
		});
		
		this.state.titleFooter.push(() => `${this.state.delimiter}up: ${this.getUptime()}`);
		this.state.titleFooter.push(() => `${this.state.delimiter}CPU: ${this.getCPUUsage()}%`);
		this.state.titleFooter.push(() => `${this.state.delimiter}Mem: ${this.getMemUsage()}`);
		this.state.titleFooter.push(
			() => `${this.state.delimiter}state: ${this.state.afkEnabled ? (this.state.isAfk ? "AFK" : "active") : "disabled"}`
		);
		this.state.titleFooter.push(
			() => `${this.state.delimiter}mouse: ${this.state.mouseCaptureEnabled ? "app" : "native"}`
		);
	}

	setAfkState(isAfk) {
		const next = Boolean(isAfk);
		if (next === this.state.isAfk) {
			return false;
		}

		this.state.isAfk = next;
		this.scheduleRender();
		return true;
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
			return;
		}

		this.originalConsoleLog = console.log.bind(console);
		console._log = this.originalConsoleLog;
		console.log = (...args) => {
			const line = util.format(...args);
			this.writeLog(line);
		};
	}

	uninstallConsoleLogWrapper() {
		if (console._log) {
			console.log = console._log;
			delete console._log;
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
		const nextEntry = {
			raw: normalized,
			plain: stripAnsi(normalized)
		};
		this.state.buffer.push(nextEntry);

		const addedVisibleLines = keepViewportStable
			? this.getVisibleLineCountForEntry(nextEntry, cols)
			: 0;

		while (this.state.buffer.length > this.options.maxBufferLines) {
			this.state.buffer.shift();
		}

		if (keepViewportStable) {
			this.state.bufferScrollOffset = Math.max(
				0,
				this.state.bufferScrollOffset + addedVisibleLines
			);
		}

		this.scheduleRender();
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
			this.scrollBufferBy(this.getPageScrollStep());
			return;
		}

		if (key.name === "pagedown") {
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

		// Debug helper for future mouse/menu work:
		// this.writeLog(`[mouse-debug] ${util.inspect(data, { depth: 6, breakLength: Infinity })}`, { timestamp: false });

		if (this.tryHandleWindowsRightClickPaste(data)) {
			return;
		}

		if (!data || typeof data.action !== "string") {
			if (data && typeof data.button === "string") {
				if (data.button === "wheelup") {
					this.handleWheel(1);
					return;
				}

				if (data.button === "wheeldown") {
					this.handleWheel(-1);
				}
			}

			return;
		}

		if (data.action === "wheelup" || data.action === "mousewheelup") {
			this.handleWheel(1);
			return;
		}

		if (data.action === "wheeldown" || data.action === "mousewheeldown") {
			this.handleWheel(-1);
		}
	}

	handleWheel(direction) {
		this.markActivity();

		const step = 3;
		this.scrollBufferBy(direction * step);
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
		const stdoutWidth = process.stdout && Number.isFinite(process.stdout.columns)
			? process.stdout.columns
			: 0;
		return Math.max(1, screenWidth || stdoutWidth || 80);
	}

	getScreenRows() {
		const screenHeight = this.screen && Number.isFinite(this.screen.height)
			? this.screen.height
			: 0;
		const stdoutHeight = process.stdout && Number.isFinite(process.stdout.rows)
			? process.stdout.rows
			: 0;
		return Math.max(1, screenHeight || stdoutHeight || 24);
	}

	getVisibleLineCountForEntry(entry, cols) {
		if (!entry) {
			return 0;
		}

		if (!this.state.wrapEnabled) {
			return 1;
		}

		const display = typeof entry.raw === "string" ? entry.raw : entry.plain;
		if (hasAnsi(display)) {
			return wrapAnsi(display, cols).length;
		}

		return wrapPlain(display, cols).length;
	}

	buildDisplayLinesForEntry(entry, cols) {
		const display = typeof entry.raw === "string" ? entry.raw : entry.plain;

		if (hasAnsi(display)) {
			if (this.state.wrapEnabled) {
				return wrapAnsi(display, cols);
			}

			return [wrapAnsi(display, cols)[0]];
		}

		if (this.state.wrapEnabled) {
			return wrapPlain(display, cols);
		}

		return [wrapPlain(display, cols)[0]];
	}

	buildBufferLines(cols) {
		const lines = [];

		for (const entry of this.state.buffer) {
			lines.push(...this.buildDisplayLinesForEntry(entry, cols));
		}

		return lines;
	}

	getBufferRenderContext() {
		const cols = this.getScreenCols();
		const rows = this.getScreenRows();
		const titleLines = this.buildTitleLines(cols);
		const inputLines = this.buildInputLines(cols);
		const titleHeight = titleLines.length;
		const inputHeight = Math.min(inputLines.length, rows);
		const bufferRows = Math.max(0, rows - titleHeight - inputHeight);

		return {
			cols,
			rows,
			titleLines,
			inputLines,
			titleHeight,
			inputHeight,
			bufferRows
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
			return;
		}

		if (this.setBufferScrollOffset(this.state.bufferScrollOffset + delta, cols, bufferRows)) {
			this.scheduleRender();
		}
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
		if (rows <= 0) {
			return [];
		}

		const allLines = this.buildBufferLines(cols);
		const maxOffset = Math.max(0, allLines.length - rows);
		const clampedOffset = Math.max(0, Math.min(maxOffset, scrollOffset));
		const start = Math.max(0, allLines.length - rows - clampedOffset);
		const out = allLines.slice(start, start + rows);

		while (out.length < rows) {
			out.unshift("");
		}

		return out;
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
		if (this.state.destroyed || !this.screen || !this.titleBox || !this.bufferBox || !this.inputBox) {
			return;
		}

		const {
			cols,
			rows,
			titleLines,
			inputLines,
			titleHeight,
			inputHeight,
			bufferRows
		} = this.getBufferRenderContext();

		this.setBufferScrollOffset(this.state.bufferScrollOffset, cols, bufferRows);

		this.titleBox.hidden = titleHeight === 0;
		if (titleHeight > 0) {
			this.titleBox.top = 0;
			this.titleBox.height = titleHeight;
			this.titleBox.setContent(titleLines.map((line) => padToWidth(line, cols)).join("\n"));
		}

		const bufferLines = this.buildBufferViewport(cols, bufferRows, this.state.bufferScrollOffset);
		this.bufferBox.hidden = bufferRows === 0;
		if (bufferRows > 0) {
			this.bufferBox.top = titleHeight;
			this.bufferBox.height = bufferRows;
			this.bufferBox.setContent(bufferLines.map((line) => padToWidth(line, cols)).join("\n"));
		}

		this.inputBox.top = rows - inputHeight;
		this.inputBox.height = inputHeight;
		this.inputBox.setContent(inputLines.map((line) => padToWidth(line, cols)).join("\n"));

		this.screen.render();
		this.moveCursor(rows, cols, inputLines);
	}
}

function createConsole(options) {
	return new Console(options);
}

module.exports = {
	createConsole,
	Console
};

if (require.main === module) {
	const tty = createConsole({
		titleEnabled: true,
		wordWrapEnabled: true
	}).start();

	globalThis.tty = tty.tty;
}
