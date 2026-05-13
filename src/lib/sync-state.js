const { readSheetValues, batchUpdateValues } = require("./feishu-sheets");

const DEFAULT_SYNC_STATE_SHEET = "_sync_state";
const SYNC_STATE_HEADERS = [
  "sync_key",
  "shopify_order_id",
  "shopify_order_name",
  "line_item_id",
  "split_index",
  "feishu_row",
  "transformed_at",
  "feishu_core_written_at",
  "feishu_logistics_written_at",
  "feishu_formula_written_at",
  "sync_key_written_at",
  "status",
  "retry_count",
  "last_error",
  "updated_at",
];

const SYNC_STATE_COL_END = "O";
const SYNC_STATE_READ_RANGE = `A2:${SYNC_STATE_COL_END}50000`;

function cellToInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalString(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeSyncStateRecord(record) {
  return {
    sync_key: normalizeString(record?.sync_key),
    shopify_order_id: normalizeOptionalString(record?.shopify_order_id),
    shopify_order_name: normalizeOptionalString(record?.shopify_order_name),
    line_item_id: normalizeOptionalString(record?.line_item_id),
    split_index: normalizeOptionalString(record?.split_index),
    feishu_row: normalizeOptionalString(record?.feishu_row),
    transformed_at: normalizeOptionalString(record?.transformed_at),
    feishu_core_written_at: normalizeOptionalString(record?.feishu_core_written_at),
    feishu_logistics_written_at: normalizeOptionalString(record?.feishu_logistics_written_at),
    feishu_formula_written_at: normalizeOptionalString(record?.feishu_formula_written_at),
    sync_key_written_at: normalizeOptionalString(record?.sync_key_written_at),
    status: normalizeOptionalString(record?.status),
    retry_count: cellToInt(record?.retry_count),
    last_error: normalizeOptionalString(record?.last_error),
    updated_at: normalizeOptionalString(record?.updated_at),
  };
}

function syncStateRecordToRow(record) {
  const r = normalizeSyncStateRecord(record);
  return [
    r.sync_key,
    r.shopify_order_id,
    r.shopify_order_name,
    r.line_item_id,
    r.split_index,
    r.feishu_row,
    r.transformed_at,
    r.feishu_core_written_at,
    r.feishu_logistics_written_at,
    r.feishu_formula_written_at,
    r.sync_key_written_at,
    r.status,
    r.retry_count,
    r.last_error,
    r.updated_at,
  ];
}

function rowToSyncStateRecord(row) {
  return normalizeSyncStateRecord({
    sync_key: row?.[0],
    shopify_order_id: row?.[1],
    shopify_order_name: row?.[2],
    line_item_id: row?.[3],
    split_index: row?.[4],
    feishu_row: row?.[5],
    transformed_at: row?.[6],
    feishu_core_written_at: row?.[7],
    feishu_logistics_written_at: row?.[8],
    feishu_formula_written_at: row?.[9],
    sync_key_written_at: row?.[10],
    status: row?.[11],
    retry_count: row?.[12],
    last_error: row?.[13],
    updated_at: row?.[14],
  });
}

function buildSyncStateMap(records) {
  const map = new Map();
  for (const record of records) {
    const normalized = normalizeSyncStateRecord(record);
    if (normalized.sync_key) {
      map.set(normalized.sync_key, normalized);
    }
  }
  return map;
}

function mergeSyncStateRecord(existing, patch) {
  return normalizeSyncStateRecord({
    ...normalizeSyncStateRecord(existing),
    ...patch,
  });
}

async function readSyncStateRecords(token, spreadsheetToken, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  const rows = await readSheetValues(token, spreadsheetToken, `${sheetName}!${SYNC_STATE_READ_RANGE}`);
  return rows.map(rowToSyncStateRecord).filter((record) => record.sync_key);
}

async function readSyncStateEntries(token, spreadsheetToken, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  const rows = await readSheetValues(token, spreadsheetToken, `${sheetName}!${SYNC_STATE_READ_RANGE}`);
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const record = rowToSyncStateRecord(rows[i]);
    if (record.sync_key) {
      entries.push({ rowNumber: i + 2, record });
    }
  }
  return entries;
}

async function readSyncStateMap(token, spreadsheetToken, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  const records = await readSyncStateRecords(token, spreadsheetToken, sheetName);
  return buildSyncStateMap(records);
}

async function writeSyncStateHeader(token, spreadsheetToken, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  await batchUpdateValues(token, spreadsheetToken, [
    { range: `${sheetName}!A1:${SYNC_STATE_COL_END}1`, values: [SYNC_STATE_HEADERS] },
  ]);
}

async function writeSyncStateRecords(token, spreadsheetToken, records, startRow = 2, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  if (!records.length) return;
  const endRow = startRow + records.length - 1;
  await batchUpdateValues(token, spreadsheetToken, [
    {
      range: `${sheetName}!A${startRow}:${SYNC_STATE_COL_END}${endRow}`,
      values: records.map(syncStateRecordToRow),
    },
  ]);
}

async function upsertSyncStateRecords(token, spreadsheetToken, patches, sheetName = DEFAULT_SYNC_STATE_SHEET) {
  const validPatches = patches
    .map((patch) => ({ ...patch, sync_key: normalizeString(patch?.sync_key) }))
    .filter((patch) => patch.sync_key);
  if (!validPatches.length) return;

  const entries = await readSyncStateEntries(token, spreadsheetToken, sheetName);
  const byKey = new Map(entries.map((entry) => [entry.record.sync_key, entry]));
  let appendRow = entries.reduce((max, entry) => Math.max(max, entry.rowNumber), 1) + 1;

  const valueRanges = [];
  for (const patch of validPatches) {
    const existing = byKey.get(patch.sync_key);
    if (existing) {
      const merged = mergeSyncStateRecord(existing.record, patch);
      valueRanges.push({
        range: `${sheetName}!A${existing.rowNumber}:${SYNC_STATE_COL_END}${existing.rowNumber}`,
        values: [syncStateRecordToRow(merged)],
      });
      existing.record = merged;
      continue;
    }

    const rowNumber = appendRow++;
    const normalized = normalizeSyncStateRecord(patch);
    valueRanges.push({
      range: `${sheetName}!A${rowNumber}:${SYNC_STATE_COL_END}${rowNumber}`,
      values: [syncStateRecordToRow(normalized)],
    });
    byKey.set(normalized.sync_key, { rowNumber, record: normalized });
  }

  await batchUpdateValues(token, spreadsheetToken, valueRanges);
}

module.exports = {
  DEFAULT_SYNC_STATE_SHEET,
  SYNC_STATE_HEADERS,
  buildSyncStateMap,
  mergeSyncStateRecord,
  normalizeSyncStateRecord,
  readSyncStateEntries,
  readSyncStateMap,
  readSyncStateRecords,
  rowToSyncStateRecord,
  syncStateRecordToRow,
  upsertSyncStateRecords,
  writeSyncStateHeader,
  writeSyncStateRecords,
};
