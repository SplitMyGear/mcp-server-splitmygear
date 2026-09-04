export {};
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defineTool, isToolVisible, registerTools, ok, fail, fromResult, type ToolContext } from '../src/tools/registry';
import { ALL_TOOLS } from '../src/tools/defs';
import { canActAsVendor, canBookRentals, canManageVendorPayouts, canViewVendorFinance, isVendorFamily } from '../src/lib/roles';

const operator: ToolContext = { role: 'admin', kind: 'operator' };
const renter: ToolContext = { userId: 'u', role: 'renter', token: 't', kind: 'oauth' };
const vendor: ToolContext = { userId: 'u', role: 'vendor', token: 't', kind: 'oauth' };
const staff: ToolContext = { userId: 'u', role: 'vendor_staff', token: 't', kind: 'jwt' };
const manager: ToolContext = { userId: 'u', role: 'vendor_manager', token: 't', kind: 'jwt' };
const owner: ToolContext = { userId: 'u', role: 'vendor_owner', token: 't', kind: 'jwt' };
const admin: ToolContext = { userId: 'u', role: 'admin', token: 't', kind: 'jwt' };

describe('roles', () => {
  it('mirrors the backend role model', () => {
    expect(isVendorFamily('vendor_staff')).toBe(true);
    expect(isVendorFamily('renter')).toBe(false);
    expect(canActAsVendor('admin')).toBe(true);
    expect(canBookRentals('vendor')).toBe(false);
    expect(canBookRentals('renter')).toBe(true);
    expect(canViewVendorFinance('vendor')).toBe(false);
    expect(canViewVendorFinance('vendor_manager')).toBe(true);
    expect(canManageVendorPayouts('vendor_manager')).toBe(false);
    expect(canManageVendorPayouts('vendor_owner')).toBe(true);
  });
});

describe('tool visibility', () => {
  it('is role-aware', () => {
    expect(isToolVisible('public', operator)).toBe(true);
    expect(isToolVisible('user', operator)).toBe(false);
    expect(isToolVisible('user', renter)).toBe(true);
    expect(isToolVisible('renter', renter)).toBe(true);
    expect(isToolVisible('renter', vendor)).toBe(false);
    expect(isToolVisible('vendor', renter)).toBe(false);
    expect(isToolVisible('vendor', staff)).toBe(true);
    expect(isToolVisible('vendor_finance', staff)).toBe(false);
    expect(isToolVisible('vendor_finance', manager)).toBe(true);
    expect(isToolVisible('vendor_owner', manager)).toBe(false);
    expect(isToolVisible('vendor_owner', owner)).toBe(true);
    expect(isToolVisible('vendor_owner', admin)).toBe(true);
  });

  it('registers only the visible tools and every tool has model-facing docs', () => {
    const names = (ctx: ToolContext) => registerTools(new McpServer({ name: 't', version: '0' }), ctx, ALL_TOOLS);
    const op = names(operator);
    expect(op).toContain('search_listings');
    expect(op).not.toContain('get_my_profile');
    expect(names(renter)).toContain('create_booking');
    expect(names(vendor)).not.toContain('create_booking');
    expect(names(vendor)).toContain('list_my_listings');
    expect(names(staff)).not.toContain('get_vendor_earnings');
    expect(names(owner)).toContain('start_stripe_connect_onboarding');
    expect(names(admin).length).toBe(ALL_TOOLS.length);
    for (const t of ALL_TOOLS) {
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
    }
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(ALL_TOOLS.length);
  });

  it('gates handlers at call time and converts thrown errors into isError results', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const boom = defineTool({
      name: 'boom', title: 'Boom', description: 'throws for the test, long enough description here', access: 'user',
      inputSchema: { x: z.string() }, annotations: { readOnlyHint: true },
      handler: async () => { throw new Error('kaboom'); },
    });
    const server = new McpServer({ name: 't', version: '0' });
    expect(registerTools(server, renter, [boom as never])).toEqual(['boom']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: 'boom', arguments: { x: '1' } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom failed unexpectedly');
    await client.close();
  });
});

describe('result helpers', () => {
  it('formats ok/fail/fromResult', () => {
    expect(ok('plain').content[0]).toEqual({ type: 'text', text: 'plain' });
    expect(JSON.parse((ok({ a: 1 }).content[0] as { text: string }).text)).toEqual({ a: 1 });
    expect(fail('nope').isError).toBe(true);
    expect(fromResult({ ok: false, error: 'missing', status: 404 }).content[0]).toMatchObject({ text: 'Not found: missing' });
    expect(fromResult({ ok: false, error: 'expired', status: 401 }).content[0]).toMatchObject({ text: expect.stringContaining('Reconnect') });
    expect(fromResult({ ok: true, data: { x: 1 } }, (d) => d.x).content[0]).toMatchObject({ text: '1' });
  });
});
