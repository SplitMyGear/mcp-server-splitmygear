export {};
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defineTool, isToolVisible, isToolAllowed, hasScope, scopeDeniedMessage, registerTools, ok, fail, fromResult, TOOL_SCOPES, type ToolContext } from '../src/tools/registry';
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

  it('is scope-aware: no scope list means unrestricted, an explicit list hides tools outside it', () => {
    const scoped: ToolContext = { ...renter, scopes: ['read', 'bookings'] };
    expect(hasScope(renter, 'messaging')).toBe(true); // undefined scopes = every scope (verified raw JWT)
    expect(hasScope(scoped, 'bookings')).toBe(true);
    expect(hasScope(scoped, 'messaging')).toBe(false);
    expect(hasScope({ ...renter, scopes: [] }, 'read')).toBe(false);
    // The optional third argument adds the scope check on top of the role check.
    expect(isToolVisible('user', scoped)).toBe(true);
    expect(isToolVisible('user', scoped, 'bookings')).toBe(true);
    expect(isToolVisible('user', scoped, 'messaging')).toBe(false);
    expect(isToolVisible('public', scoped, 'read')).toBe(true);
    expect(isToolVisible('public', { ...operator, scopes: ['read'] }, 'read')).toBe(true);
    // Scope never overrides role: a renter granted `listings` still cannot see vendor tools.
    expect(isToolVisible('vendor', { ...renter, scopes: ['listings'] }, 'listings')).toBe(false);
    expect(isToolAllowed({ access: 'user', scope: 'bookings' }, scoped)).toBe(true);
    expect(isToolAllowed({ access: 'user', scope: 'messaging' }, scoped)).toBe(false);
    expect(isToolAllowed({ access: 'public', scope: 'read' }, { ...operator, scopes: ['read'] })).toBe(true);
    expect(scopeDeniedMessage('messaging', 'send_message')).toBe("This connection was not granted the 'messaging' permission. Reconnect and grant it to use send_message.");
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
    // Scoped connections: only tools whose scope was granted are registered.
    const scopedRenter = names({ ...renter, scopes: ['read', 'bookings'] });
    expect(scopedRenter).toContain('search_listings');
    expect(scopedRenter).toContain('list_my_bookings');
    expect(scopedRenter).toContain('create_booking');
    expect(scopedRenter).not.toContain('send_message');
    expect(scopedRenter).not.toContain('get_my_profile');
    for (const n of scopedRenter) expect(['read', 'bookings']).toContain(ALL_TOOLS.find((t) => t.name === n)!.scope);
    expect(names({ ...admin, scopes: [...TOOL_SCOPES] }).length).toBe(ALL_TOOLS.length);
    expect(names({ ...admin, scopes: [] })).toEqual([]);
    // The operator key is `read` only; every public tool is in that scope, so it loses nothing.
    const scopedOp = names({ ...operator, scopes: ['read'] });
    expect(scopedOp).toEqual(op);
    for (const n of scopedOp) expect(ALL_TOOLS.find((t) => t.name === n)!.scope).toBe('read');
    for (const t of ALL_TOOLS) {
      expect(TOOL_SCOPES).toContain(t.scope);
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
      name: 'boom', title: 'Boom', description: 'throws for the test, long enough description here', access: 'user', scope: 'profile',
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

  it('refuses a call whose scope is no longer granted, even for a registered tool', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const handler = jest.fn(async () => ok('sent'));
    const chat = defineTool({
      name: 'chat', title: 'Chat', description: 'a messaging-scoped tool used to exercise the call-time gate', access: 'user', scope: 'messaging',
      inputSchema: {}, annotations: { readOnlyHint: false },
      handler,
    });
    // Registered while `messaging` is granted, then the context is narrowed before the call.
    const ctx: ToolContext = { ...renter, scopes: ['messaging'] };
    const server = new McpServer({ name: 't', version: '0' });
    expect(registerTools(server, ctx, [chat as never])).toEqual(['chat']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    type R = { isError?: boolean; content: Array<{ text: string }> };
    expect(((await client.callTool({ name: 'chat', arguments: {} })) as R).isError).toBeFalsy();
    ctx.scopes = ['read'];
    const denied = (await client.callTool({ name: 'chat', arguments: {} })) as R;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toBe("This connection was not granted the 'messaging' permission. Reconnect and grant it to use chat.");
    expect(handler).toHaveBeenCalledTimes(1);
    // Role denial wins over scope denial when both apply (the message names the real blocker).
    ctx.token = undefined;
    const noToken = (await client.callTool({ name: 'chat', arguments: {} })) as R;
    expect(noToken.content[0].text).toContain('signed-in Splitt user');
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
