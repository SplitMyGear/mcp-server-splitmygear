import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  error?: string;
}

export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');
  // Read env per-request so tests and rotation behave; Vercel sets these once.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  // DENY BY DEFAULT (security lockdown 2026-06-12): this server wields a
  // Supabase service-role key and a Stripe secret — there is no safe
  // 'public' tier. Every request must present the operator API key or a
  // valid Supabase bearer token. If auth is unconfigured we fail CLOSED.
  const operatorKey = process.env.MCP_API_KEY;
  if (!operatorKey) {
    return { success: false, error: 'Server auth not configured' };
  }
  if (apiKey && apiKey === operatorKey) {
    return { success: true, role: 'admin' };
  }
  if (!apiKey && !authHeader) {
    return { success: false, error: 'No authentication provided' };
  }

  if (!supabaseUrl || !supabaseAnonKey) {
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
