import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { SchemaValidationError, validate } from "./index.ts";

const schema = z.object({ name: z.string(), tags: z.array(z.string()) });

test("validate returns the typed value from a Zod schema", async () => {
  const value = await validate(schema, { name: "jonson", tags: ["a"] });
  const name: string = value.name;
  assert.equal(name, "jonson");
});

test("validate throws with the schema's issues", async () => {
  await assert.rejects(validate(schema, { name: 1 }), SchemaValidationError);
});
