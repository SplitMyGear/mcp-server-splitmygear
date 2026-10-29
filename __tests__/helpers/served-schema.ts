/**
 * The JSON Schema tools/list serves for a tool's input, built the way the MCP
 * SDK builds it (@modelcontextprotocol/sdk, server/zod-json-schema-compat.js:
 * draft-07, the input side of every pipe).
 *
 * Read an argument's model-facing docs from here, not from `schema.description`:
 * under zod 4 a wrapper (`.optional()`, `.nullable()`, `.default()`) does not
 * report the description of the schema it wraps, so a rail reading
 * `.description` would skip most optional arguments, although the served JSON
 * Schema (what a client actually sees) still carries their description.
 */
import { z } from 'zod';

interface ServedSchemaNode {
  description?: string;
  properties?: Record<string, ServedSchemaNode>;
}

export function servedInputSchema(shape: z.ZodRawShape): ServedSchemaNode {
  return z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as ServedSchemaNode;
}

/** Each top-level argument's served description, `undefined` when it has none. */
export function servedDescriptions(shape: z.ZodRawShape): Record<string, string | undefined> {
  const properties = servedInputSchema(shape).properties ?? {};
  return Object.fromEntries(Object.keys(shape).map((key) => [key, properties[key]?.description]));
}
