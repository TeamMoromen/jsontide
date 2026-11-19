export type ChunkStrategy =
  | { kind: "char" }
  | { kind: "fixed"; size: number }
  | { kind: "random"; min: number; max: number; seed?: number };

export type EmitOptions = {
  chunk?: ChunkStrategy;
  delayMs?: number;
  signal?: AbortSignal;
};

// Splits on code points so a surrogate pair (e.g. emoji) never straddles two chunks.
export function splitIntoChunks(text: string, strategy: ChunkStrategy): string[] {
  const codePoints = Array.from(text);
  const nextSize = chunkSizer(strategy);
  const chunks: string[] = [];
  for (let i = 0; i < codePoints.length; ) {
    const size = nextSize();
    chunks.push(codePoints.slice(i, i + size).join(""));
    i += size;
  }
  return chunks;
}

function chunkSizer(strategy: ChunkStrategy): () => number {
  switch (strategy.kind) {
    case "char":
      return () => 1;
    case "fixed":
      assertPositiveInt(strategy.size, "size");
      return () => strategy.size;
    case "random": {
      assertPositiveInt(strategy.min, "min");
      assertPositiveInt(strategy.max, "max");
      if (strategy.min > strategy.max) throw new RangeError("min must be <= max");
      const rand = mulberry32(strategy.seed ?? Date.now());
      const span = strategy.max - strategy.min + 1;
      return () => strategy.min + Math.floor(rand() * span);
    }
  }
}

function assertPositiveInt(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer, got ${n}`);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function* emitText(text: string, options: EmitOptions = {}): AsyncGenerator<string> {
  const { chunk = { kind: "random", min: 1, max: 8 }, delayMs = 0, signal } = options;
  const chunks = splitIntoChunks(text, chunk);
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    if (i > 0 && delayMs > 0) await sleep(delayMs, signal);
    yield chunks[i]!;
  }
}

export function emitJson(
  value: unknown,
  options: EmitOptions & { indent?: number } = {},
): AsyncGenerator<string> {
  const text = JSON.stringify(value, null, options.indent);
  if (text === undefined) throw new TypeError("value is not JSON-serializable");
  return emitText(text, options);
}

export function toReadableStream(source: AsyncIterable<string>): ReadableStream<string> {
  return ReadableStream.from(source);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
