import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder';

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export interface Listing {
  id: string;
  name: string;
  description: string;
  category: string;
  pricePerDay: number;
  location: string;
  images: string[];
  amenities: string[];
  maxGuests: number;
  vendorId: string;
  status: string;
  createdAt: string;
}

export interface Booking {
  id: string;
  listingId: string;
  userId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  totalPrice: number;
  status: string;
  createdAt: string;
}

export interface Experience {
  id: string;
  title: string;
  description: string;
  category: string;
  pricePerPerson: number;
  location: string;
  hostId: string;
  status: string;
  createdAt: string;
}

export interface ExperienceSchedule {
  id: string;
  experienceId: string;
  date: string;
  startTime: string;
  endTime: string;
  spotsTotal: number;
  spotsBooked: number;
  status: string;
}

export interface Conversation {
  id: string;
  participant1Id: string;
  participant2Id: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  isRead: boolean;
  createdAt: string;
}

export interface SearchFilters {
  location?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  query?: string;
}
