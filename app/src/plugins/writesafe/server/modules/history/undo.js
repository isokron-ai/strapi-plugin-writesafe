'use strict';

/**
 * ws_undo: revert exactly what one receipt changed, using the before-image the history module stored with it.
 * Design notes: docs/internals.md, section "server/modules/history/undo.js".
 */
const M = require('../../model');
const W = require('../_lib/write');
const C = require('./capture');

const RECEIPT_UID = C.RECEIPT_UID;

/**
 * 1.0 hardening item 1 (fourth review N4): the conflict reply no longer offers `force` as the next step, which erased the
 * later change. It carries the before values instead (`before`, only what the token may read), so the caller can put
 * back its own change by hand and keep the other one.
 */
/** Item 21: the hint on conflicts an undo left alone (on_conflict "skip"). Never offers force. */
const UNDO_SKIP_HINT = 'These documents changed after the receipt, so they were left as they are; everything else was undone. '
  + '`before` holds the values the receipt replaced (fields this token can read). To revert one by hand, read it (ws_get) and put back '
  + 'only what is still yours with ws_patch. on_conflict "stop" refuses the whole undo instead.';

const UNDO_HINT = 'These fields or rows changed after the receipt, so undoing it would overwrite someone else\'s later change. '
  + '`before` holds the values the receipt replaced (fields this token can read). To revert only your own change, read the '
  + 'document (ws_get), put those values back with ws_patch where they are still yours, and keep the later change. Nothing was undone.';

/** Receipt rows for an id: the receipt, or a job's chunk receipts (with documentId: only those that touched it). */
async function receiptRows(strapi, id, documentId) {
  const q = strapi.db.query(RECEIPT_UID);
  // `history` is read from moduleData.history (capture.histOf) once here; the rows are not written back from this view.
  const view = (r) => ({ ...r, history: C.histOf(r) });
  const one = await q.findOne({ where: { receiptId: id } });
  if (one) return [view(one)];
  const where = { receiptId: { $startsWith: `${id}~` }, ...(documentId ? { targets: { $contains: `~${documentId}~` } } : {}) };
  return (await q.findMany({ where, orderBy: { id: 'asc' }, limit: 10000 })).map(view);
}

const keyOf = (e) => `${e.uid}\u0000${e.documentId}\u0000${e.locale || ''}`;

/** Restored list for a row image: reverts the receipt's rows, keeps every other current row where it is. */
function restoreList(strapi, kind, attr, img, cur) {
  const ck = M.rowKeys(kind, attr, cur);
  const cm = new Map((cur || []).map((r, i) => [ck[i], r]));
  const before = new Set(img.o);
  const added = new Set(img.n.filter((k) => !before.has(k)));
  const stripRow = (r) => {
    const field = '_';
    const wrapped = W.stripIds(strapi, null, { [field]: [r] }, { [field]: attr });
    return wrapped[field][0];
  };
  const content = (k) => {
    if (k in img.b) {
      const b = img.b[k];
      return cm.has(k) ? { ...b, id: cm.get(k).id } : stripRow(b);
    }
    return cm.get(k);
  };
  let out;
  if (img.m) {
    out = img.o.filter((k) => (cm.has(k) && !added.has(k)) || k in img.b).map((k) => ({ k, row: content(k) }));
  } else {
    out = ck.filter((k) => !added.has(k)).map((k) => ({ k, row: content(k) }));
  }
  const has = (k) => out.some((x) => x.k === k);
  // Rows of the before-image that are not in the list now (removed by the receipt, or with force removed since):
  // put back after the nearest row that preceded them before.
  for (const [i, k] of img.o.entries()) {
    if (has(k) || !(k in img.b)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const p = out.findIndex((x) => x.k === img.o[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    out.splice(at, 0, { k, row: content(k) });
  }
  // Current rows that are not from the before-image or the receipt (added by someone else since): keep them after
  // the row they follow now.
  for (const [i, k] of ck.entries()) {
    if (has(k) || added.has(k)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const p = out.findIndex((x) => x.k === ck[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    out.splice(at, 0, { k, row: cm.get(k) });
  }
  return out.map((x) => x.row);
}

/** Fields and rows of an update entry that changed after the receipt (empty when the undo is safe). */
function changedSince(strapi, e, cur) {
  const attrs = M.attrsOf(strapi, e.uid);
  const out = [];
  for (const [f, img] of Object.entries(e.f || {})) if (!C.sameHash(cur[f] === undefined ? null : cur[f], img.a)) out.push(f);
  for (const [f, img] of Object.entries(e.r || {})) {
    const kind = M.fieldKind(attrs[f]);
    const ck = M.rowKeys(kind, attrs[f], cur[f]);
    const cm = new Map((cur[f] || []).map((r, i) => [ck[i], r]));
    for (const [k, h] of Object.entries(img.a || {})) if (!cm.has(k) || !C.sameHash(cm.get(k), h)) out.push(`${f}[${k}]`);
    // A receipt that moved rows puts the old order back: refused if the order was changed again since.
    if (img.m) {
      const after = img.n.filter((k) => cm.has(k));
      const now = ck.filter((k) => img.n.includes(k));
      if (after.join('\n') !== now.join('\n')) out.push(`${f}(order)`);
    }
  }
  return out;
}

/** The data that puts an update entry's fields back. */
function restoreData(strapi, e, cur) {
  const attrs = M.attrsOf(strapi, e.uid);
  const data = {};
  for (const [f, img] of Object.entries(e.f || {})) {
    const a = attrs[f];
    if (!a) continue;
    let v = img.b;
    if (a.type === 'component' && !a.repeatable && v) {
      const c = cur[f];
      v = c && c.id === v.id ? v : { ...W.stripIds(strapi, e.uid, { [f]: v })[f], ...(c ? { id: c.id } : {}) };
    }
    data[f] = v;
  }
  for (const [f, img] of Object.entries(e.r || {})) {
    if (!attrs[f]) continue;
    data[f] = restoreList(strapi, M.fieldKind(attrs[f]), attrs[f], img, cur[f]);
  }
  for (const f of Object.keys(data)) if (W.same(data[f], cur[f] === undefined ? null : cur[f])) delete data[f];
  return data;
}

async function readDraft(strapi, E, e) {
  try {
    return await E.lockAndRead(strapi, e.uid, e.documentId, e.locale || undefined);
  } catch (err) {
    if (err instanceof E.WsError && err.payload.code === 'not_found') return null;
    throw err;
  }
}

async function conflictPayload(strapi, ctx, E, e, raw, fields, extra) {
  const pc = E.permissionChecker(strapi, ctx, e.uid);
  const names = [...new Set(fields.map((f) => f.replace(/[[(].*$/, '')))].filter(Boolean);
  // What the receipt replaced, as this token may read it: an update's changed fields, a deleted document's content.
  const creator = raw ? Object.fromEntries(['createdBy', 'updatedBy'].filter((f) => raw[f]).map((f) => [f, raw[f]])) : {};
  const before = e.op === 'update' || e.op === 'delete' ? await C.visibleBefore(pc, e, e.op === 'update' ? names : undefined, creator) : null;
  if (!raw) {
    return { code: 'version_conflict', message: 'The document no longer exists.', uid: e.uid, documentId: e.documentId, locale: e.locale || null, current: null, changed_since: fields, before, ...extra };
  }
  const err = await E.conflict(strapi, pc, e.uid, raw, e.va || null, names);
  const p = { ...err.payload, uid: e.uid, changed_since: fields, before, ...extra };
  delete p.retry;
  delete p.expected_version;
  p.message = 'This changed after the receipt. Nothing was undone.';
  return p;
}

/** Version token of a draft (phase 2 A: "v2." over the uid, documentId, locale and the semantic hash of the raw row). */
const versionOf = (strapi, uid, raw) => M.versionOf(strapi, uid, raw);

/** Lock every target first, in one order (compat/db.js lockDocuments); returns the targets and their drafts. */
async function lockTargets(strapi, E, entries) {
  const targets = [...new Map(entries.filter((e) => e.op !== 'publish' && e.op !== 'import').map((e) => [keyOf(e), e])).values()]
    .sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1));
  const DB = require('../../compat/db');
  // recreates take a custom-ordered type's order lock first (docs/locking.md, phase 2 B)
  const CO = require('../../compat/custom-order');
  for (const u of [...new Set(entries.filter((e) => e.op === 'delete').map((e) => e.uid))].sort()) if (CO.enabled(strapi, u)) await CO.lockOrder(strapi, u);
  if (typeof DB.lockDocuments === 'function') {
    await DB.lockDocuments(strapi, targets.map((t) => ({ uid: t.uid, documentId: t.documentId })));
  }
  const raws = new Map();
  for (const t of targets) {
    if (typeof DB.lockDocuments !== 'function' && entries.some((e) => keyOf(e) === keyOf(t) && e.op === 'delete')) {
      await W.lockDocument(strapi, t.uid, t.documentId, E.hasDP(strapi, t.uid));
    }
    raws.set(keyOf(t), await readDraft(strapi, E, t));
  }
  return { targets, raws };
}

/** Read permission per entry (phase 1 review, item 10): an entry this token cannot read must not reach a reply. */
const cannotRead = (strapi, ctx, E, e, raw) => Boolean(raw) && E.writableUids(strapi).includes(e.uid) && E.permissionChecker(strapi, ctx, e.uid).cannot.read(raw);

const FILE_UID = 'plugin::upload.file';
/** The current draft of an entry's document without a lock (entries that are not reverted: publish, import, too large). */
async function readPlain(strapi, E, e) {
  if (!E.writableUids(strapi).includes(e.uid)) return null;
  return strapi.documents(e.uid).findOne({
    documentId: e.documentId, ...(e.locale ? { locale: e.locale } : {}), ...(E.hasDP(strapi, e.uid) ? { status: 'draft' } : {}), populate: M.populateFor(strapi, e.uid),
  });
}
/**
 * May this token see that this entry exists (review M2)? Checked before anything about an entry is named. Imports by
 * the media library's conditions; a document by its draft; a gone document only without read conditions.
 */
async function entryVisible(strapi, ctx, E, e, raw) {
  if (e.uid === FILE_UID) {
    try {
      const f = await require('../../compat/media').readableFiles(strapi, ctx && ctx.userAbility, [e.documentId]);
      return f.readable.has(e.documentId);
    } catch { return false; }
  }
  if (!E.writableUids(strapi).includes(e.uid)) return false;
  const pc = E.permissionChecker(strapi, ctx, e.uid);
  return !pc.cannot.read(raw || (e.locale ? { locale: e.locale } : {}));
}

/** Revert one locked entry: {kind: 'item' | 'conflict' | 'skipped', value}. opt: {force, dryRun, args, raw?}. */
async function revertOne(strapi, ctx, E, e, opt) {
  const where = { uid: e.uid, documentId: e.documentId, locale: e.locale || null, item: e.ref ?? e.i };
  const a = opt.args || {};
  if (e.op === 'publish') return { kind: 'skipped', value: { ...where, op: 'publish', reason: 'a publish is not undone; the draft is reverted by undoing the patch that changed it' } };
  if (e.op === 'import') return { kind: 'skipped', value: { ...where, op: 'import', reason: 'a Media Library import is not undone; delete the file in the Media Library if nothing uses it' } };
  if (e.expired) return { kind: 'skipped', value: { ...where, op: e.op, reason: 'expired', message: `history is kept ${C.opts().retentionDays} days` } };
  if (e.t) {
    return { kind: 'skipped', value: { ...where, op: e.op, reason: 'too_large', message: e.tr === 'job' ? `the job had used its before-image budget (${C.opts().maxJobBeforeBytes} bytes) when this document was written` : `its before-image was over ${C.opts().maxBeforeBytes} bytes` } };
  }
  const tag = () => C.tagLast({ uo: [e.rid, e.i] });
  const raw = opt.raw !== undefined ? opt.raw : await readDraft(strapi, E, e);
  if (e.op === 'update') {
    if (!raw) return { kind: 'conflict', value: await conflictPayload(strapi, ctx, E, e, null, ['(document)'], { item: where.item }) };
    const cur = M.normalize(strapi, e.uid, raw);
    const changed = changedSince(strapi, e, cur);
    if (changed.length && !opt.force) return { kind: 'conflict', value: await conflictPayload(strapi, ctx, E, e, raw, changed, { item: where.item }) };
    const data = restoreData(strapi, e, cur);
    if (!Object.keys(data).length) return { kind: 'item', value: { ...where, op: 'unchanged' } };
    const r = await W.writeFields(strapi, ctx, E, { tool: 'ws_undo', action: 'patch', uid: e.uid, documentId: e.documentId, locale: e.locale || undefined, raw, data, args: a, dryRun: opt.dryRun });
    tag();
    return { kind: 'item', value: { ...where, op: 'restored', fields: Object.keys(data), version: versionOf(strapi, e.uid, r.raw), ...(changed.length ? { overwrote: changed } : {}) } };
  }
  if (e.op === 'create') {
    if (!raw) return { kind: 'item', value: { ...where, op: 'already_gone' } };
    const cur = M.normalize(strapi, e.uid, raw);
    // Content hash when the receipt has one (1.0 hardening item 8): a version would also move with the timestamp alone.
    const changedSinceCreate = e.ha ? C.h16(C.stripDoc(cur)) !== e.ha : versionOf(strapi, e.uid, raw) !== e.va;
    if (changedSinceCreate && !opt.force) return { kind: 'conflict', value: await conflictPayload(strapi, ctx, E, e, raw, ['(document changed since it was created)'], { item: where.item }) };
    // Deleting also removes a published version, and publishing does not change the draft's version.
    const live = E.hasDP(strapi, e.uid) && await strapi.db.query(e.uid).findOne({ select: ['id'], where: { documentId: e.documentId, ...(e.locale ? { locale: e.locale } : {}), publishedAt: { $notNull: true } } });
    if (live && !opt.force) return { kind: 'conflict', value: await conflictPayload(strapi, ctx, E, e, raw, ['(published since it was created)'], { item: where.item }) };
    await W.deleteLocale(strapi, ctx, E, { tool: 'ws_undo', uid: e.uid, documentId: e.documentId, locale: e.locale || undefined, raw, args: a, dryRun: opt.dryRun });
    tag();
    return { kind: 'item', value: { ...where, op: 'deleted' } };
  }
  if (e.op === 'delete') {
    if (raw && !opt.force) return { kind: 'conflict', value: await conflictPayload(strapi, ctx, E, e, raw, ['(document exists again)'], { item: where.item }) };
    const data = W.stripIds(strapi, e.uid, e.doc);
    const r = await W.recreate(strapi, ctx, E, { tool: 'ws_undo', uid: e.uid, documentId: e.documentId, locale: e.locale || undefined, raw, data, args: a, dryRun: opt.dryRun });
    tag();
    return { kind: 'item', value: { ...where, op: 'recreated', status: 'draft', version: versionOf(strapi, e.uid, r.raw), ...(r.doc.documentId !== e.documentId ? { new_documentId: r.doc.documentId } : {}) } };
  }
  return { kind: 'skipped', value: { ...where, op: e.op, reason: 'unknown entry type' } };
}

/** The undone receipt rows of a set of reverted entries: per receipt, the entry indexes (null: the whole receipt). */
function undoRowsOf(rows, doneEntries, whole) {
  return rows.map((r) => ({ id: r.receiptId, items: whole ? null : [...new Set(doneEntries.filter((e) => e.rid === r.receiptId).map((e) => e.i))] }))
    .filter((x) => x.items === null || x.items.length);
}

/**
 * The inline undo, in ONE transaction. "skip" (default): conflicts are left alone and listed, the rest is reverted
 * (nothing revertable: version_conflict). "stop": one conflict refuses all of it. Never offers force.
 */
async function applyUndo(strapi, ctx, E, a) {
  const rows = await receiptRows(strapi, a.receipt_id, a.documentId);
  if (!rows.length) throw new E.WsError({ code: 'not_found', message: `No receipt ${a.receipt_id}. ws_history lists receipts.`, receipt_id: a.receipt_id });
  for (const row of rows) {
    if (!row.history || C.expired(row)) {
      throw new E.WsError({ code: 'not_found', message: `Receipt ${row.receiptId || a.receipt_id} has expired (history is kept ${C.opts().retentionDays} days).`, receipt_id: a.receipt_id });
    }
    if (row.history.t) throw new E.WsError({ code: 'unsupported', message: `Receipt ${row.receiptId} changed too much to keep a before-image (over ${C.opts().maxBeforeBytes} bytes per document), so it cannot be undone.`, receipt_id: row.receiptId });
    // force overrides a changed-since conflict, never this: re-applying an undone change would apply it twice.
    if (row.history.undone_by) {
      throw new E.WsError({ code: 'already_undone', message: `Receipt ${row.receiptId} was already undone by ${row.history.undone_by}. To redo the change, undo ${row.history.undone_by}.`, receipt_id: row.receiptId, undone_by: row.history.undone_by });
    }
  }
  // pos: the receipt's place in time (rows come oldest first), so a job is reverted newest chunk first.
  let entries = rows.flatMap((row, pos) => row.history.e.map((e) => ({ ...e, rid: row.receiptId, pos })));
  if (a.item !== undefined) {
    // A ref names one item; an index is accepted only for a single receipt (a job's chunks each start at 0).
    const byRef = entries.filter((e) => e.ref !== undefined && String(e.ref) === String(a.item));
    entries = byRef.length ? byRef : rows.length === 1 ? entries.filter((e) => String(e.i) === String(a.item)) : [];
    if (!entries.length) throw new E.WsError({ code: 'not_found', message: `Receipt ${a.receipt_id} has no item ${a.item}.`, items: rows.flatMap((r) => r.history.e.map((e) => e.ref ?? e.i)) });
  }
  const doneBy = (e) => ((rows.find((r) => r.receiptId === e.rid).history.undone_items) || {})[e.i];
  if (a.item !== undefined || a.documentId !== undefined) {
    const already = entries.find((e) => doneBy(e) && (a.documentId === undefined || e.documentId === a.documentId));
    if (already && (a.item !== undefined || entries.filter((e) => e.documentId === a.documentId).every((e) => doneBy(e)))) {
      throw new E.WsError({ code: 'already_undone', message: `Item ${already.ref ?? already.i} of ${already.rid} was already undone by ${doneBy(already)}.`, undone_by: doneBy(already) });
    }
  }
  // Items of a receipt that were undone one by one are not undone again.
  const before = entries.length;
  entries = entries.filter((e) => !doneBy(e));
  if (a.item === undefined && a.documentId === undefined && before && !entries.length) {
    const by = [...new Set(rows.flatMap((r) => Object.values(r.history.undone_items || {})))];
    throw new E.WsError({ code: 'already_undone', message: `Every item of receipt ${a.receipt_id} was already undone (by ${by.join(', ')}).`, receipt_id: a.receipt_id, undone_by: by[0] });
  }
  if (a.documentId) entries = entries.filter((e) => e.documentId === a.documentId && (a.locale === undefined || (e.locale || null) === (a.locale || null)));
  if (!entries.length) throw new E.WsError({ code: 'not_found', message: `Receipt ${a.receipt_id} changed nothing in ${a.documentId}${a.locale ? ` (${a.locale})` : ''}.` });
  if (entries.every((e) => e.op === 'import')) {
    throw new E.WsError({ code: 'unsupported', message: `Receipt ${a.receipt_id} is a Media Library import; ws_undo does not delete files. Delete the file in the Media Library if nothing uses it.`, receipt_id: a.receipt_id });
  }
  if (entries.every((e) => e.t || e.op === 'publish' || e.op === 'import') && entries.some((e) => e.t)) {
    throw new E.WsError({ code: 'unsupported', message: `Receipt ${a.receipt_id} changed too much to keep a before-image (over ${C.opts().maxBeforeBytes} bytes per document), so it cannot be undone.`, receipt_id: a.receipt_id });
  }

  // Lock every target first, in one order (as ws_batch does), then revert per document from the last write back.
  const { targets, raws } = await lockTargets(strapi, E, entries);
  const forbidden = () => new E.WsError({ code: 'forbidden', message: `Receipt ${a.receipt_id} changed an entry this token cannot read. Nothing was undone.`, receipt_id: a.receipt_id });
  for (const t of targets) {
    // An undo of a receipt that touched an entry this token cannot read is refused before anything about that entry
    // (documentId, fields, version, current values) can reach a reply.
    if (cannotRead(strapi, ctx, E, t, raws.get(keyOf(t)))) throw forbidden();
  }
  // the entries that are only skipped (publish, import) are named in `skipped`: checked the same way (review M2)
  for (const e of entries.filter((x) => x.op === 'publish' || x.op === 'import')) {
    const raw = e.op === 'import' ? null : await readPlain(strapi, E, e);
    if (!(await entryVisible(strapi, ctx, E, e, raw))) throw forbidden();
  }
  const ordered = [...entries].sort((x, y) => (keyOf(x) === keyOf(y) ? (y.pos - x.pos || y.i - x.i) : (keyOf(x) < keyOf(y) ? -1 : 1)));
  const onConflict = a.on_conflict || 'skip';
  const conflicts = [];
  const items = [];
  const skipped = [];
  const done = [];
  for (const e of ordered) {
    const r = await revertOne(strapi, ctx, E, e, { force: a.force, dryRun: a.dry_run, args: a });
    if (r.kind === 'item') { items.push(r.value); done.push(e); } else if (r.kind === 'conflict') conflicts.push(r.value);
    else skipped.push(r.value);
  }
  if (conflicts.length && (onConflict === 'stop' || !items.length)) {
    const first = conflicts[0];
    throw new E.WsError({
      ...(conflicts.length === 1 ? first : {}),
      code: 'version_conflict',
      message: `${conflicts.length === 1 ? 'A field or row' : `${conflicts.length} documents`} changed after receipt ${a.receipt_id}. Nothing was undone.`,
      receipt_id: a.receipt_id,
      ...(conflicts.length > 1 ? { conflicts } : {}),
      retry: { hint: UNDO_HINT },
    });
  }
  // Which receipts (and, for a partial undo, which of their items) this undo reverts: ws_history shows them as undone.
  // An undo that skipped anything (conflicts, too large) marks item by item, so the rest stays undoable.
  const partial = a.item !== undefined || a.documentId !== undefined || conflicts.length > 0 || skipped.some((x) => x.reason === 'too_large' || x.reason === 'expired');
  C.annotate({ undo_of: a.receipt_id, ...(done.length ? { undo_rows: undoRowsOf(rows, done, !partial) } : {}) });
  const out = { ok: true, undo_of: a.receipt_id, items };
  if (conflicts.length) {
    out.conflicts = conflicts.map((c) => { const { retry, ...rest } = c; return rest; });
    out.conflicts_hint = UNDO_SKIP_HINT;
  }
  if (skipped.length) out.skipped = skipped;
  return out;
}

module.exports = {
  applyUndo, revertOne, lockTargets, cannotRead, entryVisible, readPlain, conflictPayload, readDraft, keyOf, undoRowsOf, versionOf, restoreList, changedSince, restoreData, receiptRows, UNDO_HINT, UNDO_SKIP_HINT,
};
