import type { StandardSchemaV1 } from "@standard-schema/spec";

export type JsonSource = AsyncIterable<string> | ReadableStream<string>;

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
