const { feishuRequest, getTenantAccessToken, authHeaders } = require("../feishu-client");

/**
 * @param {string} spreadsheetToken
 * @param {string} range e.g. 独立站!B1:B5000 或 JSMd4Q!B1:B5000
 * @param {{ valueRenderOption?: string }} [options]
 */
async function readSheetValues(token, spreadsheetToken, range, options = {}) {
  const encoded = encodeURIComponent(range);
  const qs = new URLSearchParams();
  if (options.valueRenderOption) qs.set("valueRenderOption", options.valueRenderOption);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  const body = await feishuRequest(
    `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encoded}${query}`,
    { headers: authHeaders(token) },
  );
  const values = body.data?.valueRange?.values;
  return Array.isArray(values) ? values : [];
}

/**
 * @param {{ range: string, values: (string|number|object)[][] }[]} valueRanges
 */
async function batchUpdateValues(token, spreadsheetToken, valueRanges) {
  await feishuRequest(`/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_update`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ valueRanges }),
  });
}

/**
 * 读取单元格样式。飞书该接口返回结构在不同版本/租户可能略有差异，调用方需要用 extractBackColor 兼容。
 */
async function readRangeStyles(token, spreadsheetToken, range) {
  const encoded = encodeURIComponent(range);
  const body = await feishuRequest(
    `/sheets/v2/spreadsheets/${spreadsheetToken}/style?ranges=${encoded}`,
    { method: "GET", headers: authHeaders(token) },
  );
  return body.data || body;
}

/**
 * 尽量从飞书样式对象中提取背景色。
 */
function extractBackColor(styleCell) {
  if (!styleCell || typeof styleCell !== "object") return "";
  const candidates = [
    styleCell.backColor,
    styleCell.backgroundColor,
    styleCell.background_color,
    styleCell.style?.backColor,
    styleCell.style?.backgroundColor,
    styleCell.style?.background_color,
    styleCell.cellStyle?.backColor,
    styleCell.cellStyle?.backgroundColor,
    styleCell.cellStyle?.background_color,
  ];
  for (const v of candidates) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

/**
 * @returns {Promise<{ sheet_id: string, title: string, index: number, hidden: boolean, resource_type?: string }[]>}
 */
async function querySpreadsheetSheets(token, spreadsheetToken) {
  const body = await feishuRequest(`/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, {
    method: "GET",
    headers: authHeaders(token),
  });
  return Array.isArray(body.data?.sheets) ? body.data.sheets : [];
}

/** style 接口 range 需 sheet_id；与 read 使用的 sheetRef（标题或 id）对齐。 */
function resolveSpreadsheetSheetId(sheets, sheetRef) {
  const ref = String(sheetRef ?? "").trim();
  if (!ref) return "";
  if (sheets.some((s) => s.sheet_id === ref)) return ref;
  const exact = sheets.find((s) => String(s.title ?? "").trim() === ref);
  if (exact) return exact.sheet_id;
  const refLower = ref.toLowerCase();
  const fold = sheets.find((s) => String(s.title ?? "").trim().toLowerCase() === refLower);
  return fold?.sheet_id || "";
}

/**
 * @param {string} backColor 如 #FFF2CC
 */
async function appendRangeBackgroundColor(token, spreadsheetToken, sheetId, startRow, endRow, backColor) {
  await feishuRequest(`/sheets/v2/spreadsheets/${spreadsheetToken}/style`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({
      appendStyle: {
        range: `${sheetId}!A${startRow}:W${endRow}`,
        style: { backColor },
      },
    }),
  });
}

/**
 * 合并单元格（用于同订单号物流商合并显示）
 * @param {string} range e.g. sheetId!U10:U12
 * @param {"MERGE_ALL"|"MERGE_ROWS"|"MERGE_COLUMNS"} mergeType
 */
async function mergeCells(token, spreadsheetToken, range, mergeType = "MERGE_ALL") {
  await feishuRequest(`/sheets/v2/spreadsheets/${spreadsheetToken}/merge_cells`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ range, mergeType }),
  });
}

const HEADER_LABELS = new Set([
  "订单单号",
  "name",
  "订单号",
  "order",
  "shopify order",
]);

const SYNC_KEY_HEADER_LABELS = new Set([
  "sync_key",
  "sync key",
]);

function cellTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

function cellLower(s) {
  return s.trim().toLowerCase();
}

function normalizeOrderKey(name) {
  return cellTrim(name).replace(/^#+/, "");
}

function collectExistingOrderNames(values) {
  const names = new Set();
  for (const row of values) {
    const cell = cellTrim(row?.[0]);
    if (!cell) continue;
    if (HEADER_LABELS.has(cell) || HEADER_LABELS.has(cellLower(cell))) continue;
    names.add(normalizeOrderKey(cell));
  }
  return names;
}

function collectExistingSyncKeys(values) {
  const keys = new Set();
  for (const row of values) {
    const cell = cellTrim(row?.[0]);
    if (!cell) continue;
    if (SYNC_KEY_HEADER_LABELS.has(cellLower(cell))) continue;
    keys.add(cell);
  }
  return keys;
}

/** 1-based next row index for append (first empty row after last non-empty B in range). */
function computeNextAppendRow(values) {
  let lastNonEmpty = 0;
  for (let i = 0; i < values.length; i++) {
    const cell = cellTrim(values[i]?.[0]);
    if (cell) lastNonEmpty = i + 1;
  }
  return lastNonEmpty + 1;
}

module.exports = {
  getTenantAccessToken,
  readSheetValues,
  batchUpdateValues,
  readRangeStyles,
  extractBackColor,
  querySpreadsheetSheets,
  resolveSpreadsheetSheetId,
  appendRangeBackgroundColor,
  mergeCells,
  collectExistingOrderNames,
  collectExistingSyncKeys,
  computeNextAppendRow,
  normalizeOrderKey,
};
