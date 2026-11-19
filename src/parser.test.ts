import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parsePartialJson, PartialJsonParser, SchemaValidationError, validate, type JsonValue } from "./index.ts";

const schema = z.object({ name: z.string(), tags: z.array(z.string()) });

test("validate returns the typed value from a Zod schema", async () => {
  const value = await validate(schema, { name: "jonson", tags: ["a"] });
  const name: string = value.name;
  assert.equal(name, "jonson");
});

test("validate throws with the schema's issues", async () => {
  await assert.rejects(validate(schema, { name: 1 }), SchemaValidationError);
});

test("parsePartialJson returns the part of the value received so far", () => {
  const cases: [string, JsonValue | undefined][] = [
    ["", undefined],
    ["  \n", undefined],
    ["{", {}],
    ['{"na', {}],
    ['{"name"', {}],
    ['{"name":', {}],
    ['{"name": "jo', { name: "jo" }],
    ['{"name": "jonson", "tags": ["a", "b', { name: "jonson", tags: ["a", "b"] }],
    ['{"n": 12', {}],
    ['{"n": 12,', { n: 12 }],
    ['{"n": -1.5e3}', { n: -1500 }],
    ["[1, 2", [1]],
    ["[true, fa", [true, false]],
    ['{"a": [{"b": nu', { a: [{ b: null }] }],
    ["[[], {}, [", [[], {}, []]],
    ['"ab\\', "ab"],
    ['"ab\\n', "ab\n"],
    ['"ab\\u00', "ab"],
    ['"ab\\u00e9', "abé"],
    ['"\\ud83c', ""],
    ['"\\ud83c\\udf63', "🍣"],
    ['"\ud83c', ""],
    ["12", undefined],
    ["12 ", 12],
    ["nul", null],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(parsePartialJson(text), expected, `input: ${JSON.stringify(text)}`);
  }
});

test("every prefix of a document is consistent with the final value", () => {
  const text = JSON.stringify(
    {
      name: 'jon "son"\n',
      tags: ["a", "b", ""],
      nested: { n: -12.5e-3, big: 1234567, zero: 0, ok: true, no: false, nil: null, empty: {}, list: [] },
      emoji: "🍣寿司",
      matrix: [[1, 2], [3, [4, { deep: "x" }]]],
    },
    null,
    2,
  ).replace("🍣", "\\ud83c\\udf63");
  const full = JSON.parse(text) as JsonValue;
  for (let end = 0; end <= text.length; end++) {
    const prefix = text.slice(0, end);
    const partial = parsePartialJson(prefix);
    assert.ok(isPartialOf(partial, full), `prefix ${JSON.stringify(prefix)} gave ${JSON.stringify(partial)}`);
  }
  assert.deepEqual(parsePartialJson(text), full);
});

test("parsePartialJson throws SyntaxError when the text cannot start a JSON document", () => {
  for (const text of ['{"a" 1', "[1,]", '{"a": 1,}', "{} x", "tx", "[01", "[1.e", "[-]", '"a\\x', '"\\u12g', '"a\tb"', "{a", "'a'"]) {
    assert.throws(() => parsePartialJson(text), SyntaxError, `input: ${JSON.stringify(text)}`);
  }
});

test("a __proto__ key becomes an own property, as with JSON.parse", () => {
  const text = '{"__proto__": {"polluted": true}}';
  const value = parsePartialJson(text);
  assert.deepEqual(value, JSON.parse(text));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

test("pushing chunks resumes from the saved state and matches parsing the joined text", () => {
  const text = '{"name": "jo\\u00e9n \\"x\\"", "tags": ["a", "\\ud83c\\udf63", "🍣"], "n": -12.5e-3, "ok": true, "nil": null, "e": [{}]}';
  for (const size of [1, 2, 3, 5, 8]) {
    const parser = new PartialJsonParser();
    for (let end = size; end < text.length + size; end += size) {
      const got = structuredClone(parser.push(text.slice(end - size, end)));
      assert.deepEqual(got, parsePartialJson(text.slice(0, end)), `size ${size}, prefix ${JSON.stringify(text.slice(0, end))}`);
    }
    assert.deepEqual(parser.end(), JSON.parse(text));
  }
});

test("end finishes a trailing top-level number and rejects an incomplete document", () => {
  const number = new PartialJsonParser();
  assert.equal(number.push("12"), undefined);
  assert.equal(number.end(), 12);

  const open = new PartialJsonParser();
  open.push('{"a": 1');
  assert.throws(() => open.end(), SyntaxError);
  assert.ok(open.isError());
});

test("a failed parser keeps throwing", () => {
  const parser = new PartialJsonParser();
  assert.throws(() => parser.push("[1,]"), SyntaxError);
  assert.throws(() => parser.push("2]"), SyntaxError);
});

// A partial value may be shorter than the final one but never disagrees with it.
function isPartialOf(partial: JsonValue | undefined, full: JsonValue): boolean {
  if (partial === undefined) return true;
  if (typeof full === "string") return typeof partial === "string" && full.startsWith(partial);
  if (Array.isArray(full)) {
    return Array.isArray(partial) && partial.length <= full.length && partial.every((v, i) => isPartialOf(v, full[i]!));
  }
  if (full !== null && typeof full === "object") {
    if (partial === null || typeof partial !== "object" || Array.isArray(partial)) return false;
    return Object.entries(partial).every(([k, v]) => Object.hasOwn(full, k) && isPartialOf(v, full[k]!));
  }
  return Object.is(partial, full);
}
