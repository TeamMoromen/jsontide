import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseJsonStream, SchemaValidationError, type JsonValue } from "../src/index.ts";
import { emitJson, toReadableStream } from "./emitter.ts";

const chunks = ['{"name": "jo', 'nson", "tags": ["a', '", "b"]}'];
const full = { name: "jonson", tags: ["a", "b"] };

async function* from(pieces: string[]): AsyncGenerator<string> {
  yield* pieces;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of stream) out.push(structuredClone(v));
  return out;
}

const expectedSnapshots: JsonValue[] = [{ name: "jo" }, { name: "jonson", tags: ["a"] }, full, full];

test("parseJsonStream yields each partial value from an AsyncIterable, then the complete value", async () => {
  assert.deepEqual(await collect(parseJsonStream(from(chunks))), expectedSnapshots);
});

test("parseJsonStream reads a ReadableStream", async () => {
  assert.deepEqual(await collect(parseJsonStream(toReadableStream(from(chunks)))), expectedSnapshots);
});

test("parseJsonStream ends with the complete value for any chunking", async () => {
  const value = { a: [1, -2.5e3, true, null], s: "🍣\n\u0000", nested: { "": [] } };
  for (let seed = 0; seed < 50; seed++) {
    const snapshots = await collect(parseJsonStream(emitJson(value, { chunk: { kind: "random", min: 1, max: 5, seed } })));
    assert.deepEqual(snapshots.at(-1), value);
  }
});

test("parseJsonStream yields a top-level number only at the end", async () => {
  assert.deepEqual(await collect(parseJsonStream(from(["1", "2"]))), [undefined, undefined, 12]);
});

test("parseJsonStream throws SyntaxError when the stream ends mid-document", async () => {
  await assert.rejects(collect(parseJsonStream(from(['{"a": 1']))), SyntaxError);
  await assert.rejects(collect(parseJsonStream(from([]))), SyntaxError);
});

test("parseJsonStream cancels a ReadableStream on invalid JSON", async () => {
  let cancelled = false;
  const source = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("[1,");
      controller.enqueue("]");
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(collect(parseJsonStream(source)), SyntaxError);
  assert.ok(cancelled);
});

test("parseJsonStream cancels a ReadableStream when the consumer stops early", async () => {
  let cancelled = false;
  const source = new ReadableStream<string>({
    pull(controller) {
      controller.enqueue("[1, ");
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const _ of parseJsonStream(source)) break;
  assert.ok(cancelled);
});

test("parseJsonStream with a schema yields results and ends with the schema's output", async () => {
  const schema = z.object({ name: z.string(), tags: z.array(z.string()).transform((t) => t.length) });
  const results = await collect(parseJsonStream(from(chunks), schema));

  assert.deepEqual(
    results.map((r) => r.success),
    [false, true, true, true],
  );
  const last = results.at(-1)!;
  assert.ok(last.success);
  const count: number = last.value.tags;
  assert.equal(count, 2);
});

test("parseJsonStream with a schema throws SchemaValidationError when the complete value does not match", async () => {
  const schema = z.object({ name: z.number() }).partial();
  await assert.rejects(collect(parseJsonStream(from(['{"name": "a"}']), schema)), SchemaValidationError);
});
