// The write-result 0.1 schema file is one set of bytes across the spec and both kits. It is generated
// from src/schema.ts (JSON.stringify with a 2-space indent and a final newline) and pinned here by
// its sha256, which the Python kit's test pins too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { WRITE_RESULT_SCHEMA } from "../src/index.js";

/** sha256 of schema/write-result-0.1.schema.json, the spec's spec/shapes copy and the Python kit's copy. */
const PINNED_SHA256 = "8929b0cf56936ba591204ffe0b0960ede0230648180c5e5458956f80ed53f730";

const bytes = readFileSync(new URL("../../schema/write-result-0.1.schema.json", import.meta.url));

test("the schema file has the pinned sha256", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PINNED_SHA256);
});

test("the schema file is generated from src/schema.ts, byte for byte", () => {
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(WRITE_RESULT_SCHEMA, null, 2)}\n`);
});
