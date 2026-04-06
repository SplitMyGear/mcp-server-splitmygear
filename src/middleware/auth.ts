import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  error?: string;
}

export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');

  const publicEndpoints = ['/api/mcp'];
  const isPublicEndpoint = publicEndpoints.some((ep) => request.nextUrl.pathname.startsWith(ep));

  // Public endpoints allow unauthenticated access (role = 'public')
  // Auth is optional — it unlocks additional capabilities (bookings, messaging, etc.)
  if (isPublicEndpoint && !apiKey && !authHeader) {
    return { success: true, role: 'public' };
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isPublicEndpoint) {
      return { success: true, role: 'public' };
    }
    return { success: false, error: 'Supabase configuration missing' };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  if (apiKey) {
    const { data: apiKeyData, error } = await supabase
      .from('api_keys')
      .select('user_id, role, rate_limit')
      .eq('key', apiKey)
      .single();

    if (error || !apiKeyData) {
      return { success: false, error: 'Invalid API key' };
    }

    return {
      success: true,
      userId: apiKeyData.user_id,
      role: apiKeyData.role,
    };
  }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return { success: false, error: 'Invalid token' };
    }

    const { data: userData } = await supabase
      .from('user')
      .select('role')
      .eq('id', user.id)
      .single();

    return {
      success: true,
      userId: user.id,
      role: userData?.role || 'renter',
    };
  }

  return { success: false, error: 'No authentication provided' };
}
