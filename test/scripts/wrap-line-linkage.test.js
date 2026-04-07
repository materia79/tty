"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Console } = require("../../index");

function visibleLength(text) {
  return String(text ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").length;
}

function createConsole() {
  const consoleRuntime = new Console({ commandsDir: "./commands" });
  consoleRuntime.setTimestampsEnabled(false);
  return consoleRuntime;
}

test("no-wrap stores full logical row and renders clipped row", () => {
  const consoleRuntime = createConsole();
  const longLine = "L".repeat(120);

  consoleRuntime.setWrapEnabled(false);
  consoleRuntime.writeLog(longLine, { timestamp: false });

  const record = consoleRuntime.buildBufferLineRecords(40).at(-1);
  assert.ok(record);
  assert.equal(record.text, longLine.slice(0, 40));
  assert.equal(visibleLength(record.text), 40);
  assert.equal(record.fullText, longLine);
  assert.equal(consoleRuntime.buildBufferViewport(40, 5, 0).at(-1), longLine.slice(0, 40));
});

test("wrap mode produces linked soft-wrap fragments", () => {
  const consoleRuntime = createConsole();
  const longLine = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(5);

  consoleRuntime.setWrapEnabled(true);
  consoleRuntime.writeLog(longLine, { timestamp: false });

  const records = consoleRuntime.buildBufferLineRecords(30);
  const parentEntryId = records.at(-1)?.parentEntryId;
  const fragments = records.filter((record) => record.parentEntryId === parentEntryId);

  assert.ok(fragments.length > 1);

  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    assert.equal(fragment.softWrapIndex, index);
    assert.equal(fragment.softWrapCount, fragments.length);

    if (index === 0) {
      assert.equal(fragment.previousSoftWrapLineId, null);
    } else {
      assert.equal(fragment.previousSoftWrapLineId, `${parentEntryId}:${index - 1}`);
    }

    if (index === fragments.length - 1) {
      assert.equal(fragment.nextSoftWrapLineId, null);
    } else {
      assert.equal(fragment.nextSoftWrapLineId, `${parentEntryId}:${index + 1}`);
    }
  }
});

test("toggling wrap off collapses to one visible row but preserves fullText", () => {
  const consoleRuntime = createConsole();
  const longLine = "0123456789".repeat(18);

  consoleRuntime.setWrapEnabled(true);
  consoleRuntime.writeLog(longLine, { timestamp: false });

  const recordsWrapOn = consoleRuntime.buildBufferLineRecords(20);
  const parentEntryId = recordsWrapOn.at(-1)?.parentEntryId;
  const wrapOnFragments = recordsWrapOn.filter((record) => record.parentEntryId === parentEntryId);
  assert.ok(wrapOnFragments.length > 1);

  consoleRuntime.setWrapEnabled(false);
  const recordsWrapOff = consoleRuntime.buildBufferLineRecords(20);
  const wrapOffFragments = recordsWrapOff.filter((record) => record.parentEntryId === parentEntryId);

  assert.equal(wrapOffFragments.length, 1);
  assert.equal(wrapOffFragments[0].text, longLine.slice(0, 20));
  assert.equal(wrapOffFragments[0].fullText, longLine);
});
