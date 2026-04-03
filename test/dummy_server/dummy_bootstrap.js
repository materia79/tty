"use strict";

const path = require("path");
const { createConsole } = require(path.join(__dirname, "..", "index.js"));

const ui = createConsole({
  titleEnabled: true,
  wordWrapEnabled: true,
  configPath: path.join(process.cwd(), "console_config.json"),
  historyPath: path.join(process.cwd(), "console_history.json"),
  commandsDir: path.join(process.cwd(), "commands"),
  exitOnStop: false
}).start();

globalThis.tty = ui.tty;

function shutdown() {
  try {
    if (ui && typeof ui.stop === "function") {
      ui.stop();
    }
  } catch (err) {
    process.stderr.write(`[dummy-bootstrap] shutdown warning: ${err.message}\n`);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
