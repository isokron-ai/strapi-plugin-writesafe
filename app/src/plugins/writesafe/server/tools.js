'use strict';

const { z } = require('@strapi/utils');
const E = require('./engine');
const CFG = require('./config');
const MOD = require('./modules');
const R = require('./reply');
const G = require('./guidance');
const F = require('./force');
const INT = require('./compat/internals');
const META = require('./compat/schema-meta');

/**
 * Argument types (config.lenientArgs; MWS-IN-6). Strict by default since the MWS self-test (D4): a string sent where
 * the schema declares a boolean, integer, object or array is refused with a message that names the argument, the type
 * and the value, before the handler runs (isError; nothing is written). lenientArgs: true is the opt-in for clients
 * that send booleans and JSON objects/arrays as strings ("true", "{\"note\":\"x\"}"): where a string can only mean
 * one thing, it is decoded before validation. Either way the advertised JSON Schema is the declared type only: zod
 * renders a preprocess step as its target schema. Declaring string forms was measured to make models send strings.
 */
let LENIENT = false;
// What a typed argument must be; each entry carries its own article, so the message reads "must be <WANT>".
const WANT = {
  boolean: 'a JSON boolean (true or false, without quotes)',
  integer: 'a JSON integer (without quotes)',
  object: 'a JSON object, not a string that contains JSON',
  array: 'a JSON array, not a string that contains JSON',
  // a row position: "start"/"end" are valid strings, so the message names them (a model must not "fix" "end" into an object)
  position: '"start", "end" or a JSON object such as {"index": 0}, not a string that contains JSON',
};
// The value as the message shows it: at most 40 characters, with "…" when it was cut.
const shown = (v) => `${JSON.stringify(v.slice(0, 40))}${v.length > 40 ? '…' : ''}`;
const strictIssue = (want, v, path) => ({
  code: 'custom', input: v, ...(path ? { path } : {}),
  message: `must be ${WANT[want]}; a string was sent (${shown(v)}). Nothing was changed; send the call again with that type.`,
});
// ctx.addIssue with fatal, not ctx.issues.push. @strapi/utils exports z from 'zod/v4' on every Strapi in the peer range
// (zod 3.25's v4 build on 5.47 to 5.52, zod 4 from 5.53), whose ctx has issues; the classic zod 3 API's ctx does not,
// and push would throw a TypeError instead of refusing. fatal stops zod 3 from also running the inner schema ("Expected
// boolean, received object"); zod 4 stops on z.NEVER. Every flavour gives the same single issue.
const refuse = (ctx, want, v, path) => {
  ctx.addIssue({ ...strictIssue(want, v, path), fatal: true });
  return z.NEVER;
};
const refuseString = (want) => (v, ctx) => (typeof v === 'string' ? refuse(ctx, want, v) : v);
/** Strict step of a row position. The position is a union, which would hide the index's own message (and a JSON object
 * sent as a string) behind "Invalid input", so both are refused here by name. "start"/"end" pass. */
const refusePosition = (v, ctx) => {
  if (typeof v === 'string' && v.trim().startsWith('{')) return refuse(ctx, 'position', v);
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.index === 'string') return refuse(ctx, 'integer', v.index, ['index']);
  return v;
};
const asBool = (v) => (v === 'true' ? true : v === 'false' ? false : v);
const asJson = (open) => (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith(open)) return v;
  try { return JSON.parse(t); } catch { return v; }
};
// Only a safe integer is decoded (1.0 hardening item 9): "9007199254740993" would silently become another number.
const asInt = (v) => {
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return v;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) ? n : v;
};
// The mode is read when a value is parsed, not when the schema is built, so a schema made before register() (or
// cached) follows config.lenientArgs too.
const either = (lenient, strict) => (v, ctx) => (LENIENT ? lenient(v) : strict(v, ctx));
const L = {
  bool: (s) => z.preprocess(either(asBool, refuseString('boolean')), s),
  obj: (s) => z.preprocess(either(asJson('{'), refuseString('object')), s),
  arr: (s) => z.preprocess(either(asJson('['), refuseString('array')), s),
  int: (s) => z.preprocess(either(asInt, refuseString('integer')), s),
  /** "start"/"end" stay strings; a JSON object in a string is decoded (lenient) or refused by name (strict). */
  pos: (s) => z.preprocess(either(asJson('{'), refusePosition), s),
};

// Every reply's error objects get retryable/requires_reread (server/reply.js; 1.0 hardening item 1).
const ok = (reply) => { const sc = R.typeReply(reply); return { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc }; };
const fail = (reply) => { const sc = R.typeReply(reply); return { isError: true, content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc }; };
const errorOf = (e) => {
  const m = E.mapStrapiError(e);
  return { ok: false, error: m.payload };
};

// Read and write policies: the session gate passes when the token holds ANY of them;
// every call is then checked again per document with the content-manager permission checker.
// A policy needs a subject: one policy per supported content type.
// `action` may be a list (1.0 hardening item 9): ws_batch and ws_bulk do publish work too, so a publish-only token
// passes their gate; each item is still checked per document for the permission its own action needs.
const policies = (strapi, action) => ({ policies: [].concat(action).flatMap((a) => E.writableUids(strapi).map((subject) => ({ action: a, subject }))) });

const uidSchema = (strapi) => {
  const uids = E.writableUids(strapi);
  return (uids.length ? z.enum(uids) : z.string()).describe('Content type UID, e.g. api::page.page (collection and single types).');
};

const position = () => L.pos(z.union([
  z.enum(['start', 'end']), // enum, not two literals: `const` is refused by strict JSON-Schema validators that some MCP clients apply
  z.object({ before: z.string().describe('Row key to insert before.') }).strict(),
  z.object({ after: z.string().describe('Row key to insert after.') }).strict(),
  z.object({ index: L.int(z.number().int().min(0)).describe('0-based index in the current list.') }).strict(),
])).describe('Where to put the row: "start", "end" (default), {before: key}, {after: key} or {index: n}.');

const op = () => L.obj(z.object({
  op: z.enum([...MOD.BUILTIN_OPS, ...Object.keys(MOD.ops())]).describe('add (data; component on a dynamic zone), update (key + data), remove (key), move (key + position)'
    + `${Object.keys(MOD.ops()).length ? `, or a module op (${Object.keys(MOD.ops()).join(', ')})` : ''}.`),
  ...Object.assign({}, ...Object.values(MOD.ops()).map((o) => o.schema || {})),
  field: z.string().describe('A dynamic zone, repeatable component or blocks (rich text) field; for ref ops a to-many relation, multiple media, or the component holding one.'),
  key: z.string().optional().describe('Row key from ws_get `rows` (update, remove, move). Components: "<component uid>:<id>:<mac>", bound to the row\'s content (it changes when the row changes; a reply returns the new keys of rows you added or named); blocks nodes: "#<index>:<hash>".'),
  component: z.string().optional().describe('add on a dynamic zone: the component UID of the new row, e.g. blocks.text.'),
  data: L.obj(z.object({}).catchall(z.any())).optional().describe('add: the new row. update on a component row: only the fields to change (merged). update on a blocks node: the whole new node.'),
  ref: z.union([z.string(), z.number().int().positive()]).optional().describe('add/remove one link: a documentId, or a file documentId or id. Other links stay; no version needed.'),
  path: z.string().optional().describe('Ref op inside a component (with key: a row): the relation or media field, e.g. "people".'),
  position: position().optional(),
}).strict());

const documentIdSchema = z.string().optional().describe('Required for collection types. For a single type it may be left out (there is one document).');
const localeSchema = z.string().optional().describe('Localized types only: the locale to read or write (default: the default locale). Refused for types without i18n.');

const patchShape = (strapi) => ({
  uid: uidSchema(strapi),
  documentId: documentIdSchema,
  locale: localeSchema,
  expected_version: z.string().optional().describe('`version` from ws_get ("v3.…"; a bare updatedAt or an older "<updatedAt>~<hash>" token is refused). The write is refused with a version_conflict if the document changed since. Required for set and unset; row ops do not need it. Sending the same request again with the same version within 10 minutes (a retry) returns the first receipt (replayed, with current_version) instead of writing twice; to apply it again on purpose, send it with an idempotency_key.'),
  set: L.obj(z.object({}).catchall(z.any())).optional().describe('Fields to set; needs expected_version. Scalars replace; a single component merges into its row (row kept); a list field (dynamic zone, repeatable, blocks, to-many relation, multiple media) is replaced whole. Rows you send with their `_key` keep their identity.'),
  unset: L.arr(z.array(z.string())).optional().describe('Fields to clear (null, or [] for lists); needs expected_version.'),
  ops: L.arr(z.array(op())).optional().describe('Row-level edits applied to the CURRENT list inside the write transaction, so rows another writer added survive. No expected_version needed. A key whose row someone edited since you read it is refused with stale_row_key, a removed row with row_not_found: read again. The reply gives new keys only for the rows it added or that you named (rows.<field>.added, rekeyed).'),
  if_match: L.obj(z.object({}).catchall(z.any())).optional().describe('Instead of expected_version: {field: value you read}, top-level fields (compared whole), one entry per field you set or unset. A change to one of them: version_conflict (fields_changed); to other fields: no conflict.'),
  ...F.arg(z, L, 'Allow set and unset without expected_version (last write wins).'), // only with config.allowForce
});

/**
 * Input and output schemas are built once per registration (#41). Strapi's MCP service calls a tool's
 * resolveInputSchema every time it binds the registered tools to an SDK server (every MCP session), and zod 3.25's
 * `zod/v4` build (the `z` of @strapi/utils 5.47.0 to 5.52.1) keeps `.describe()` metadata in a strong Map: each fresh
 * set of described schemas stayed in memory until Strapi ran out of heap.
 *
 * Resolvers must be context-free: they are called without the session's context, so no schema can carry one token's
 * or request's data to another. What they read is fixed by register() (the plugin config, F.ALLOWED, the enabled
 * modules, the argument mode, which is read when a value is parsed) except the covered content types (uid enums;
 * localized ones for ws_localize), which are read live. So each register() starts its own cache (a config change takes
 * effect through register(), as before), and the key inside it is the tool, input or output, and the content types.
 */
let schemaBuilds = 0;
const contentTypesKey = (strapi) => JSON.stringify(E.writableUids(strapi).map((uid) => {
  const ct = strapi.contentTypes[uid];
  return `${uid}|${ct.kind}|${ct.pluginOptions && ct.pluginOptions.i18n && ct.pluginOptions.i18n.localized === true ? 'i18n' : ''}`;
}));
const memoSchema = (cache, strapi, name, which, build) => {
  if (typeof build !== 'function') return build;
  const make = () => {
    schemaBuilds += 1;
    // descriptions also in the MCP SDK's zod registry when it is another copy (compat/schema-meta.js)
    return META.copyMeta(build());
  };
  return () => {
    let key;
    try { key = `${name}\u0000${which}\u0000${contentTypesKey(strapi)}`; } catch { return make(); } // never break tools/list
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  };
};

/** What module tools get (server/modules/index.js): the engine, result helpers and schema helpers. */
const apiFor = (strapi) => ({
  engine: E, model: require('./model'), WsError: E.WsError, z, lenient: L,
  ok, fail, errorOf, policies: (action) => policies(strapi, action),
  uidSchema: () => uidSchema(strapi), documentIdSchema, localeSchema, patchShape: () => patchShape(strapi),
  /** `force` behind config.allowForce (server/force.js): forceArg(text) is the argument or {}; strict(shape) explains
   * its refusal; forceAllowed() for descriptions. */
  forceArg: (text) => F.arg(z, L, text), strict: (shape) => F.strict(z, shape), forceAllowed: () => F.allowed(),
  /** Run fn(…) as a write: one transaction, idempotency_key and dry_run handled, deadlock retry. */
  runWrite: (context, tool, args, fn, extra) => E.runWrite(strapi, context, tool, args, fn, extra),
});

function register(strapi) {
  const cfg = CFG.get(strapi);
  LENIENT = cfg.lenientArgs === true; // strict unless opted in (MWS-IN-6, self-test D4)
  F.configure(cfg); // before any schema or description is built
  const mods = MOD.load(strapi, cfg);
  if (mods.length) strapi.log.info(`[writesafe] modules on: ${mods.join(', ')}`);
  // Every handler of the plugin runs as its caller (E.withCaller), so reads load what the caller's permission
  // conditions reference (phase 1 review, 10a).
  let registeredCount = 0;
  const schemaCache = new Map(); // #41: this registration's schemas (memoSchema)
  const mcp = {
    registerTool: (def) => (registeredCount += 1) && strapi.ai.mcp.registerTool({
      ...def,
      // built once per registration and content-type set, not on every MCP session (#41)
      resolveInputSchema: memoSchema(schemaCache, strapi, def.name, 'input', def.resolveInputSchema),
      resolveOutputSchema: memoSchema(schemaCache, strapi, def.name, 'output', def.resolveOutputSchema),
      createHandler: (s, context) => {
        INT.noteContext(context); // compat row mcp.handler_context, once
        const inner = def.createHandler(s, context);
        return (input) => {
          // force while config.allowForce is off: refused before any tool code runs (schemas refuse it too)
          const refused = F.refusal(input && input.args);
          if (refused) return fail({ ok: false, error: refused });
          return E.withCaller(context, () => inner(input));
        };
      },
    }),
  };
  strapi.log.info(`[writesafe] registering ws_* tools for ${E.writableUids(strapi).join(', ') || '(no api:: content types yet)'}`);

  mcp.registerTool({
    name: 'ws_get',
    title: 'Write-safe: read a draft with its version',
    description: 'Read the draft of one document with its `version` token and the row keys of every list field. '
      + 'Read with this before editing: pass `version` as expected_version to ws_patch/ws_publish/ws_batch and use the keys in row ops. Read-only. '
      + `${G.RULE_READ} ${G.RULE_DATA}`,
    auth: policies(strapi, 'plugin::content-manager.explorer.read'),
    resolveInputSchema: () => z.object({
      uid: uidSchema(strapi), documentId: documentIdSchema, locale: localeSchema,
      fields: L.arr(z.array(z.string())).optional().describe('Only return these fields (version still covers the whole document).'),
      compare: z.enum(['published']).optional().describe('published: also return `published` = how the live (published) version differs from this draft, field by field.'),
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args }) => {
      try { return ok(await E.getDoc(strapi, context, args)); } catch (e) { return fail(errorOf(e)); }
    },
  });

  mcp.registerTool({
    name: 'ws_patch',
    title: 'Write-safe: version-checked patch with row-level list edits',
    description: 'Edit an existing document: use this instead of update_<type>/write_<type>, which replace whole lists and have no version check. '
      + 'Changes one draft atomically. Use ops for dynamic-zone, repeatable-component and blocks rows (add/update/remove/move by key) '
      + 'and single links of to-many relations and media (add/remove by ref), so other writers\' rows survive; use set/unset for fields, with expected_version. The write is refused if the document changed '
      + '(error.code version_conflict, with current_version, the current values and a retry hint). dry_run validates and rolls back. '
      + 'if_match checks only the fields you name. publish: "if_clean" also publishes if the draft had no other unpublished change. '
      + 'A retry of a request with expected_version (or if_match) returns the first receipt; idempotency_key does the same for a request without one. Returns a compact receipt (ids, versions, changed fields, new row keys). '
      + `${G.RULE_READ} ${G.RULE_DATA}`,
    auth: policies(strapi, 'plugin::content-manager.explorer.update'),
    resolveInputSchema: () => F.strict(z, {
      ...patchShape(strapi),
      dry_run: L.bool(z.boolean()).optional().describe('Validate and run the write, then roll it back. Nothing is stored. Strapi lifecycle hooks and Document Service middlewares do run during it (their database work is rolled back; webhooks are not sent). The reply adds `diff`: each touched field before and after (rows by key).'),
      idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request. Scoped to this token, tool, document and locale.'),
      return: z.enum(['receipt', 'full']).optional().describe('receipt (default) or full: also return the updated document.'),
      publish: z.enum(['if_clean']).optional().describe('Also publish in the same transaction, only if the draft equalled the live version before this patch; else published: false with publish_skipped. Needs publish permission.'),
      ...MOD.writeArgs(z), // [l10n/history] e.g. `agent` (history module)
    }),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try { return ok(await E.runWrite(strapi, context, 'ws_patch', args, () => E.applyPatch(strapi, context, args), extra)); } catch (e) { return fail(errorOf(e)); }
    },
  });

  mcp.registerTool({
    name: 'ws_publish',
    title: 'Write-safe: publish the draft you reviewed',
    description: 'Publish a draft only if it is still the version you reviewed (expected_version). Use this instead of publish_<type>. '
      + 'Refused with version_conflict otherwise, so another writer\'s unreviewed change is not published.',
    auth: policies(strapi, 'plugin::content-manager.explorer.publish'),
    resolveInputSchema: () => z.object({
      uid: uidSchema(strapi), documentId: documentIdSchema, locale: localeSchema,
      expected_version: z.string().describe('`version` from ws_get when you reviewed the draft.'),
      dry_run: L.bool(z.boolean()).optional().describe('Preview without publishing: checks the version, the permissions and Strapi\'s own publish validation, but does not call Strapi\'s publish (no lifecycle hooks or middlewares run). The reply adds `diff`: what publishing would change on the live version, field by field.'),
      idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
      ...MOD.writeArgs(z), // [l10n/history] e.g. `agent` (history module)
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try { return ok(await E.runWrite(strapi, context, 'ws_publish', args, () => E.applyPublish(strapi, context, args), extra)); } catch (e) { return fail(errorOf(e)); }
    },
  });

  mcp.registerTool({
    name: 'ws_batch',
    title: 'Write-safe: all-or-nothing batch',
    description: 'Apply several patches and publishes, across documents, in ONE transaction: all commit or none do (mode all_or_nothing). '
      + 'Each item is a ws_patch (action "patch", default) or ws_publish (action "publish") argument set plus an optional ref. '
      + 'On failure the reply lists per-item status: rolled_back, failed (with the error, e.g. version_conflict), not_attempted. '
      + 'idempotency_key covers the whole batch; dry_run validates every item and rolls back. A publish item needs expected_version, '
      + 'except after an earlier item of the batch patched the same document with expected_version (it then publishes what that patch left); '
      + 'the same goes for a later patch item with set/unset on that document.',
    auth: policies(strapi, ['plugin::content-manager.explorer.update', 'plugin::content-manager.explorer.publish']),
    resolveInputSchema: () => z.object({
      items: L.arr(z.array(L.obj(F.strict(z, {
        ref: z.string().optional().describe('Your label for this item, echoed in the reply.'),
        action: z.enum(['patch', 'publish']).optional().describe('patch (default): a ws_patch argument set; publish: a ws_publish argument set.'),
        ...patchShape(strapi),
      }))).min(1).max(100)).describe('1 to 100 patch or publish items, applied in order in one transaction.'),
      dry_run: L.bool(z.boolean()).optional().describe('Validate every item, then roll back. Nothing is stored. Patch items run Strapi lifecycle hooks and Document Service middlewares (rolled back; no webhooks); publish items are previews that do not call Strapi\'s publish.'),
      idempotency_key: z.string().min(8).max(200).optional().describe('Unique per intended change; reuse it only to retry the same request.'),
      ...MOD.writeArgs(z), // [l10n/history] e.g. `agent` (history module)
    }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args, extra }) => {
      try {
        return ok(await E.runWrite(strapi, context, 'ws_batch', args, () => E.applyBatch(strapi, context, args), extra));
      } catch (e) {
        if (e instanceof E.BatchAbort) return fail(E.batchAbortView(e, args.items, args.dry_run));
        return fail(errorOf(e));
      }
    },
  });

  const S = require('./schema');
  mcp.registerTool({
    name: 'ws_schema',
    title: 'Write-safe: content type structure',
    description: 'Read-only. Without uid: the content types the ws_* tools cover. With uid: every field the token can read (type, required, '
      + 'localized, how ws_patch edits it), and the shape of every component and dynamic-zone block it uses, nested ones included. '
      + 'Use it before writing rows so you send the right fields.',
    auth: policies(strapi, 'plugin::content-manager.explorer.read'),
    resolveInputSchema: () => z.object({ uid: uidSchema(strapi).optional() }).strict(),
    resolveOutputSchema: () => z.object({}).passthrough(),
    createHandler: (s, context) => async ({ args }) => {
      try { return ok(args.uid ? S.describeType(strapi, context, args.uid) : S.listTypes(strapi, context)); } catch (e) { return fail(errorOf(e)); }
    },
  });

  for (const def of MOD.tools(strapi, apiFor(strapi))) mcp.registerTool(def);
  INT.noteRegister(strapi, registeredCount); // compat row mcp.register_timing
}

module.exports = {
  register, apiFor, asInt, refuseString, refusePosition, WANT, L, position,
  /** tests only: switch the argument mode as register() does from config.lenientArgs */
  _setLenient: (on) => { LENIENT = on === true; },
  /** tests only: how many schemas were built (#41: a repeated resolve with the same key builds none) */
  _schemaBuilds: () => schemaBuilds,
};
