// Admin panel entry of the writesafe plugin (1.0 hardening, Phase 4 stream G): the "Write-safe jobs" page, where an
// admin approves or rejects bulk jobs agents asked for, and pauses, resumes or cancels running ones.
// Plain ES module with React.createElement (no JSX, no build step): Strapi's admin bundler takes it as it is.
import * as React from 'react';
import { install as installFormBase } from './form-base.mjs';

const PERMISSIONS = [{ action: 'plugin::writesafe.approve-jobs', subject: null }];

function Icon() {
  // a check mark in a shield, drawn with the current text color
  return React.createElement('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    React.createElement('path', { d: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'm8.5 12 2.5 2.5 4.5-5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
}


export default {
  register(app) {
    // stale form guard (bench X4): each tab echoes the version its edit form was loaded at (form-base.mjs)
    installFormBase();
    app.addMenuLink({
      to: 'plugins/writesafe',
      icon: Icon,
      intlLabel: { id: 'writesafe.plugin.name', defaultMessage: 'Write-safe jobs' },
      permissions: PERMISSIONS,
      Component: () => import('./JobsPage.mjs').then((mod) => ({ default: mod.JobsPage })),
    });
    // Settings > Global settings > Write-safe MCP: the effective configuration, and runtime tightening (SettingsPage.mjs)
    app.addSettingsLink('global', {
      id: 'writesafe-settings',
      to: 'writesafe',
      intlLabel: { id: 'writesafe.settings.name', defaultMessage: 'Write-safe MCP' },
      permissions: [{ action: 'plugin::writesafe.settings.read', subject: null }],
      Component: () => import('./SettingsPage.mjs').then((mod) => ({ default: mod.ProtectedSettingsPage })),
    });
    app.registerPlugin({ id: 'writesafe', name: 'writesafe' });
  },
  bootstrap() {},
  async registerTrads({ locales }) {
    return locales.map((locale) => ({ data: {}, locale }));
  },
};
