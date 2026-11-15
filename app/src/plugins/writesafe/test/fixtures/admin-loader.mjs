// Module resolve hook for settings-admin.test.js: the admin's Strapi-only imports go to admin-stubs.mjs.
const STUB = new URL('./admin-stubs.mjs', import.meta.url).href;
const STUBBED = ['@strapi/strapi/admin', '@strapi/design-system', 'react-router-dom'];
export async function resolve(specifier, context, next) {
  if (STUBBED.includes(specifier)) return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
