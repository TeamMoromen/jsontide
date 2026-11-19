# jsontide

[English](README.md) | 日本語

JSONストリーム向けのパーサです。JSON を届いたぶんだけ少しずつパースし、その時点までの値を返します。[Standard Schema](https://standardschema.dev) に対応したスキーマ（Zod、Valibot、ArkType など）で値を検証できます。

```ts
const parser = new PartialJsonParser();
parser.push('{"name": "jo');               // { name: "jo" }
parser.push('nson", "tags": ["a');         // { name: "jonson", tags: ["a"] }
parser.push('", "b"]}');                   // { name: "jonson", tags: ["a", "b"] }
parser.end();                              // { name: "jonson", tags: ["a", "b"] }
```

## 動作環境

- Node.js 18 以上
- ESM のみ

## インストール

```sh
npm install jsontide
```

スキーマ検証を使う場合は、Standard Schema 対応のライブラリも入れてください。

```sh
npm install zod
```

## 使い方

### チャンクを順に渡す

```ts
import { PartialJsonParser } from "jsontide";

const parser = new PartialJsonParser();

for await (const chunk of source) {
  const value = parser.push(chunk); // ここまでに届いた値
  render(value);
}

const result = parser.end(); // 完成した値。不完全なら SyntaxError
```

`fetch` のレスポンスなど `ReadableStream<Uint8Array>` を読む場合は、先に文字列へデコードします。

```ts
const res = await fetch(url);
const stream = res.body!.pipeThrough(new TextDecoderStream());

const parser = new PartialJsonParser();
for await (const chunk of stream) {
  render(parser.push(chunk));
}
const result = parser.end();
```

### ストリームをパースする

`parseJsonStream` は上のループを代わりに実行します。`AsyncIterable<string>` と `ReadableStream<string>` を受け取ります。チャンクごとにその時点の値を返し、最後に完成した値を返します。

```ts
import { parseJsonStream } from "jsontide";

const res = await fetch(url);
for await (const value of parseJsonStream(res.body!.pipeThrough(new TextDecoderStream()))) {
  render(value);
}
```

2 番目の引数にスキーマを渡すと、チャンクごとに `SchemaResult` を返します。最後の結果はスキーマの出力を持ちます。

```ts
for await (const result of parseJsonStream(source, User.partial())) {
  if (result.success) render(result.value);
}
```

ドキュメントが完成する前にストリームが終わると、ループは `SyntaxError` を投げます。完成した値がスキーマに合わない場合は `SchemaValidationError` を投げます。ループが例外を投げたとき、または `break` で抜けたときは、ソースをキャンセルします。

### 文字列を 1 回だけパースする

```ts
import { parsePartialJson } from "jsontide";

parsePartialJson('{"a": [1, 2, tr'); // { a: [1, 2, true] }
```

### スキーマで検証する

`SchemaPartialJsonParser` は、`push` で値が変わったときに途中の値をスキーマで検証します。値が変わらない `push`（空白、オブジェクトのキー、閉じ括弧、読み取り中の数値）では、検証せずに前回の結果を返します。

```ts
import { z } from "zod";
import { SchemaPartialJsonParser } from "jsontide";

const User = z.object({ name: z.string(), tags: z.array(z.string()) });

// 途中の値も通したい場合は partial() などで緩めたスキーマを渡す
const parser = new SchemaPartialJsonParser(User.partial());

for await (const chunk of source) {
  const result = parser.push(chunk);
  if (result.success) {
    result.value.name; // string | undefined
  } else {
    result.value;  // スキーマを通らなかった途中の値（JsonValue）
    result.issues; // スキーマのエラー
  }
}

const user = parser.end(); // スキーマの出力型。合わなければ SchemaValidationError
```

`push` の戻り値は `success` で判別します。

```ts
type SchemaResult<T> =
  | { success: true; value: T }
  | { success: false; value: JsonValue | undefined; issues: readonly StandardSchemaV1.Issue[] };
```

`SchemaPartialJsonParser` が使えるのは**同期的に検証するスキーマだけ**です。非同期のスキーマ（Zod の async `refine` など）を渡すと、`push` / `end` が `TypeError` を投げます。

完成した値を一度だけ検証するなら `validate` を使います。こちらは非同期スキーマにも対応します。

```ts
import { validate } from "jsontide";

const user = await validate(User, JSON.parse(text)); // 合わなければ SchemaValidationError
```

## 途中の値のルール

途中の値が、あとで届く値と矛盾しないように、次のルールで値を返します。

| 入力 | 返す値 | 理由 |
| --- | --- | --- |
| `""` | `undefined` | まだ値がない |
| `{"name": "jo` | `{ name: "jo" }` | 文字列は届いたぶんだけ返す |
| `{"na` | `{}` | キーは閉じるまで出さない |
| `{"n": 12` | `{}` | 数値は区切りが来るまで出さない（`12` が `123` になりうる） |
| `{"n": 12,` | `{ n: 12 }` | 区切りで数値が確定 |
| `[true, fa` | `[true, false]` | `true` / `false` / `null` は先頭の 1 文字で確定 |
| `"ab\u00` | `"ab"` | エスケープは完成するまで出さない |
| `"\ud83c` | `""` | サロゲートペアの前半だけは出さない |

トップレベルが数値だけのドキュメント（例: `12`）は、`end()` を呼ぶと確定します。

### 返す値は使い回される

`push` が返すオブジェクトや配列は、次の `push` でその場で書き換わります。前の状態を残したい場合はコピーしてください。

```ts
const snapshot = structuredClone(parser.push(chunk));
```

## エラー

| エラー | 発生する場面 |
| --- | --- |
| `SyntaxError` | 入力が JSON として不正（`push`）、または `end()` 時点でドキュメントが不完全 |
| `SchemaValidationError` | `end()` / `validate()` で値がスキーマに合わない。`issues` にスキーマのエラーが入る |
| `TypeError` | `SchemaPartialJsonParser` に非同期スキーマを渡した |

一度 `SyntaxError` を投げたパーサーは、以後の `push` / `end` でも同じエラーを投げます。`isError()` で状態を確認できます。

`"__proto__"` キーは `JSON.parse` と同じく自身のプロパティとして扱い、プロトタイプは変更しません。

## API

| エクスポート | 説明 |
| --- | --- |
| `PartialJsonParser` | `push(chunk): JsonValue \| undefined`、`end(): JsonValue`、`isError(): boolean`、`version: number`（値が変わると増える） |
| `SchemaPartialJsonParser<S>` | `new SchemaPartialJsonParser(schema)`。`push(chunk): SchemaResult<Output>`、`end(): Output`、`isError(): boolean` |
| `parseJsonStream(source, schema?)` | `JsonSource` をパースする。途中の値の `AsyncGenerator` を返す。スキーマを渡すと `SchemaResult<Output>` の `AsyncGenerator` を返す |
| `parsePartialJson(text)` | 文字列を 1 回パースして途中の値を返す |
| `validate(schema, value)` | 値をスキーマで検証し、出力を返す `Promise` |
| `SchemaValidationError` | `issues: readonly StandardSchemaV1.Issue[]` を持つエラー |
| `JsonValue` / `SchemaResult<T>` / `JsonSource` | 型 |

## 開発

テストは TypeScript のソースを直接実行するため、開発には Node.js 22.18 以上が必要です。

```sh
npm install
npm test           # テスト（node:test）
npm run typecheck  # 型チェック
npm run build      # dist/ にビルド
```

## ライセンス

MIT
