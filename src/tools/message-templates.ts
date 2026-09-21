/**
 * Vendor message templates: thin clients of the backend `/message-templates`
 * routes (`@Roles(VENDOR)`; row ownership is enforced server-side via the
 * caller's JWT, never a caller-supplied vendor id).
 *
 * Two kinds exist (SPLIT-173 / SPLIT-486):
 *   - LIFECYCLE: bound to a booking trigger and delivered to the renter
 *     automatically by the backend dispatcher.
 *   - QUICK_REPLY: a canned in-chat snippet with no trigger; never auto-sent.
 *     Sending it is a separate step through the chat tools (send_message).
 *
 * Only `CreateMessageTemplateDto` / `UpdateMessageTemplateDto` fields are ever
 * sent: the backend's global ValidationPipe rejects undeclared fields (400).
 */
import { call, compact, qs } from './_shared';

export const MESSAGE_TEMPLATE_KINDS = ['LIFECYCLE', 'QUICK_REPLY'] as const;
export type MessageTemplateKind = (typeof MESSAGE_TEMPLATE_KINDS)[number];

export const MESSAGE_TEMPLATE_TRIGGERS = ['BOOKING_CONFIRMED', 'PICKUP_REMINDER_24H', 'RETURN_REMINDER_24H', 'POST_RETURN'] as const;
export type MessageTemplateTrigger = (typeof MESSAGE_TEMPLATE_TRIGGERS)[number];

/** Placeholders the backend renderer substitutes in a template body (mirrors TEMPLATE_VARIABLES). */
export const MESSAGE_TEMPLATE_VARIABLES = [
  'renterName',
  'listingName',
  'startDate',
  'endDate',
  'pickupLocation',
  'vendorName',
  'startTime',
  'endTime',
  'bookingTime',
] as const;

export interface MessageTemplateInput {
  kind?: MessageTemplateKind;
  trigger?: MessageTemplateTrigger;
  name?: string;
  subject?: string;
  body: string;
  isActive?: boolean;
}

export const messageTemplateApi = {
  /** GET /message-templates[?kind=] : the caller's templates, most recently updated first. */
  list(token: string, kind?: MessageTemplateKind) {
    return call('GET', `/message-templates${qs({ kind })}`, { token });
  },

  get(templateId: string, token: string) {
    return call('GET', `/message-templates/${templateId}`, { token });
  },

  create(token: string, input: MessageTemplateInput) {
    return call('POST', '/message-templates', { token, body: compact(input) });
  },

  update(templateId: string, token: string, input: Partial<MessageTemplateInput>) {
    return call('PUT', `/message-templates/${templateId}`, { token, body: compact(input) });
  },

  remove(templateId: string, token: string) {
    return call('DELETE', `/message-templates/${templateId}`, { token });
  },
};
