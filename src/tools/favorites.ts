/** Favorites (wishlist) — always scoped to the caller by the backend. */
import { call } from './_shared';

export const favoriteTools = {
  list(token: string) {
    return call<{ success?: boolean; favorites?: unknown[] }>('GET', '/favorites', { token });
  },

  toggle(token: string, listingId: string) {
    return call<{ success?: boolean; isFavorite?: boolean }>('POST', '/favorites/toggle', { token, body: { listingId } });
  },
};
