/**
 * SPLIT-1798: rails for the zod 3 -> 4 migration. zod 4 changed what several
 * schema builders accept and how the MCP SDK serves them in tools/list; each
 * test below pins one place where this server deliberately keeps the zod 3
 * contract, plus the advisory fix the migration was for (GHSA-mrhx-c7xc-m3w5).
 * Validation runs the way the SDK runs it: `z.object(inputSchema)`.
 */
export {};
import { z } from 'zod';
import { ALL_TOOLS } from '../src/tools/defs';
import type { ToolDef } from '../src/tools/registry';
import { servedInputSchema } from './helpers/served-schema';

type Node = Record<string, unknown>;

function tool(name: string): ToolDef {
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}
const parse = (name: string, input: unknown) => z.object(tool(name).inputSchema).safeParse(input);

/** Every schema node of every tool's served input schema, with its tool and JSON path. */
function servedNodes(): Array<{ tool: string; path: string; node: Node }> {
  const out: Array<{ tool: string; path: string; node: Node }> = [];
  const walk = (toolName: string, value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(toolName, v, `${path}[${i}]`));
    else if (value && typeof value === 'object') {
      out.push({ tool: toolName, path, node: value as Node });
      for (const [k, v] of Object.entries(value)) walk(toolName, v, `${path}.${k}`);
    }
  };
  for (const t of ALL_TOOLS) walk(t.name, servedInputSchema(t.inputSchema), '$');
  return out;
}

const RFC_V4 = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
// Hand-assigned ids the backend seeds (POST /admin/seed/test-data; the SPLIT-200 E2E fixtures).
// Neither carries RFC 9562 version/variant digits, so zod 4's z.uuid() would refuse them.
const SEEDED = ['a0000000-0000-0000-0000-000000000001', '00000200-0000-0000-0000-0000000000a1'];
const GUID_PATTERN = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';

describe('id arguments (z.guid, not z.uuid)', () => {
  it('accept every 8-4-4-4-12 id, including the non-RFC ones Splitt seeds, and nothing else', () => {
    for (const id of [RFC_V4, RFC_V4.toUpperCase(), ...SEEDED]) {
      expect(parse('get_listing_details', { listingId: id }).success).toBe(true);
      expect(parse('mark_notifications_read', { notificationId: id }).success).toBe(true);
      expect(parse('set_listing_routes', { listingId: RFC_V4, routeIds: [id] }).success).toBe(true);
      expect(parse('update_route', { routeId: id, destinationId: id }).success).toBe(true);
    }
    for (const bad of ['not-a-uuid', RFC_V4.replace(/-/g, ''), `{${RFC_V4}}`, `${RFC_V4}0`]) {
      expect(parse('get_listing_details', { listingId: bad }).success).toBe(false);
      expect(parse('set_listing_routes', { listingId: RFC_V4, routeIds: [bad] }).success).toBe(false);
    }
  });

  it('are all served as format uuid with the lenient 8-4-4-4-12 pattern (no field uses the RFC-strict z.uuid())', () => {
    const ids = servedNodes().filter(({ node }) => node.format === 'uuid');
    expect(ids.length).toBeGreaterThan(150);
    expect(ids.filter(({ node }) => node.pattern !== GUID_PATTERN).map(({ tool: t, path }) => `${t} ${path}`)).toEqual([]);
  });
});

describe('served JSON Schema', () => {
  it('advertises only standard JSON Schema formats (zod 4 would leak e.g. "starts_with" from a trailing .startsWith())', () => {
    // A string `format` is the keyword; an object one is an argument that happens to be called format (export_my_data).
    const formats = new Set(servedNodes().map(({ node }) => node.format).filter((f) => typeof f === 'string'));
    expect([...formats].sort()).toEqual(['uri', 'uuid']);
  });

  it('serves https-only URL arguments as format uri plus the ^https:// pattern', () => {
    const httpsNodes = servedNodes().filter(({ node }) => typeof node.pattern === 'string' && node.pattern.startsWith('^https:'));
    expect(new Set(httpsNodes.map(({ tool: t }) => t))).toEqual(
      new Set(['create_route', 'update_route', 'create_listing_route', 'update_listing_route', 'log_unit_maintenance', 'add_insurance_policy', 'update_insurance_policy']),
    );
    for (const { node } of httpsNodes) expect(node).toMatchObject({ type: 'string', format: 'uri', pattern: '^https:\\/\\/.*' });
  });

  it('keeps a clearable (nullable) argument\'s description on the property itself, where clients read it', () => {
    const missing: string[] = [];
    for (const t of ALL_TOOLS) {
      const properties = (servedInputSchema(t.inputSchema).properties ?? {}) as Record<string, Node>;
      for (const [key, prop] of Object.entries(properties)) {
        const branches = Array.isArray(prop.anyOf) ? (prop.anyOf as Node[]) : [];
        if (branches.some((b) => typeof b.description === 'string') && typeof prop.description !== 'string') missing.push(`${t.name}.${key}`);
      }
    }
    expect(missing).toEqual([]);
    expect(servedInputSchema(tool('update_route').inputSchema).properties?.difficulty?.description).toMatch(/Manual difficulty/);
  });
});

describe('https-only URL arguments', () => {
  const routeWith = (sourceRef: string) => parse('create_route', { name: 'Loop', activityType: 'hike', sourceRef });
  const maintenanceWith = (url: string) => parse('log_unit_maintenance', { unitId: RFC_V4, kind: 'service', description: 'Oil', attachmentUrls: [url] });

  it('accept an https URL and refuse anything else, checking the prefix on the raw input as zod 3 did', () => {
    for (const check of [routeWith, maintenanceWith]) {
      expect(check('https://example.com/a').success).toBe(true);
      for (const bad of ['http://example.com/a', ' https://example.com/a', 'https:example.com/a', 'HTTPS://example.com/a', 'https://', 'not a url']) {
        expect(check(bad).success).toBe(false);
      }
    }
    const refused = routeWith('http://example.com/a');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.message)).toEqual(['Must be an https:// URL.']);
  });
});

describe('GHSA-mrhx-c7xc-m3w5: an oversized constrained collection', () => {
  it('is refused on its length alone, without validating (and reporting) every element', () => {
    const N = 100_000;
    // get_booking_quote is a public tool: selectedAddOns allows 30 items, each needing a name and quantity.
    const quote = parse('get_booking_quote', {
      listingId: RFC_V4, startDate: '2027-03-01', endDate: '2027-03-03',
      selectedAddOns: Array.from({ length: N }, () => ({})),
    });
    expect(quote.success).toBe(false);
    expect(quote.error?.issues).toHaveLength(1);
    expect(quote.error?.issues[0]).toMatchObject({ code: 'too_big', path: ['selectedAddOns'], maximum: 30 });

    const route = parse('create_route', { name: 'Loop', activityType: 'hike', geometry: Array.from({ length: N }, () => [0]) });
    expect(route.success).toBe(false);
    expect(route.error?.issues).toHaveLength(1);
    expect(route.error?.issues[0]).toMatchObject({ code: 'too_big', path: ['geometry'], maximum: 5000 });
  });
});
