import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { emitText, type ChunkStrategy } from "./emitter.ts";

const USAGE = `usage: node src/cli.ts [file] [options]
  reads JSON from file (or stdin) and writes it to stdout in chunks

  --chunk <n|char|min-max>  chunk size: fixed n, one code point, or random range (default 1-8)
  --delay <ms>              delay between chunks (default 50)
  --seed <n>                seed for random chunk sizes
  --indent <n>              re-serialize with this indent
  --debug                   write chunks to stderr as JSON strings, one per line`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chunk: { type: "string", default: "1-8" },
    delay: { type: "string", default: "50" },
    seed: { type: "string" },
    indent: { type: "string" },
    debug: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const raw = positionals[0] ? await readFile(positionals[0], "utf8") : await readStdin();
const parsed: unknown = JSON.parse(raw);
const text = values.indent === undefined ? JSON.stringify(parsed) : JSON.stringify(parsed, null, Number(values.indent));

for await (const chunk of emitText(text, {
  chunk: parseChunk(values.chunk, values.seed),
  delayMs: Number(values.delay),
})) {
  process.stdout.write(chunk);
  if (values.debug) process.stderr.write(JSON.stringify(chunk) + "\n");
}
process.stdout.write("\n");

function parseChunk(spec: string, seed: string | undefined): ChunkStrategy {
  if (spec === "char") return { kind: "char" };
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    return { kind: "random", min: Number(range[1]), max: Number(range[2]), seed: seed === undefined ? undefined : Number(seed) };
  }
  if (/^\d+$/.test(spec)) return { kind: "fixed", size: Number(spec) };
  throw new Error(`invalid --chunk: ${spec}\n\n${USAGE}`);
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
