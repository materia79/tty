"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Console } = require("../../index");

function createConsole() {
  return new Console({ commandsDir: "./commands" });
}

test("physical newlines are stored as separate buffer rows", () => {
  const consoleRuntime = createConsole();
  consoleRuntime.setTimestampsEnabled(false);
  consoleRuntime.setWrapEnabled(false);

  consoleRuntime.writeLog("Built-in commands:\nhelp\nexit", { timestamp: false });

  assert.deepEqual(consoleRuntime.buildBufferLines(120).slice(-3), [
    "Built-in commands:",
    "help",
    "exit"
  ]);
});

test("blank rows are preserved and timestamp stays on first row", () => {
  const consoleRuntime = createConsole();
  consoleRuntime.setTimestampsEnabled(true);
  consoleRuntime.setWrapEnabled(false);

  consoleRuntime.writeLog("alpha\n\nbeta");

  const rows = consoleRuntime.state.buffer.slice(-3).map((entry) => entry.raw);

  assert.match(rows[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(\d+\.\d{2}\) alpha$/);
  assert.equal(rows[1], "");
  assert.equal(rows[2], "beta");
});
