/** Vendor message templates: reusable lifecycle messages and canned chat quick replies. Vendor family only. */
import { z } from 'zod';
import { defineTool, fail, fromResult } from '../registry';
import { messageTemplateApi, MESSAGE_TEMPLATE_KINDS, MESSAGE_TEMPLATE_TRIGGERS, MESSAGE_TEMPLATE_VARIABLES } from '../message-templates';
import { uuid, READ, WRITE, WRITE_IDEMPOTENT, DESTRUCTIVE, token } from './common';

const PLACEHOLDERS = MESSAGE_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ');

const kindField = z
  .enum(MESSAGE_TEMPLATE_KINDS)
  .describe('LIFECYCLE: sent to the renter automatically when the trigger fires. QUICK_REPLY: a canned chat snippet with no trigger, never sent automatically.');

const triggerField = z
  .enum(MESSAGE_TEMPLATE_TRIGGERS)
  .describe(
    'Booking event that sends a LIFECYCLE template: BOOKING_CONFIRMED (when the vendor accepts a booking), PICKUP_REMINDER_24H (the day before pickup), ' +
      'RETURN_REMINDER_24H (the day before return), POST_RETURN (when the booking is completed; good for a thank-you and review request). Ignored for QUICK_REPLY.',
  );

const templateFields = {
  name: z.string().min(1).max(150).optional().describe('Vendor-facing label, e.g. "Pickup instructions". Not shown to renters.'),
  subject: z.string().min(1).max(200).optional().describe('Optional subject line (used by the email channel).'),
  body: z.string().min(1).max(5000).describe(`Message text. May use the placeholders ${PLACEHOLDERS}; unknown placeholders render as empty text.`),
  isActive: z.boolean().optional().describe('false pauses a LIFECYCLE template without deleting it (default true).'),
};

export const listMessageTemplates = defineTool({
  name: 'list_message_templates',
  title: 'List message templates',
  description:
    'List the signed-in vendor\'s saved message templates, most recently updated first: LIFECYCLE templates that Splitt sends to the renter automatically ' +
    'when a booking event fires, and QUICK_REPLY canned snippets the vendor pastes into chat. Optionally filter by kind. ' +
    'Returns id, kind, trigger, name, subject, body, isActive and timestamps. Templates are drafts only; to send text to someone use send_message.',
  access: 'vendor',
  scope: 'messaging',
  inputSchema: { kind: kindField.optional() },
  annotations: READ,
  handler: async ({ kind }, ctx) => fromResult(await messageTemplateApi.list(token(ctx), kind)),
});

export const getMessageTemplate = defineTool({
  name: 'get_message_template',
  title: 'Get message template',
  description:
    'Fetch one of the vendor\'s message templates by id, including its full body with {{placeholders}}. ' +
    'Use it to see current values before update_message_template, or to pull a QUICK_REPLY body to send via send_message.',
  access: 'vendor',
  scope: 'messaging',
  inputSchema: { templateId: uuid('message template') },
  annotations: READ,
  handler: async ({ templateId }, ctx) => fromResult(await messageTemplateApi.get(templateId, token(ctx))),
});

export const createMessageTemplate = defineTool({
  name: 'create_message_template',
  title: 'Create message template',
  description:
    'Save a reusable message template for the signed-in vendor. kind LIFECYCLE (the default) needs a trigger and is delivered to the renter automatically ' +
    'by Splitt when that booking event happens. kind QUICK_REPLY is a canned chat snippet with no trigger; nothing is sent when you create it, the vendor sends it later via send_message. ' +
    `The body may use ${PLACEHOLDERS}. Returns the created template.`,
  access: 'vendor',
  scope: 'messaging',
  inputSchema: {
    kind: kindField.optional().describe('Defaults to LIFECYCLE.'),
    trigger: triggerField.optional(),
    ...templateFields,
  },
  annotations: WRITE,
  handler: async (args, ctx) => {
    const kind = args.kind ?? 'LIFECYCLE';
    if (kind === 'LIFECYCLE' && !args.trigger) {
      return fail(`A LIFECYCLE template needs a trigger (${MESSAGE_TEMPLATE_TRIGGERS.join(', ')}). For a canned chat snippet pass kind QUICK_REPLY instead.`);
    }
    // A quick reply has no lifecycle binding; the backend would null the trigger anyway.
    const trigger = kind === 'QUICK_REPLY' ? undefined : args.trigger;
    return fromResult(await messageTemplateApi.create(token(ctx), { ...args, kind, trigger }));
  },
});

export const updateMessageTemplate = defineTool({
  name: 'update_message_template',
  title: 'Update message template',
  description:
    'Change any fields of one of the vendor\'s message templates; only the fields you pass change. Set isActive=false to pause a LIFECYCLE template without deleting it. ' +
    'Switching kind to QUICK_REPLY clears the trigger; a LIFECYCLE template must end up with one. Returns the updated template.',
  access: 'vendor',
  scope: 'messaging',
  inputSchema: {
    templateId: uuid('message template'),
    kind: kindField.optional(),
    trigger: triggerField.optional(),
    ...templateFields,
    body: templateFields.body.optional(),
  },
  annotations: WRITE_IDEMPOTENT,
  handler: async ({ templateId, ...rest }, ctx) => {
    if (Object.values(rest).every((v) => v === undefined)) return fail('Pass at least one field to update.');
    const trigger = rest.kind === 'QUICK_REPLY' ? undefined : rest.trigger;
    return fromResult(await messageTemplateApi.update(templateId, token(ctx), { ...rest, trigger }));
  },
});

export const deleteMessageTemplate = defineTool({
  name: 'delete_message_template',
  title: 'Delete message template',
  description:
    'Permanently delete one of the vendor\'s message templates. This cannot be undone; prefer update_message_template with isActive=false to pause a lifecycle template. ' +
    'Confirm with the user before calling.',
  access: 'vendor',
  scope: 'messaging',
  inputSchema: { templateId: uuid('message template') },
  annotations: DESTRUCTIVE,
  handler: async ({ templateId }, ctx) => fromResult(await messageTemplateApi.remove(templateId, token(ctx)), () => ({ deleted: true, templateId })),
});

export const messageTemplateTools = [listMessageTemplates, getMessageTemplate, createMessageTemplate, updateMessageTemplate, deleteMessageTemplate];
