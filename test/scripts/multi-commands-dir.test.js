"use strict";

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { Console } = require("../../index");

const builtinDir = path.join(__dirname, "..", "..", "commands");
const extraDir = path.join(__dirname, "extra_commands");
const nonExistentDir = path.join(__dirname, "no_such_dir");

test("string commandsDir loads a single directory (backward compat)", () => {
  const c = new Console({ commandsDir: builtinDir });
  assert.ok(c.state.commands.help, "built-in help command should be loaded");
  assert.ok(c.state.commands.cls, "built-in cls command should be loaded");
  assert.strictEqual(c.state.commands.ping, undefined, "extra ping should not exist");
});

test("array commandsDir loads commands from all listed directories", () => {
  const c = new Console({ commandsDir: [builtinDir, extraDir] });
  assert.ok(c.state.commands.cls, "built-in cls should be present");
  assert.ok(c.state.commands.ping, "extra ping should be loaded");
  assert.strictEqual(c.state.commands.ping({}, [], "ping"), "pong");
});

test("later directory overrides earlier command with same name", () => {
  const c = new Console({ commandsDir: [builtinDir, extraDir] });
  const result = c.state.commands.help({}, [], "help");
  assert.strictEqual(result, "custom help output");
});

test("later directory override replaces help text too", () => {
  const c = new Console({ commandsDir: [builtinDir, extraDir] });
  assert.match(c.state.helpText, /custom help override/);
});

test("non-existent directories in array are silently skipped", () => {
  const c = new Console({ commandsDir: [nonExistentDir, builtinDir] });
  assert.ok(c.state.commands.help, "commands from valid directory still load");
});

test("all non-existent directories produces fallback help text", () => {
  const c = new Console({ commandsDir: [nonExistentDir] });
  assert.strictEqual(c.state.helpText, "No commands directory found.");
  assert.deepStrictEqual(c.state.commands, {});
});
