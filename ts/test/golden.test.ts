// The shared golden test for the first text block: the same shape gives the same first sentence
// in the TypeScript and Python kits (ALIGN.md, change n). The fixtures are in test/golden/
// first-sentence.json. The Python kit's tests/golden/first-sentence.json and the spec's
// spec/shapes/first-sentence.json are the same bytes, pinned here and in the Python kit by sha256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderText, type WriteResult, type TextOptions } from "../src/index.js";

/** sha256 of test/golden/first-sentence.json, the Python kit's copy and the spec's spec/shapes copy. */
const PINNED_SHA256 = "5d6f8d965b3e21e148c3a31dea1af458c90892a68c274f33ce489d724d5d8326";

const bytes = readFileSync(new URL("../../test/golden/first-sentence.json", import.meta.url));
const cases = JSON.parse(bytes.toString("utf8")) as Array<{ name: string; shape: WriteResult; options: TextOptions; text: string }>;

test("the golden file has the pinned sha256", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PINNED_SHA256);
});

for (const c of cases) {
  test(`golden first sentence: ${c.name}`, () => {
    assert.equal(renderText(c.shape, c.options), c.text);
  });
}
