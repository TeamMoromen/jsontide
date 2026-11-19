import { test } from "node:test";
import assert from "node:assert/strict";
import { emitJson, emitText, splitIntoChunks, toReadableStream } from "./emitter.ts";

const sample = { name: "jonson", tags: ["a", "b"], nested: { n: 1.5, ok: true, nil: null }, emoji: "🍣寿司" };

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of source) out.push(c);
  return out;
}

test("chunks concatenate back to the original JSON", async () => {
  for (const chunk of [{ kind: "char" }, { kind: "fixed", size: 3 }, { kind: "random", min: 1, max: 5, seed: 42 }] as const) {
    const chunks = await collect(emitJson(sample, { chunk }));
    assert.deepEqual(JSON.parse(chunks.join("")), sample);
  }
});

test("fixed strategy yields chunks of that size except the last", () => {
  const chunks = splitIntoChunks("abcdefg", { kind: "fixed", size: 3 });
  assert.deepEqual(chunks, ["abc", "def", "g"]);
});

test("never splits a surrogate pair", () => {
  const chunks = splitIntoChunks('"🍣🍣"', { kind: "char" });
  assert.deepEqual(chunks, ['"', "🍣", "🍣", '"']);
});

test("random strategy is reproducible with a seed and respects bounds", () => {
  const text = JSON.stringify(sample);
  const a = splitIntoChunks(text, { kind: "random", min: 2, max: 4, seed: 7 });
  const b = splitIntoChunks(text, { kind: "random", min: 2, max: 4, seed: 7 });
  assert.deepEqual(a, b);
  for (const c of a.slice(0, -1)) assert.ok(Array.from(c).length >= 2 && Array.from(c).length <= 4);
});

test("delay spaces out chunks", async () => {
  const start = performance.now();
  await collect(emitText("abcd", { chunk: { kind: "char" }, delayMs: 20 }));
  assert.ok(performance.now() - start >= 55);
});

test("abort stops the stream", async () => {
  const controller = new AbortController();
  const got: string[] = [];
  await assert.rejects(async () => {
    for await (const c of emitText("abcdef", { chunk: { kind: "char" }, delayMs: 10, signal: controller.signal })) {
      got.push(c);
      if (got.length === 2) controller.abort();
    }
  });
  assert.deepEqual(got, ["a", "b"]);
});

test("works as a web ReadableStream", async () => {
  const chunks = await collect(toReadableStream(emitJson(sample, { chunk: { kind: "fixed", size: 4 } })));
  assert.deepEqual(JSON.parse(chunks.join("")), sample);
});
