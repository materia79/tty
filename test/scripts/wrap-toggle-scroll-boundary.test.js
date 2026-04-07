"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Console } = require("../../index");

function createConsole() {
  const consoleRuntime = new Console({ commandsDir: "./commands" });
  consoleRuntime.setTimestampsEnabled(false);
  return consoleRuntime;
}

test("toggle wrap keeps end-boundary and bottom-follow behavior", () => {
  const consoleRuntime = createConsole();

  for (let i = 0; i < 120; i += 1) {
    consoleRuntime.writeLog(`row-${i} ${"R".repeat(120)}`, { timestamp: false });
  }

  const cols = 50;
  const rows = 18;

  consoleRuntime.setWrapEnabled(true);
  const maxOn = consoleRuntime.getMaxBufferScrollOffset(cols, rows);
  assert.ok(maxOn > 0);

  consoleRuntime.setBufferScrollOffset(maxOn, cols, rows);
  assert.equal(consoleRuntime.state.bufferScrollOffset, maxOn);

  consoleRuntime.setWrapEnabled(false);
  consoleRuntime.setBufferScrollOffset(consoleRuntime.state.bufferScrollOffset, cols, rows);

  const maxOff = consoleRuntime.getMaxBufferScrollOffset(cols, rows);
  assert.ok(maxOff >= 0);
  assert.ok(consoleRuntime.state.bufferScrollOffset <= maxOff);

  consoleRuntime.scrollBufferToBottom();
  assert.equal(consoleRuntime.state.bufferScrollOffset, 0);

  consoleRuntime.writeLog("tail-row", { timestamp: false });
  assert.equal(consoleRuntime.state.bufferScrollOffset, 0);

  consoleRuntime.setBufferScrollOffset(Math.min(50, consoleRuntime.getMaxBufferScrollOffset(cols, rows)), cols, rows);
  const before = consoleRuntime.state.bufferScrollOffset;
  consoleRuntime.writeLog("tail-while-scrolled", { timestamp: false });
  assert.equal(consoleRuntime.state.bufferScrollOffset, before + 1);
});

test("no-wrap can still page down all the way to bottom", () => {
  const consoleRuntime = createConsole();

  for (let i = 0; i < 200; i += 1) {
    consoleRuntime.writeLog(`line-${i} ${"X".repeat(120)}`, { timestamp: false });
  }

  const cols = 40;
  const rows = 20;
  const top = consoleRuntime.getMaxBufferScrollOffset(cols, rows);

  consoleRuntime.setWrapEnabled(false);
  consoleRuntime.setBufferScrollOffset(top, cols, rows);

  for (let i = 0; i < 200; i += 1) {
    consoleRuntime.scrollBufferBy(-19);
  }

  assert.equal(consoleRuntime.state.bufferScrollOffset, 0);
});
