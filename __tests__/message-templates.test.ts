/** Contract tests for the vendor message-template backend module and tool defs. */
export {};

import { z } from 'zod';

const mockBackendRequest = jest.fn();
jest.mock('../src/lib/backend-client', () => {
  class BackendApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.name = 'BackendApiError'; this.status = status; }
  }
  return { BackendApiError, backendRequest: (...args: unknown[]) => mockBackendRequest(...args) };
});

import { messageTemplateApi, MESSAGE_TEMPLATE_KINDS, MESSAGE_TEMPLATE_TRIGGERS } from '../src/tools/message-templates';
import {
  messageTemplateTools,
  listMessageTemplates,
  getMessageTemplate,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
} from '../src/tools/defs/message-templates';
import { TOOL_SCOPES } from '../src/tools/registry';

const T = 'h.p.s';
const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { token: T, role: 'vendor' };
const { BackendApiError } = jest.requireMock('../src/lib/backend-client');

function lastCall() {
  const c = mockBackendRequest.mock.calls[mockBackendRequest.mock.calls.length - 1];
  return { method: c[0], path: c[1], opts: c[2] ?? {} };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  mockBackendRequest.mockReset();
  mockBackendRequest.mockResolvedValue({ ok: 1 });
});

describe('messageTemplateApi', () => {
  it('lists all templates or filters by kind', async () => {
    await messageTemplateApi.list(T);
    expect(lastCall()).toEqual({ method: 'GET', path: '/message-templates', opts: { token: T } });
    await messageTemplateApi.list(T, 'QUICK_REPLY');
    expect(lastCall()).toEqual({ method: 'GET', path: '/message-templates?kind=QUICK_REPLY', opts: { token: T } });
  });

  it('gets one template', async () => {
    await messageTemplateApi.get(ID, T);
    expect(lastCall()).toEqual({ method: 'GET', path: `/message-templates/${ID}`, opts: { token: T } });
  });

  it('creates with only the DTO fields that were set', async () => {
    await messageTemplateApi.create(T, { kind: 'LIFECYCLE', trigger: 'BOOKING_CONFIRMED', body: 'Hi {{renterName}}', name: undefined, subject: undefined, isActive: undefined });
    expect(lastCall()).toEqual({
      method: 'POST',
      path: '/message-templates',
      opts: { token: T, body: { kind: 'LIFECYCLE', trigger: 'BOOKING_CONFIRMED', body: 'Hi {{renterName}}' } },
    });
    expect(lastCall().opts.body).not.toHaveProperty('name');
    expect(lastCall().opts.body).not.toHaveProperty('vendorId');
  });

  it('updates with a partial body', async () => {
    await messageTemplateApi.update(ID, T, { isActive: false, body: undefined });
    expect(lastCall()).toEqual({ method: 'PUT', path: `/message-templates/${ID}`, opts: { token: T, body: { isActive: false } } });
  });

  it('deletes', async () => {
    await messageTemplateApi.remove(ID, T);
    expect(lastCall()).toEqual({ method: 'DELETE', path: `/message-templates/${ID}`, opts: { token: T } });
  });

  it('returns a Result error instead of throwing on backend failures', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(404, `Message template ${ID} not found`));
    expect(await messageTemplateApi.get(ID, T)).toEqual({ ok: false, error: `Message template ${ID} not found`, status: 404 });
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(400, 'A lifecycle template requires a trigger'));
    const res = await messageTemplateApi.create(T, { body: 'x' });
    expect(res).toEqual({ ok: false, error: 'A lifecycle template requires a trigger', status: 400 });
    mockBackendRequest.mockRejectedValueOnce(new Error('net'));
    expect((await messageTemplateApi.list(T)).ok).toBe(false);
  });
});

describe('messageTemplateTools (defs)', () => {
  it('exports the five vendor messaging tools with model-facing docs', () => {
    expect(messageTemplateTools.map((t) => t.name)).toEqual([
      'list_message_templates',
      'get_message_template',
      'create_message_template',
      'update_message_template',
      'delete_message_template',
    ]);
    for (const t of messageTemplateTools) {
      expect(t.access).toBe('vendor');
      expect(t.scope).toBe('messaging');
      expect(TOOL_SCOPES).toContain(t.scope);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).not.toMatch(/—/);
      expect(t.annotations).toHaveProperty('readOnlyHint');
    }
    expect(listMessageTemplates.annotations.readOnlyHint).toBe(true);
    expect(getMessageTemplate.annotations.readOnlyHint).toBe(true);
    expect(createMessageTemplate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(updateMessageTemplate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(deleteMessageTemplate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('validates ids as UUIDs and kinds/triggers as enums', () => {
    expect(z.object(getMessageTemplate.inputSchema).safeParse({ templateId: 'not-a-uuid' }).success).toBe(false);
    expect(z.object(getMessageTemplate.inputSchema).safeParse({ templateId: ID }).success).toBe(true);
    expect(z.object(deleteMessageTemplate.inputSchema).safeParse({ templateId: '../admin' }).success).toBe(false);
    expect(z.object(listMessageTemplates.inputSchema).safeParse({ kind: 'BOGUS' }).success).toBe(false);
    for (const kind of MESSAGE_TEMPLATE_KINDS) expect(z.object(listMessageTemplates.inputSchema).safeParse({ kind }).success).toBe(true);
    const create = z.object(createMessageTemplate.inputSchema);
    expect(create.safeParse({ body: 'x', trigger: 'NOPE' }).success).toBe(false);
    for (const trigger of MESSAGE_TEMPLATE_TRIGGERS) expect(create.safeParse({ body: 'x', trigger }).success).toBe(true);
    expect(create.safeParse({ body: '' }).success).toBe(false);
    expect(create.safeParse({ body: 'x'.repeat(5001) }).success).toBe(false);
    expect(create.safeParse({ body: 'x', name: 'n'.repeat(151) }).success).toBe(false);
    expect(create.safeParse({ body: 'x', vendorId: ID }).success).toBe(true); // unknown keys are stripped by zod, never forwarded
    expect(z.object(updateMessageTemplate.inputSchema).safeParse({ templateId: ID }).success).toBe(true);
  });

  it('list and get forward the token and kind filter', async () => {
    mockBackendRequest.mockResolvedValue([{ id: ID, kind: 'QUICK_REPLY' }]);
    const res = await listMessageTemplates.handler({ kind: 'QUICK_REPLY' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(lastCall()).toMatchObject({ method: 'GET', path: '/message-templates?kind=QUICK_REPLY', opts: { token: T } });
    await listMessageTemplates.handler({}, ctx);
    expect(lastCall().path).toBe('/message-templates');
    await getMessageTemplate.handler({ templateId: ID }, ctx);
    expect(lastCall()).toMatchObject({ method: 'GET', path: `/message-templates/${ID}`, opts: { token: T } });
  });

  it('create rejects a lifecycle template without a trigger before calling the backend', async () => {
    const res = await createMessageTemplate.handler({ body: 'Thanks {{renterName}}' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs a trigger/);
    expect(text(res)).toMatch(/QUICK_REPLY/);
    expect(mockBackendRequest).not.toHaveBeenCalled();
  });

  it('create sends the lifecycle DTO and defaults kind to LIFECYCLE', async () => {
    await createMessageTemplate.handler({ trigger: 'POST_RETURN', body: 'Thanks {{renterName}}', name: 'Review ask', isActive: true }, ctx);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: '/message-templates',
      opts: { token: T, body: { kind: 'LIFECYCLE', trigger: 'POST_RETURN', body: 'Thanks {{renterName}}', name: 'Review ask', isActive: true } },
    });
  });

  it('create drops the trigger for a quick reply', async () => {
    await createMessageTemplate.handler({ kind: 'QUICK_REPLY', trigger: 'BOOKING_CONFIRMED', body: 'On my way!' }, ctx);
    expect(lastCall().opts.body).toEqual({ kind: 'QUICK_REPLY', body: 'On my way!' });
  });

  it('update requires at least one field and sends only what changed', async () => {
    const empty = await updateMessageTemplate.handler({ templateId: ID }, ctx);
    expect(empty.isError).toBe(true);
    expect(mockBackendRequest).not.toHaveBeenCalled();
    await updateMessageTemplate.handler({ templateId: ID, isActive: false }, ctx);
    expect(lastCall()).toMatchObject({ method: 'PUT', path: `/message-templates/${ID}`, opts: { token: T, body: { isActive: false } } });
    expect(Object.keys(lastCall().opts.body)).toEqual(['isActive']);
    await updateMessageTemplate.handler({ templateId: ID, kind: 'QUICK_REPLY', trigger: 'POST_RETURN', body: 'Hi' }, ctx);
    expect(lastCall().opts.body).toEqual({ kind: 'QUICK_REPLY', body: 'Hi' });
    await updateMessageTemplate.handler({ templateId: ID, kind: 'LIFECYCLE', trigger: 'PICKUP_REMINDER_24H' }, ctx);
    expect(lastCall().opts.body).toEqual({ kind: 'LIFECYCLE', trigger: 'PICKUP_REMINDER_24H' });
  });

  it('delete confirms which template was removed', async () => {
    mockBackendRequest.mockResolvedValue({ deleted: true });
    const res = await deleteMessageTemplate.handler({ templateId: ID }, ctx);
    expect(lastCall()).toMatchObject({ method: 'DELETE', path: `/message-templates/${ID}`, opts: { token: T } });
    expect(JSON.parse(text(res))).toEqual({ deleted: true, templateId: ID });
  });

  it('surfaces backend errors as isError results with a status hint', async () => {
    mockBackendRequest.mockRejectedValueOnce(new BackendApiError(403, 'Forbidden'));
    const res = await getMessageTemplate.handler({ templateId: ID }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not allowed for this account: Forbidden/);
  });
});
