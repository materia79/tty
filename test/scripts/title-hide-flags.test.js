"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Console } = require("../../index");

function createConsoleWithFlags(flags = {}) {
  return new Console({ commandsDir: "./commands", ...flags });
}

test("default title contains all segments", () => {
  const c = createConsoleWithFlags();
  c.setVariable("title", "test-title");
  const title = c.getTitleLine();

  assert.match(title, /up:/);
  assert.match(title, /CPU:/);
  assert.match(title, /Mem:/);
  assert.match(title, /state:/);
  assert.match(title, /mouse:/);
  assert.match(title, /test-title/);
});

test("hideTitleName removes title name but keeps everything else", () => {
  const c = createConsoleWithFlags({ hideTitleName: true });
  c.setVariable("title", "test-title");
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /test-title/);
  assert.match(title, /up:/);
  assert.match(title, /CPU:/);
  assert.match(title, /Mem:/);
  assert.match(title, /state:/);
  assert.match(title, /mouse:/);
});

test("hideTitleUptime removes uptime segment", () => {
  const c = createConsoleWithFlags({ hideTitleUptime: true });
  c.setVariable("title", "test-title");
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /up:/);
  assert.match(title, /CPU:/);
  assert.match(title, /test-title/);
});

test("hideTitleCPU removes CPU segment", () => {
  const c = createConsoleWithFlags({ hideTitleCPU: true });
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /CPU:/);
  assert.match(title, /up:/);
  assert.match(title, /Mem:/);
});

test("hideTitleMem removes Mem segment", () => {
  const c = createConsoleWithFlags({ hideTitleMem: true });
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /Mem:/);
  assert.match(title, /CPU:/);
});

test("hideTitleAfk removes state segment", () => {
  const c = createConsoleWithFlags({ hideTitleAfk: true });
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /state:/);
  assert.match(title, /mouse:/);
});

test("hideTitleMouse removes mouse segment", () => {
  const c = createConsoleWithFlags({ hideTitleMouse: true });
  const title = c.getTitleLine();

  assert.doesNotMatch(title, /mouse:/);
  assert.match(title, /state:/);
});

test("all hideTitle flags together leave only spinner", () => {
  const c = createConsoleWithFlags({
    hideTitleName: true,
    hideTitleUptime: true,
    hideTitleCPU: true,
    hideTitleMem: true,
    hideTitleAfk: true,
    hideTitleMouse: true
  });
  const title = c.getTitleLine();

  assert.match(title, /^\[.\]$/);
});
