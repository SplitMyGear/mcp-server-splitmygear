import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { readBackendJwtClaims } from '@/lib/jwt';

export interface AuthResult {
  success: boolean;
  userId?: string;
  role?: string;
  /**
   * The caller's raw backend JWT, forwarded by user-scoped tools to the backend
   * REST API (SPLIT-226). Present only on the bearer-token path — the operator
   * key and api_keys paths carry no per-user token, so they cannot drive
   * user-scoped backend mutations.
   */
  token?: string;
  error?: string;
}

export async function authMiddleware(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');

  // DENY BY DEFAULT (security lockdown 2026-06-12): this server wields a
  // Supabase service-role key — there is no safe 'public' tier. Every request
  // must present the operator API key or a valid bearer token. If auth is
  // unconfigured we fail CLOSED.
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

  // Bearer path — a SplitMyGear backend JWT (issued by POST /api/v1/users/login).
  // User-scoped tools forward this token to the backend, which is the single
  // authority for auth/RBAC/ownership (SPLIT-226 / M4). We decode it for the
  // acting user id and optionally verify its signature locally (jwt.ts). The
  // previous supabase.auth.getUser() path expected Supabase Auth tokens, which
  // the marketplace never issues — so real users could not authenticate at all.
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const claims = readBackendJwtClaims(token);
    if (!claims?.sub) {
      return { success: false, error: 'Invalid token' };
    }
    return {
      success: true,
      userId: claims.sub,
      role: claims.role || 'renter',
      token,
    };
  }

  // Optional operator-managed API keys stored in Supabase. This is the only
  // path that still needs Supabase; the bearer path no longer does.
  if (apiKey) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!supabaseUrl || !supabaseAnonKey) {
      return { success: false, error: 'Supabase configuration missing' };
    }
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
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

  return { success: false, error: 'No authentication provided' };
}
