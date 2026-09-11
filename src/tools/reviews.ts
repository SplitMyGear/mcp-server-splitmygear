/** Reviews: public listing reviews, the caller's own reviews, and vendor responses. */
import { call, compact } from './_shared';

export const reviewTools = {
  async getListingReviews(listingId: string) {
    const [reviews, summary] = await Promise.all([
      call<unknown[]>('GET', `/reviews/listing/${listingId}`),
      call('GET', `/reviews/listing/${listingId}/summary`),
    ]);
    if (!reviews.ok) return reviews;
    return { ok: true as const, data: { summary: summary.ok ? summary.data : null, reviews: reviews.data } };
  },

  createReview(
    token: string,
    input: { type: 'listing' | 'user'; listingId?: string; reviewedUserId?: string; rating: number; comment?: string },
  ) {
    return call('POST', '/reviews', { token, body: compact(input) });
  },

  listMyReviews(token: string) {
    return call('GET', '/reviews/my-reviews', { token });
  },

  updateReview(token: string, reviewId: string, update: { rating?: number; comment?: string }) {
    return call('PUT', `/reviews/${reviewId}`, { token, body: compact(update) });
  },

  deleteReview(token: string, reviewId: string) {
    return call('DELETE', `/reviews/${reviewId}`, { token });
  },

  respondToReview(token: string, reviewId: string, response: string, mode: 'create' | 'update') {
    return call(mode === 'create' ? 'POST' : 'PUT', `/reviews/${reviewId}/response`, { token, body: { response } });
  },

  deleteReviewResponse(token: string, reviewId: string) {
    return call('DELETE', `/reviews/${reviewId}/response`, { token });
  },
};
