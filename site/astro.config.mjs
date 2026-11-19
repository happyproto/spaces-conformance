import { defineConfig } from 'astro/config'

// Static output only (design ch. 8.1): every page is built from
// src/data/site.json, which scripts/data.ts writes from the results store.
// SITE_URL is where it's served; the canonical links follow it.
export default defineConfig({
  site: process.env.SITE_URL || 'https://conformance.happyproto.at',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
})
