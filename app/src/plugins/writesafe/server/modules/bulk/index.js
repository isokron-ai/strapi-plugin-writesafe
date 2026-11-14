'use strict';

/**
 * Module `bulk`: the ws_bulk tool (filter-scoped patch or publish as a resumable job). Engine: ../_bulk/jobs.js.
 * Declares the job tables (../_bulk/store.js), which ws_replace uses too: content types are declared whether the
 * module is on or off, and a table of a module that is off stays empty.
 */
const J = require('../_bulk/jobs');
const U = require('../_bulk/util');
const S = require('../_bulk/store');

module.exports = {
  name: 'bulk',
  tools: (strapi, api) => [J.toolDef(strapi, U.helpers(api), U.settings(strapi))],
  contentTypes: S.contentTypes,
};
