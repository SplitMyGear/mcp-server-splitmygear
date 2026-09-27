/**
 * Account tools — the signed-in user's own profile and notifications. Every
 * call forwards the caller's backend JWT; the backend derives the user from it.
 */
import { call, compact, qs } from './_shared';

export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  phone?: string;
  bio?: string;
  profileImageUrl?: string;
  dateOfBirth?: string;
  storeName?: string;
  storeDescription?: string;
  businessPhone?: string;
  businessAddress?: string;
}

export const accountTools = {
  getMyProfile(token: string) {
    return call('GET', '/users/me', { token });
  },

  updateMyProfile(token: string, update: ProfileUpdate) {
    return call('PUT', '/users/profile', { token, body: compact(update) });
  },

  getVendorOnboardingStatus(token: string) {
    return call('GET', '/vendor-onboarding/status', { token });
  },

  listNotifications(token: string, limit = 25, offset = 0) {
    return call('GET', `/notifications${qs({ limit, offset })}`, { token });
  },

  markNotificationRead(token: string, notificationId: string) {
    return call('PUT', `/notifications/${notificationId}/read`, { token });
  },

  markAllNotificationsRead(token: string) {
    return call('PUT', '/notifications/read-all', { token });
  },

  async getUnreadCounts(token: string) {
    const [chat, notifications] = await Promise.all([
      call<{ total?: number; perConversation?: unknown }>('GET', '/chat/unread-count', { token }),
      call<{ count?: number }>('GET', '/notifications/unread-count', { token }),
    ]);
    return {
      unreadMessages: chat.ok ? chat.data?.total ?? 0 : null,
      unreadMessagesPerConversation: chat.ok ? chat.data?.perConversation ?? null : null,
      unreadNotifications: notifications.ok ? notifications.data?.count ?? 0 : null,
      errors: [chat.ok ? null : `chat: ${chat.error}`, notifications.ok ? null : `notifications: ${notifications.error}`].filter(Boolean),
    };
  },
};
