// The dashboard's Content-Security-Policy. Scripts: only /dashboard.js from this server (no inline script, no inline
// event-handler attributes: see js-actions.ts). Inline STYLES stay allowed (the page uses style attributes).
export const DASHBOARD_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Headers a scanner (ZAP) asked for on the dashboard page and script: no camera, mic, location etc.; resources not loadable by other origins. */
export const DASHBOARD_EXTRA_HEADERS = {
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;
