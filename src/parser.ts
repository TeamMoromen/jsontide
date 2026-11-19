import type { StandardSchemaV1 } from "@standard-schema/spec";

/** A source of JSON text chunks accepted by {@link parseJsonStream}. Chunks may split the text at any character. */
export type JsonSource = AsyncIterable<string> | ReadableStream<string>;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER_CHAR = /[-+.\deE]/;
const HEX = /[\da-fA-F]/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_PREFIX = /^-?(?:(?:0|[1-9]\d*)(?:\.\d*|(?:\.\d+)?[eE][+-]?\d*)?)?$/;

/** Thrown when a value does not satisfy a Standard Schema. The message joins the issue messages with "; ". */
export class SchemaValidationError extends Error {
  /** The issues reported by the schema. */
  readonly issues: readonly StandardSchemaV1.Issue[];

  /** @param issues The issues reported by the schema. */
  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

/**
 * Validates a value against a Standard Schema. Works with both synchronous and asynchronous schemas.
 *
 * @param schema Any Standard Schema (Zod, Valibot, ArkType, ...).
 * @param value The value to validate.
 * @returns The schema's output value.
 * @throws {SchemaValidationError} If the value does not satisfy the schema.
 */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaValidationError(result.issues);
  return result.value;
}

/** Any value that JSON can represent. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

type Container =
  | { kind: "object"; value: JsonObject; state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"; key: string }
  | { kind: "array"; value: JsonValue[]; state: "valueOrEnd" | "value" | "commaOrEnd" };

// escape: null outside an escape, "" right after a backslash, "u" plus the hex digits read so far inside \uXXXX.
type Token =
  | { kind: "string"; isKey: boolean; text: string; escape: string | null; pendingHighSurrogate: string }
  | { kind: "number"; text: string }
  | { kind: "literal"; word: "true" | "false" | "null"; matched: number };

/**
 * Incremental JSON parser. Each `push` resumes from the saved stack and returns the value received so far.
 * The returned value is live: later pushes mutate it in place.
 */
export class PartialJsonParser {
  private pos = 0;
  private readonly stack: Container[] = [];
  private token: Token | null = null;
  private root: JsonValue | undefined = undefined;
  private rootDone = false;
  private error: SyntaxError | null = null;
  private changes = 0;

  /** Increases whenever the value returned by `push` changes, so callers can skip work on unchanged snapshots. */
  get version(): number {
    return this.changes;
  }

  /**
   * Feeds the next chunk of JSON text.
   *
   * Partial strings appear as their text so far. A number appears only once a character after it arrives,
   * because "12" may still become "123".
   *
   * @param chunk The next piece of JSON text. It may split the text anywhere, even inside a string escape.
   * @returns The value received so far, or `undefined` if no value has started yet.
   * @throws {SyntaxError} If the input so far is not a valid JSON prefix. Every later call throws the same error.
   */
  push(chunk: string): JsonValue | undefined {
    if (this.error) throw this.error;
    try {
      let i = 0;
      while (i < chunk.length) i = this.consume(chunk, i);
      this.flush();
      return this.root;
    } catch (e) {
      if (e instanceof SyntaxError) this.error = e;
      throw e;
    }
  }

  /**
   * Signals end of input: finishes a trailing top-level number and throws if the document is incomplete.
   *
   * @returns The complete value.
   * @throws {SyntaxError} If the document is incomplete or an earlier `push` failed.
   */
  end(): JsonValue {
    if (this.error) throw this.error;
    try {
      if (this.token?.kind === "number") this.finishNumber(this.token);
      if (this.token || this.stack.length > 0 || this.root === undefined) throw this.fail("Unexpected end of JSON input");
      return this.root;
    } catch (e) {
      if (e instanceof SyntaxError) this.error = e;
      throw e;
    }
  }

  /** Returns `true` once a `SyntaxError` has been thrown. After that, `push` and `end` throw the same error. */
  isError(): boolean {
    return this.error !== null;
  }

  private consume(chunk: string, i: number): number {
    const token = this.token;
    if (token?.kind === "string") return this.consumeString(token, chunk, i);
    const ch = chunk[i]!;
    if (token?.kind === "literal") {
      if (ch !== token.word[token.matched]) throw this.unexpected(ch);
      if (++token.matched === token.word.length) this.token = null;
      return this.advance(i);
    }
    if (token?.kind === "number") {
      if (NUMBER_CHAR.test(ch)) {
        token.text += ch;
        return this.advance(i);
      }
      this.finishNumber(token);
    }
    if (!WHITESPACE.has(ch)) this.structural(ch);
    return this.advance(i);
  }

  private consumeString(token: Token & { kind: "string" }, chunk: string, i: number): number {
    if (token.escape === null) {
      let j = i;
      while (j < chunk.length) {
        const c = chunk.charCodeAt(j);
        if (c === 0x22 || c === 0x5c || c < 0x20) break;
        j++;
      }
      if (j > i) {
        appendText(token, chunk.slice(i, j));
        this.pos += j - i;
        return j;
      }
      const ch = chunk[i]!;
      if (ch === '"') this.finishString(token);
      else if (ch === "\\") token.escape = "";
      else throw this.fail("Bad control character in string literal");
      return this.advance(i);
    }
    const ch = chunk[i]!;
    if (token.escape === "") {
      if (ch === "u") {
        token.escape = "u";
      } else {
        const decoded = ESCAPES[ch];
        if (decoded === undefined) throw this.fail(`Bad escaped character ${JSON.stringify(ch)}`);
        appendText(token, decoded);
        token.escape = null;
      }
    } else {
      if (!HEX.test(ch)) throw this.fail(`Bad Unicode escape ${JSON.stringify(ch)}`);
      token.escape += ch;
      if (token.escape.length === 5) {
        appendText(token, String.fromCharCode(parseInt(token.escape.slice(1), 16)));
        token.escape = null;
      }
    }
    return this.advance(i);
  }

  private advance(i: number): number {
    this.pos++;
    return i + 1;
  }

  private structural(ch: string): void {
    const top = this.stack.at(-1);
    if (!top) {
      if (this.rootDone) throw this.unexpected(ch);
      return this.startValue(ch);
    }
    if (top.kind === "array") {
      if (top.state === "commaOrEnd") {
        if (ch === ",") top.state = "value";
        else if (ch === "]") this.stack.pop();
        else throw this.unexpected(ch);
      } else if (top.state === "valueOrEnd" && ch === "]") {
        this.stack.pop();
      } else {
        this.startValue(ch);
      }
      return;
    }
    switch (top.state) {
      case "keyOrEnd":
      case "key":
        if (ch === '"') this.token = { kind: "string", isKey: true, text: "", escape: null, pendingHighSurrogate: "" };
        else if (ch === "}" && top.state === "keyOrEnd") this.stack.pop();
        else throw this.unexpected(ch);
        return;
      case "colon":
        if (ch !== ":") throw this.unexpected(ch);
        top.state = "value";
        return;
      case "value":
        return this.startValue(ch);
      case "commaOrEnd":
        if (ch === ",") top.state = "key";
        else if (ch === "}") this.stack.pop();
        else throw this.unexpected(ch);
        return;
    }
  }

  private startValue(ch: string): void {
    switch (ch) {
      case "{": {
        const frame: Container = { kind: "object", value: {}, state: "keyOrEnd", key: "" };
        this.place(frame.value);
        this.stack.push(frame);
        return;
      }
      case "[": {
        const frame: Container = { kind: "array", value: [], state: "valueOrEnd" };
        this.place(frame.value);
        this.stack.push(frame);
        return;
      }
      case '"':
        this.place("");
        this.token = { kind: "string", isKey: false, text: "", escape: null, pendingHighSurrogate: "" };
        return;
      case "t":
        return this.startLiteral("true", true);
      case "f":
        return this.startLiteral("false", false);
      case "n":
        return this.startLiteral("null", null);
    }
    if (ch !== "-" && !(ch >= "0" && ch <= "9")) throw this.unexpected(ch);
    // A number stays hidden until it ends: "12" may still become "123".
    this.claimSlot();
    this.token = { kind: "number", text: ch };
  }

  private startLiteral(word: "true" | "false" | "null", value: boolean | null): void {
    this.place(value);
    this.token = { kind: "literal", word, matched: 1 };
  }

  private finishString(token: Token & { kind: "string" }): void {
    this.token = null;
    const text = token.text + token.pendingHighSurrogate;
    if (!token.isKey) return this.write(text, false);
    const top = this.stack.at(-1) as Container & { kind: "object" };
    top.key = text;
    top.state = "colon";
  }

  private finishNumber(token: Token & { kind: "number" }): void {
    if (!NUMBER.test(token.text)) throw this.fail(`Invalid number ${JSON.stringify(token.text)}`);
    this.token = null;
    this.write(Number(token.text), true);
  }

  private flush(): void {
    const token = this.token;
    if (token?.kind === "number" && !NUMBER_PREFIX.test(token.text)) {
      throw this.fail(`Invalid number ${JSON.stringify(token.text)}`);
    }
    if (token?.kind === "string" && !token.isKey) this.write(token.text, false);
  }

  private place(value: JsonValue): void {
    this.claimSlot();
    this.write(value, true);
  }

  private claimSlot(): void {
    const top = this.stack.at(-1);
    if (top) top.state = "commaOrEnd";
    else this.rootDone = true;
  }

  // fresh: the value starts a new slot; otherwise it replaces the value in the newest slot.
  private write(value: JsonValue, fresh: boolean): void {
    const top = this.stack.at(-1);
    if (!top) {
      if (this.root === value) return;
      this.root = value;
    } else if (top.kind === "array") {
      if (fresh) top.value.push(value);
      else if (top.value.at(-1) === value) return;
      else top.value[top.value.length - 1] = value;
    } else {
      if (!fresh && top.value[top.key] === value) return;
      // defineProperty keeps "__proto__" an own property, as JSON.parse does.
      Object.defineProperty(top.value, top.key, { value, writable: true, enumerable: true, configurable: true });
    }
    this.changes++;
  }

  private unexpected(ch: string): SyntaxError {
    return this.fail(`Unexpected token ${JSON.stringify(ch)}`);
  }

  private fail(message: string): SyntaxError {
    return new SyntaxError(`${message} at position ${this.pos}`);
  }
}

function appendText(token: Token & { kind: "string" }, piece: string): void {
  const last = piece.charCodeAt(piece.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    token.text += token.pendingHighSurrogate + piece.slice(0, -1);
    token.pendingHighSurrogate = piece.slice(-1);
  } else {
    token.text += token.pendingHighSurrogate + piece;
    token.pendingHighSurrogate = "";
  }
}

/**
 * Parses a possibly incomplete JSON text in one call. Same as a single {@link PartialJsonParser.push}.
 *
 * @example
 * parsePartialJson('{"a":[1,"x'); // { a: [1, "x"] }
 *
 * @param text A JSON text or a prefix of one.
 * @returns The value received so far, or `undefined` if no value has started yet. A trailing top-level number
 *   is not returned, because it may be incomplete.
 * @throws {SyntaxError} If the text is not a valid JSON prefix.
 */
export function parsePartialJson(text: string): JsonValue | undefined {
  return new PartialJsonParser().push(text);
}

/**
 * The result of checking a snapshot against a schema.
 * On success, `value` is the schema's output. On failure, `value` is the raw snapshot and `issues` says why it failed.
 */
export type SchemaResult<T> =
  | { success: true; value: T }
  | { success: false; value: JsonValue | undefined; issues: readonly StandardSchemaV1.Issue[] };

/**
 * Wraps a PartialJsonParser and checks each snapshot against a Standard Schema.
 * Validation runs only when the snapshot changed; otherwise the previous result object is returned again.
 * The schema must validate synchronously; an async schema throws a TypeError.
 */
export class SchemaPartialJsonParser<S extends StandardSchemaV1> {
  /** The schema that each snapshot is checked against. */
  readonly schema: S;
  private readonly parser = new PartialJsonParser();
  private last: { version: number; result: SchemaResult<StandardSchemaV1.InferOutput<S>> } | null = null;

  /** @param schema A Standard Schema that validates synchronously. */
  constructor(schema: S) {
    this.schema = schema;
  }

  /**
   * Parses the chunk and reports whether the value received so far satisfies the schema.
   *
   * @param chunk The next piece of JSON text.
   * @throws {SyntaxError} If the input so far is not a valid JSON prefix.
   * @throws {TypeError} If the schema validates asynchronously.
   */
  push(chunk: string): SchemaResult<StandardSchemaV1.InferOutput<S>> {
    return this.check(this.parser.push(chunk));
  }

  /**
   * Signals end of input and returns the schema's output.
   *
   * @throws {SyntaxError} If the document is incomplete or invalid.
   * @throws {SchemaValidationError} If the complete document does not satisfy the schema.
   * @throws {TypeError} If the schema validates asynchronously.
   */
  end(): StandardSchemaV1.InferOutput<S> {
    const result = this.check(this.parser.end());
    if (!result.success) throw new SchemaValidationError(result.issues);
    return result.value;
  }

  /** Returns `true` once the underlying parser has thrown a `SyntaxError`. */
  isError(): boolean {
    return this.parser.isError();
  }

  private check(value: JsonValue | undefined): SchemaResult<StandardSchemaV1.InferOutput<S>> {
    const version = this.parser.version;
    if (this.last?.version === version) return this.last.result;
    const output = this.schema["~standard"].validate(value);
    if (output instanceof Promise) throw new TypeError("SchemaPartialJsonParser requires a synchronous schema");
    const result: SchemaResult<StandardSchemaV1.InferOutput<S>> = output.issues
      ? { success: false, value, issues: output.issues }
      : { success: true, value: output.value };
    this.last = { version, result };
    return result;
  }
}

/**
 * Parses a stream of JSON text chunks. Yields the value received so far after each chunk, then yields the
 * complete value from `end()` last. With a schema, yields a SchemaResult instead and finishes with the schema's output.
 * Breaking out of the loop early cancels the source.
 *
 * @example
 * for await (const partial of parseJsonStream(response.body.pipeThrough(new TextDecoderStream()))) {
 *   render(partial);
 * }
 *
 * @param source The JSON text chunks.
 * @throws {SyntaxError} If the stream is not valid JSON or ends before the document is complete.
 */
export function parseJsonStream(source: JsonSource): AsyncGenerator<JsonValue | undefined, void>;
/**
 * Parses a stream of JSON text chunks and checks each snapshot against a schema.
 * Yields a {@link SchemaResult} after each chunk, then a successful result holding the schema's output last.
 * Breaking out of the loop early cancels the source.
 *
 * @param source The JSON text chunks.
 * @param schema A Standard Schema that validates synchronously.
 * @throws {SyntaxError} If the stream is not valid JSON or ends before the document is complete.
 * @throws {SchemaValidationError} If the complete document does not satisfy the schema.
 * @throws {TypeError} If the schema validates asynchronously.
 */
export function parseJsonStream<S extends StandardSchemaV1>(
  source: JsonSource,
  schema: S,
): AsyncGenerator<SchemaResult<StandardSchemaV1.InferOutput<S>>, void>;
export async function* parseJsonStream(source: JsonSource, schema?: StandardSchemaV1): AsyncGenerator<unknown, void> {
  if (schema === undefined) {
    const parser = new PartialJsonParser();
    for await (const chunk of source) yield parser.push(chunk);
    yield parser.end();
  } else {
    const parser = new SchemaPartialJsonParser(schema);
    for await (const chunk of source) yield parser.push(chunk);
    yield { success: true, value: parser.end() };
  }
}
