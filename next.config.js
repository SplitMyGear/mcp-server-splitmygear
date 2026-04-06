/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@supabase/supabase-js', 'stripe'],
};

module.exports = nextConfig;
