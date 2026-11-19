// The dashboard's Content-Security-Policy. Scripts: only /dashboard.js from this server (no inline script, no inline
// event-handler attributes: see js-actions.ts). Inline STYLES stay allowed (the page uses style attributes).
export const DASHBOARD_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";
