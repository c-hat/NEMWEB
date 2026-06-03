/**
 * Next.js config for the NEMWEB forecast tracker.
 *
 * Static export to `out/` (gitignored). The repo root `public/` is served as-is,
 * so the committed data files are available at `<basePath>/data/*.json` and the
 * ingest pipeline keeps writing to `public/data/` untouched.
 *
 * GitHub Pages often serves a project site under a repo subpath
 * (e.g. https://user.github.io/nemweb). Set NEXT_PUBLIC_BASE_PATH=/nemweb at
 * build time so the app's assets and data fetches resolve under that prefix.
 * Defaults to "" for local dev / root deployments.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

module.exports = nextConfig;
