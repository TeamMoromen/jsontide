# jsontide

English | [日本語](README.ja.md)

A type-safe streaming JSON parser. jsontide parses JSON incrementally as it arrives and returns the value received so far. You can validate that value with any [Standard Schema](https://standardschema.dev) library, such as Zod, Valibot, or ArkType.

```ts
const parser = new PartialJsonParser();
parser.push('{"name": "jo');               // { name: "jo" }
parser.push('nson", "tags": ["a');         // { name: "jonson", tags: ["a"] }
parser.push('", "b"]}');                   // { name: "jonson", tags: ["a", "b"] }
parser.end();                              // { name: "jonson", tags: ["a", "b"] }
```

## Requirements

- Node.js 18 or later
- ESM only

## Installation

```sh
npm install jsontide
```

To validate with a schema, also install a Standard Schema library:

```sh
npm install zod
```

## Usage

### Push chunks one at a time

```ts
import { PartialJsonParser } from "jsontide";

const parser = new PartialJsonParser();

for await (const chunk of source) {
  const value = parser.push(chunk); // the value received so far
  render(value);
}

const result = parser.end(); // the complete value; throws SyntaxError if incomplete
```

To read a `ReadableStream<Uint8Array>`, such as a `fetch` response body, decode it to strings first:

```ts
const res = await fetch(url);
const stream = res.body!.pipeThrough(new TextDecoderStream());

const parser = new PartialJsonParser();
for await (const chunk of stream) {
  render(parser.push(chunk));
}
const result = parser.end();
```

### Parse a stream

`parseJsonStream` runs the loop above for you. It accepts an `AsyncIterable<string>` or a `ReadableStream<string>`. It yields the value received so far after each chunk, and it yields the complete value last.

```ts
import { parseJsonStream } from "jsontide";

const res = await fetch(url);
for await (const value of parseJsonStream(res.body!.pipeThrough(new TextDecoderStream()))) {
  render(value);
}
```

Pass a schema as the second argument to get a `SchemaResult` for each chunk. The last result holds the schema's output.

```ts
for await (const result of parseJsonStream(source, User.partial())) {
  if (result.success) render(result.value);
}
```

If the stream ends before the document is complete, the loop throws a `SyntaxError`. If the complete value does not match the schema, it throws a `SchemaValidationError`. If the loop throws or you `break` out of it, the source is cancelled.

### Parse a string once

```ts
import { parsePartialJson } from "jsontide";

parsePartialJson('{"a": [1, 2, tr'); // { a: [1, 2, true] }
```

### Validate with a schema

`SchemaPartialJsonParser` validates the partial value against your schema on each `push` that changes it. A `push` that leaves the value unchanged (whitespace, an object key, a closing bracket, or a number that is still being read) returns the previous result without validating again.

```ts
import { z } from "zod";
import { SchemaPartialJsonParser } from "jsontide";

const User = z.object({ name: z.string(), tags: z.array(z.string()) });

// To accept partial values, pass a relaxed schema, for example with partial()
const parser = new SchemaPartialJsonParser(User.partial());

for await (const chunk of source) {
  const result = parser.push(chunk);
  if (result.success) {
    result.value.name; // string | undefined
  } else {
    result.value;  // the partial value that failed the schema (JsonValue)
    result.issues; // the schema's issues
  }
}

const user = parser.end(); // the schema's output type; throws SchemaValidationError on mismatch
```

Check `success` to narrow the result of `push`:

```ts
type SchemaResult<T> =
  | { success: true; value: T }
  | { success: false; value: JsonValue | undefined; issues: readonly StandardSchemaV1.Issue[] };
```

`SchemaPartialJsonParser` works **only with schemas that validate synchronously**. If you pass an async schema (for example, Zod with an async `refine`), `push` and `end` throw a `TypeError`.

To validate a complete value once, use `validate`. It also supports async schemas.

```ts
import { validate } from "jsontide";

const user = await validate(User, JSON.parse(text)); // throws SchemaValidationError on mismatch
```

## Partial value rules

The parser follows these rules so that a partial value never contradicts the data that arrives later.

| Input | Returned value | Reason |
| --- | --- | --- |
| `""` | `undefined` | No value yet |
| `{"name": "jo` | `{ name: "jo" }` | Strings are returned as far as they have arrived |
| `{"na` | `{}` | Keys appear only after they close |
| `{"n": 12` | `{}` | Numbers appear only after a delimiter (`12` can still become `123`) |
| `{"n": 12,` | `{ n: 12 }` | The delimiter completes the number |
| `[true, fa` | `[true, false]` | `true`, `false`, and `null` are known from their first character |
| `"ab\u00` | `"ab"` | Escapes appear only when complete |
| `"\ud83c` | `""` | A lone high surrogate is held back until its pair arrives |

A document that is only a top-level number (for example, `12`) completes when you call `end()`.

### Returned values are live

The objects and arrays that `push` returns are mutated in place by later pushes. To keep an earlier state, copy it:

```ts
const snapshot = structuredClone(parser.push(chunk));
```

## Errors

| Error | When |
| --- | --- |
| `SyntaxError` | The input is invalid JSON (`push`), or the document is incomplete at `end()` |
| `SchemaValidationError` | The value does not match the schema in `end()` or `validate()`. `issues` holds the schema's issues |
| `TypeError` | An async schema was passed to `SchemaPartialJsonParser` |

After a parser throws a `SyntaxError`, every later `push` and `end` throws the same error. Call `isError()` to check this state.

A `"__proto__"` key becomes an own property, as with `JSON.parse`. It does not change the prototype.

## API

| Export | Description |
| --- | --- |
| `PartialJsonParser` | `push(chunk): JsonValue \| undefined`, `end(): JsonValue`, `isError(): boolean`, `version: number` (increases when the value changes) |
| `SchemaPartialJsonParser<S>` | `new SchemaPartialJsonParser(schema)`. `push(chunk): SchemaResult<Output>`, `end(): Output`, `isError(): boolean` |
| `parseJsonStream(source, schema?)` | Parses a `JsonSource`. Returns an `AsyncGenerator` of partial values, or of `SchemaResult<Output>` when you pass a schema |
| `parsePartialJson(text)` | Parses a string once and returns the partial value |
| `validate(schema, value)` | Validates a value against a schema and returns a `Promise` of the output |
| `SchemaValidationError` | An error with `issues: readonly StandardSchemaV1.Issue[]` |
| `JsonValue` / `SchemaResult<T>` / `JsonSource` | Types |

## Development

Development requires Node.js 22.18 or later, because the tests run the TypeScript sources directly.

```sh
npm install
npm test           # run tests (node:test)
npm run typecheck  # type-check
npm run build      # build to dist/
```

## License

MIT
