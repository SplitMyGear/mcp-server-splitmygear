/** Every tool the server can expose, in listing order. The registry filters by principal. */
import type { ZodRawShape } from 'zod';
import type { ToolDef } from '../registry';
import { discoveryTools } from './discovery';
import { renterTools } from './renter';
import { vendorTools } from './vendor';

export const ALL_TOOLS: ReadonlyArray<ToolDef<ZodRawShape>> = [
  ...(discoveryTools as unknown as ToolDef<ZodRawShape>[]),
  ...(renterTools as unknown as ToolDef<ZodRawShape>[]),
  ...(vendorTools as unknown as ToolDef<ZodRawShape>[]),
];

const names = ALL_TOOLS.map((t) => t.name);
const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
if (duplicates.length) throw new Error(`Duplicate MCP tool names: ${duplicates.join(', ')}`);
