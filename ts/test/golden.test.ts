// The shared golden test for the first text block: the same shape gives the same first sentence
// in the TypeScript and Python kits (ALIGN.md, change n). The fixtures are in test/golden/
// first-sentence.json; the Python kit is to read the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderText, type WriteResult, type TextOptions } from "../src/index.js";

const cases = JSON.parse(readFileSync(new URL("../../test/golden/first-sentence.json", import.meta.url), "utf8")) as Array<{ name: string; shape: WriteResult; options: TextOptions; text: string }>;

for (const c of cases) {
  test(`golden first sentence: ${c.name}`, () => {
    assert.equal(renderText(c.shape, c.options), c.text);
  });
}
