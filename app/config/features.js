module.exports = ({ env }) => ({
  // Content Manager custom order (Strapi 5.62+). Off by default; the lock stress arm `order` turns it on with
  // STRAPI_FUTURE_CUSTOM_ORDER=true (tests/stress/lock_soak.py). Older Strapi versions ignore the flag.
  future: { unstableCustomOrder: env.bool('STRAPI_FUTURE_CUSTOM_ORDER', false) },
});
