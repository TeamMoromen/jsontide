import type { StandardSchemaV1 } from "@standard-schema/spec";

export type JsonSource = AsyncIterable<string> | ReadableStream<string>;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER_CHAR = /[-+.\deE]/;
const HEX = /[\da-fA-F]/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_PREFIX = /^-?(?:(?:0|[1-9]\d*)(?:\.\d*|(?:\.\d+)?[eE][+-]?\d*)?)?$/;

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((i) => i.message).join("; "));
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaValidationError(result.issues);
  return result.value;
}


export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type Container =
  | { kind: "object"; value: JsonObject; state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"; key: string }
  | { kind: "array"; value: JsonValue[]; state: "valueOrEnd" | "value" | "commaOrEnd" };

// escape: null outside an escape, "" right after a backslash, "u" plus the hex digits read so far inside \uXXXX.
type Token =
  | { kind: "string"; isKey: boolean; text: string; escape: string | null }
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

  /** Signals end of input: finishes a trailing top-level number and throws if the document is incomplete. */
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
        token.text += chunk.slice(i, j);
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
        token.text += decoded;
        token.escape = null;
      }
    } else {
      if (!HEX.test(ch)) throw this.fail(`Bad Unicode escape ${JSON.stringify(ch)}`);
      token.escape += ch;
      if (token.escape.length === 5) {
        token.text += String.fromCharCode(parseInt(token.escape.slice(1), 16));
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
        if (ch === '"') this.token = { kind: "string", isKey: true, text: "", escape: null };
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
        this.token = { kind: "string", isKey: false, text: "", escape: null };
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
    if (!token.isKey) return this.write(token.text, false);
    const top = this.stack.at(-1) as Container & { kind: "object" };
    top.key = token.text;
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
    if (token?.kind === "string" && !token.isKey) this.write(withoutTrailingHighSurrogate(token.text), false);
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
      this.root = value;
    } else if (top.kind === "array") {
      if (fresh) top.value.push(value);
      else top.value[top.value.length - 1] = value;
    } else {
      // defineProperty keeps "__proto__" an own property, as JSON.parse does.
      Object.defineProperty(top.value, top.key, { value, writable: true, enumerable: true, configurable: true });
    }
  }

  private unexpected(ch: string): SyntaxError {
    return this.fail(`Unexpected token ${JSON.stringify(ch)}`);
  }

  private fail(message: string): SyntaxError {
    return new SyntaxError(`${message} at position ${this.pos}`);
  }
}

// Hide a high surrogate until its low half arrives, so a snapshot never ends in half a code point.
function withoutTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function parsePartialJson(text: string): JsonValue | undefined {
  return new PartialJsonParser().push(text);
}

export type SchemaResult<T> =
  | { success: true; value: T }
  | { success: false; value: JsonValue | undefined; issues: readonly StandardSchemaV1.Issue[] };

/**
 * Wraps a PartialJsonParser and checks each snapshot against a Standard Schema.
 * The schema must validate synchronously; an async schema throws a TypeError.
 */
export class SchemaPartialJsonParser<S extends StandardSchemaV1> {
  readonly schema: S;
  private readonly parser = new PartialJsonParser();

  constructor(schema: S) {
    this.schema = schema;
  }

  /** Parses the chunk and reports whether the value received so far satisfies the schema. */
  push(chunk: string): SchemaResult<StandardSchemaV1.InferOutput<S>> {
    const value = this.parser.push(chunk);
    const result = this.validateSync(value);
    return result.issues ? { success: false, value, issues: result.issues } : { success: true, value: result.value };
  }

  /** Signals end of input and returns the schema's output; throws SchemaValidationError if the document does not match. */
  end(): StandardSchemaV1.InferOutput<S> {
    const result = this.validateSync(this.parser.end());
    if (result.issues) throw new SchemaValidationError(result.issues);
    return result.value;
  }

  isError(): boolean {
    return this.parser.isError();
  }

  private validateSync(value: unknown): StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>> {
    const result = this.schema["~standard"].validate(value);
    if (result instanceof Promise) throw new TypeError("SchemaPartialJsonParser requires a synchronous schema");
    return result;
  }
}

/**
 * Parses a stream of JSON text chunks. Yields the value received so far after each chunk, then yields the
 * complete value from `end()` last. With a schema, yields a SchemaResult instead and finishes with the schema's output.
 * Breaking out of the loop early cancels the source.
 */
export function parseJsonStream(source: JsonSource): AsyncGenerator<JsonValue | undefined, void>;
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
