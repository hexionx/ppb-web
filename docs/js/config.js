/**
 * config.js — Frontend Deployment Configuration (GitHub Pages: docs/js/config.js)
 *
 * Replace all placeholder strings below before publishing to GitHub Pages.
 * See MIGRATION_GUIDE.md in the repository root for exact instructions on where
 * to obtain each value.
 */
window.PB_CONFIG = {
  /**
   * 1. SUPABASE_URL
   * Your Supabase Project URL from:
   *   Supabase Dashboard -> Project Settings -> Data API -> Project URL
   * Example: 'https://abcdefghijklmnopqrst.supabase.co'
   */
  SUPABASE_URL: 'https://uqkbbevzwpbronolqizv.supabase.co',

  /**
   * 2. SUPABASE_ANON_KEY
   * Your Supabase public `anon` / publishable key from:
   *   Supabase Dashboard -> Project Settings -> API Keys -> anon / public
   * Security note: User credentials (`users` & `sessions`) are locked behind RLS
   * and verified exclusively inside PostgreSQL SECURITY DEFINER RPC functions.
   */
  SUPABASE_ANON_KEY: 'sb_publishable_R8Ths6aIYSEwk-qFvTm03w_F7WmJfLI',

  /**
   * 3. GAS_TOKEN_WEBAPP_URL
   * Web App URL ending in `/exec` from your standalone `gas-token-provider`
   * Apps Script deployment:
   *   Apps Script Editor -> Deploy -> Manage deployments -> Web app URL
   * Example: 'https://script.google.com/macros/s/AKfycb.../exec'
   */
  GAS_TOKEN_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbxKc9_400Q5pG_PozxIioNTvFjKi1ULhvXW0EGrKaiiDeD4PYQG_EWyFe4c8VEb9ySz0A/exec',

  /**
   * 4. GAS_SECRET_KEY
   * Shared secret query parameter validated by `gas-token-provider/Code.gs`.
   * Must match the Script Property `GAS_SECRET_KEY` in the Apps Script editor.
   */
  GAS_SECRET_KEY: 'pb_gas_3538dfa38166170dd882333bf311c4207a833ac1',

  /**
   * 5. GOOGLE_DRIVE_FOLDER_ID
   * Destination Google Drive folder ID for uploaded images, PDFs, and receipts.
   * Existing folder ID from legacy deployment: '1vtFBqT_vHTBTscK8KQXNZmCU_tf31PZ6'
   */
  GOOGLE_DRIVE_FOLDER_ID: '1vtFBqT_vHTBTscK8KQXNZmCU_tf31PZ6',

  /**
   * Client-side HTML5 Canvas image compression settings (before Drive upload).
   */
  IMAGE_MAX_WIDTH: 1280,
  IMAGE_QUALITY: 0.8,

  /**
   * When true, newly uploaded Drive files receive `anyone` (reader) permission so
   * direct `googleusercontent.com` image URLs render immediately without an OAuth
   * header per <img> tag. If set to false, the portal automatically falls back to
   * authenticated Google Drive REST v3 (`?alt=media`) blob fetching via OAuth token.
   */
  DRIVE_SET_ANYONE_READER: true,

  /**
   * Request timeout (ms) for token/Drive/Supabase HTTP operations.
   */
  REQUEST_TIMEOUT_MS: 120000
};
