module.exports = ({ env }) => ({
  // CI runs the suite against the admin API and /mcp only, so it skips the admin panel build (SERVE_ADMIN_PANEL=false).
  serveAdminPanel: env.bool('SERVE_ADMIN_PANEL', true),
  auth: {
    secret: env('ADMIN_JWT_SECRET'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT'),
    },
  },
  secrets: {
    encryptionKey: env('ENCRYPTION_KEY'),
  },
  // Test app: the throwaway setup scripts and suites log in many times in a few minutes (integration and CI runs).
  rateLimit: {
    enabled: env.bool('ADMIN_RATE_LIMIT', true),
  },
  flags: {
    nps: env.bool('FLAG_NPS', true),
    promoteEE: env.bool('FLAG_PROMOTE_EE', true),
    docLinks: env.bool('FLAG_DOC_LINKS', true),
  },
});
