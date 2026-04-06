import { supabase, Listing, SearchFilters } from '@/lib/supabase';
import { aiService } from '@/lib/ai-service';

export const listingTools = {
  async searchListings(initialFilters: SearchFilters): Promise<Listing[]> {
    let filters = { ...initialFilters };

    if (filters.query) {
      const aiFilters = await aiService.parseSearchQuery(filters.query);
      const combinedFilters = { ...filters, ...aiFilters };
      
      // Attempt Vector Search via RPC
      try {
        const queryEmbedding = await aiService.generateEmbedding(filters.query);
        if (queryEmbedding && queryEmbedding.length > 0) {
          const { data: vectorResults, error: rpcError } = await supabase.rpc('match_listings', {
            query_embedding: queryEmbedding,
            match_threshold: 0.5, // Broad threshold for discovery
            match_count: 50,
            p_category: combinedFilters.category || null,
            p_location: combinedFilters.location || null,
            p_min_price: combinedFilters.minPrice || null,
            p_max_price: combinedFilters.maxPrice || null,
          });

          if (!rpcError && vectorResults && vectorResults.length > 0) {
            return vectorResults;
          }
        }
      } catch (e) {
        console.warn('Vector search failed, falling back to keyword matching:', e);
      }

      filters = combinedFilters;
    }

    let query = supabase
      .from('listing')
      .select('*')
      .eq('status', 'active');

    if (filters.location) {
      query = query.ilike('location', `%${filters.location}%`);
    }

    if (filters.category) {
      query = query.eq('category', filters.category);
    }

    if (filters.minPrice) {
      query = query.gte('pricePerDay', filters.minPrice);
    }

    if (filters.maxPrice) {
      query = query.lte('pricePerDay', filters.maxPrice);
    }

    if (filters.guests) {
      query = query.gte('maxGuests', filters.guests);
    }

    if (filters.query && !filters.location && !filters.category) {
      // If we only have a query, search name and description
      query = query.or(`name.ilike.%${filters.query}%,description.ilike.%${filters.query}%`);
    }

    const { data, error } = await query.limit(50);

    if (error) {
      console.error('Search error:', error);
      return [];
    }

    return data || [];
  },

  async getListingDetails(listingId: string): Promise<Listing | null> {
    const { data, error } = await supabase
      .from('listing')
      .select('*')
      .eq('id', listingId)
      .single();

    if (error) {
      console.error('Get listing error:', error);
      return null;
    }

    return data;
  },

  async checkAvailability(
    listingId: string,
    checkIn: string,
    checkOut: string,
    guests: number
  ): Promise<{ available: boolean; message: string }> {
    const listing = await this.getListingDetails(listingId);
    
    if (!listing) {
      return { available: false, message: 'Listing not found' };
    }

    if (listing.maxGuests < guests) {
      return { available: false, message: `Maximum guests for this listing is ${listing.maxGuests}` };
    }

    const { data: bookings } = await supabase
      .from('booking')
      .select('*')
      .eq('listingId', listingId)
      .eq('status', 'confirmed')
      .or(`checkIn.lte.${checkOut},checkOut.gte.${checkIn}`);

    if (bookings && bookings.length > 0) {
      return { available: false, message: 'Selected dates are not available' };
    }

    return { available: true, message: 'Dates are available' };
  },

  async getSimilarListings(listingId: string, limit = 5): Promise<Listing[]> {
    const { data: listing, error } = await supabase
      .from('listing')
      .select('*, embedding')
      .eq('id', listingId)
      .single();
    
    if (error || !listing) {
      return [];
    }

    // Attempt embedding-based similarity
    if (listing.embedding && Array.isArray(listing.embedding)) {
      try {
        const { data: vectorResults, error: rpcError } = await supabase.rpc('match_listings', {
          query_embedding: listing.embedding,
          match_threshold: 0.7, // Higher threshold for "similar"
          match_count: limit + 1, // +1 because it might return itself
          p_category: listing.category,
        });

        if (!rpcError && vectorResults) {
          return (vectorResults as any[]).filter(l => l.id !== listingId).slice(0, limit);
        }
      } catch (e) {
        console.warn('Similar listings vector search failed:', e);
      }
    }

    // Fallback to category matching
    const { data } = await supabase
      .from('listing')
      .select('*')
      .eq('category', listing.category)
      .neq('id', listingId)
      .eq('status', 'available')
      .limit(limit);

    return data || [];
  },

  async getPersonalizedRecommendations(userId: string, limit = 5): Promise<Listing[]> {
    // 1. Get user booking history
    const { data: bookings } = await supabase
      .from('booking')
      .select('listingId')
      .eq('userId', userId)
      .limit(20);

    if (!bookings || bookings.length === 0) {
      // Fallback to top-rated or recent listings if no history
      const { data: fallbackListings } = await supabase
        .from('listing')
        .select('*')
        .eq('status', 'active')
        .order('createdAt', { ascending: false })
        .limit(limit);
      return fallbackListings || [];
    }

    const listingIds = bookings.map((b) => b.listingId);

    // 2. Get categories of those listings to find preferences
    const { data: pastListings } = await supabase
      .from('listing')
      .select('category')
      .in('id', listingIds);

    if (!pastListings || pastListings.length === 0) {
      return [];
    }

    // 3. Count category frequencies
    const categoryCounts: Record<string, number> = {};
    pastListings.forEach((l) => {
      categoryCounts[l.category] = (categoryCounts[l.category] || 0) + 1;
    });

    // 4. Sort categories by frequency
    const sortedCategories = Object.keys(categoryCounts).sort(
      (a, b) => categoryCounts[b] - categoryCounts[a]
    );

    // 5. Get recommendations from top categories
    const topCategory = sortedCategories[0];
    const { data: recommendations } = await supabase
      .from('listing')
      .select('*')
      .eq('category', topCategory)
      .eq('status', 'active')
      .not('id', 'in', `(${listingIds.join(',')})`) // Don't recommend what they already booked
      .limit(limit);

    return recommendations || [];
  },
};
