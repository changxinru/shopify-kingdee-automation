const { Parser } = require("json2csv");
const fs = require("fs");
const path = require("path");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const {
  readSheetValues,
  batchUpdateValues,
  collectExistingOrderNames,
  computeNextAppendRow,
  normalizeOrderKey,
  querySpreadsheetSheets,
  resolveSpreadsheetSheetId,
  appendRangeBackgroundColor,
  mergeCells,
} = require("./lib/feishu-sheets");
const { normalizeShop, loadMappingTables, fetchRecentPaidOrders } = require("./lib/shopify-orders");
const { buildOutputLinesFromOrder, isPaidAndNotCancelled } = require("./lib/order-transform");
const { shiftFormulaRowRefs } = require("./lib/formula-shift");

const {
  buildWarehouseNotices,
} = require("./shared/order-logic");

const OUTPUT_DIR = path.join(getProjectRoot(), "output");
const SHOPIFY_FIRST = 50;
const FEISHU_B_RANGE_ROWS = 30000;
const FEISHU_NEW_ROW_HIGHLIGHT_COLOR = "#FFF258";
const FEISHU_KINGDEE_ACTION_COL = "V";
const FEISHU_KINGDEE_RESULT_COL = "W";
/** V 列「同步状态」允许值（与飞书下拉一致；3/4 由调拨/金蝶后续更新，sync 只写 1、2 或 5） */
const SYNC_STATUS_DIRECT_SALES = "1. 待直接生成销售订单";
const SYNC_STATUS_NEED_TRANSFER_FIRST = "2. 待先生成调拨单";
const SYNC_STATUS_TRANSFER_DONE_WAIT_SALES = "3. 调拨完成待生成销售订单";
const SYNC_STATUS_SALES_SAVED = "4. 完成保存销售订单";
const SYNC_STATUS_FAILED = "5. 同步失败";

function isDryRun() {
  return String(process.env.DRY_RUN ?? "").trim().toLowerCase() === "true";
}

function dryRunLog(message) {
  console.log(`[DRY_RUN] ${message}`);
}

async function safeBatchUpdateValues(feishuToken, spreadsheetToken, valueRanges, label = "batchUpdateValues") {
  if (isDryRun()) {
    const parts = valueRanges.map((vr) => {
      const rows = Array.isArray(vr.values) ? vr.values.length : 0;
      return `${vr.range} (${rows} rows)`;
    });
    dryRunLog(`${label}: ${parts.join("; ")}`);
    return;
  }
  await batchUpdateValues(feishuToken, spreadsheetToken, valueRanges);
}

function formatSyncDate() {
  const d = new Date();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 飞书/Excel 日期序列数（与 Excel 1900 日期系一致：1899-12-30 为 0 天），写入 A 列可避免「以文本储存的日期」。
 * 使用本地日历的年月日。
 */
function excelDateSerialLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const epoch = Date.UTC(1899, 11, 30);
  const t = Date.UTC(y, m, day);
  const serial = (t - epoch) / 86400000;
  return Math.round(serial * 100000) / 100000;
}

function feishuNumericCell(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function orderDisplayName(name) {
  return normalizeOrderKey(name) || String(name ?? "").trim();
}

function cellTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

function indexToColumnName(idx1Based) {
  let n = Number(idx1Based);
  if (!Number.isFinite(n) || n < 1) return "";
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 飞书 V 列同步状态：与行数据 transfer_required 一致（美国收款 + 实际 SZSG 发货 → 2. 先调拨）。
 * 状态 3、4 不在此写入，避免覆盖后续金蝶或人工维护。
 */
function feishuColumnVSyncStatus(line) {
  if (String(line?.status ?? "").trim() === "error") {
    return SYNC_STATUS_FAILED;
  }
  if (String(line?.transfer_required ?? "").trim() === "yes") {
    return SYNC_STATUS_NEED_TRANSFER_FIRST;
  }
  return SYNC_STATUS_DIRECT_SALES;
}

function feishuColumnWResult(line) {
  if (String(line?.status ?? "").trim() === "error") {
    return String(line?.error ?? "").trim();
  }
  return "";
}

function toFeishuWriteCell(cell, deltaRow) {
  if (cell == null || cell === "") return "";
  if (typeof cell === "object" && cell != null) {
    if (cell.type === "formula" && typeof cell.text === "string") {
      return { type: "formula", text: shiftFormulaRowRefs(cell.text, deltaRow) };
    }
  }
  const s = typeof cell === "string" ? cell : String(cell);
  if (s.startsWith("=")) return { type: "formula", text: shiftFormulaRowRefs(s, deltaRow) };
  return cell;
}

async function appendGtRowsFromTemplateLegacy(feishuToken, spreadsheetToken, sheetRef, startRow, endRow) {
  if (startRow < 2 || endRow < startRow) return;
  const templateRow = startRow - 1;
  const range = `${sheetRef}!G${templateRow}:T${templateRow}`;
  let rows;
  try {
    rows = await readSheetValues(feishuToken, spreadsheetToken, range, { valueRenderOption: "Formula" });
  } catch (e) {
    console.error("读取模板行 G:T 失败，跳过公式复制：", e.message || e);
    return;
  }
  const templateCells = rows[0] || [];
  if (!templateCells.length) return;
  const out = [];
  for (let r = startRow; r <= endRow; r++) {
    const delta = r - templateRow;
    out.push(templateCells.map((cell) => toFeishuWriteCell(cell, delta)));
  }
  try {
    await safeBatchUpdateValues(feishuToken, spreadsheetToken, [
      { range: `${sheetRef}!G${startRow}:T${endRow}`, values: out },
    ], "legacy formula write");
  } catch (e) {
    console.error("写入 G:T 失败：", e.message || e);
  }
}

function checkShopifyEnv() {
  const missing = [];
  if (!String(process.env.SHOPIFY_SHOP ?? "").trim()) missing.push("SHOPIFY_SHOP");
  if (!String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim()) missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join("、")}`);
    process.exit(1);
  }
}

function checkFeishuEnv() {
  const missing = [];
  if (!String(process.env.FEISHU_APP_ID ?? process.env.LARK_APP_ID ?? "").trim()) {
    missing.push("FEISHU_APP_ID（或 LARK_APP_ID）");
  }
  if (!String(process.env.FEISHU_APP_SECRET ?? process.env.LARK_APP_SECRET ?? "").trim()) {
    missing.push("FEISHU_APP_SECRET（或 LARK_APP_SECRET）");
  }
  const hasSpreadsheet = String(process.env.FEISHU_SPREADSHEET_TOKEN ?? "").trim();
  const hasWiki = String(process.env.FEISHU_WIKI_TOKEN ?? "").trim();
  if (!hasSpreadsheet && !hasWiki) {
    missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  }
  if (missing.length) {
    console.error(`缺少飞书配置：${missing.join("、")}`);
    process.exit(1);
  }
}

function getFeishuCredentials() {
  const appId = String(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || "").trim();
  const wikiToken = String(process.env.FEISHU_WIKI_TOKEN || "").trim();
  const envSpreadsheetToken = String(process.env.FEISHU_SPREADSHEET_TOKEN || "").trim();
  const sheetRef =
    String(process.env.FEISHU_SHEET_ID || "").trim() ||
    String(process.env.FEISHU_SHEET_NAME || "独立站").trim();
  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
}

const SALES_ORDER_CSV_FIELDS = [
  "order_name",
  "platform",
  "payment_method",
  "payment_owner",
  "sales_org",
  "customer_code",
  "original_sku",
  "product_name_for_check",
  "kingdee_material_code",
  "quantity",
  "unit_price",
  "actual_ship_stock_org",
  "sales_order_stock_org",
  "stock_org",
  "transfer_required",
  "transfer_from_stock_org",
  "transfer_to_stock_org",
  "shipping_country",
  "shipping_province",
  "receiver_name",
  "receiver_phone",
  "receiver_address",
  "logistics_provider",
  "logistics_service",
  "fulfillment_type",
  "need_warehouse_notice",
  "provider_address",
  "status",
  "error",
];

const TRANSFER_ORDER_CSV_FIELDS = [
  "order_name",
  "platform",
  "payment_method",
  "payment_owner",
  "sales_org",
  "original_sku",
  "product_name_for_check",
  "kingdee_material_code",
  "quantity",
  "transfer_from_stock_org",
  "transfer_to_stock_org",
  "shipping_country",
  "logistics_provider",
  "logistics_service",
  "remark",
];

const TRANSFER_REMARK = "美国收款订单，需先做销售调拨：SZSG → XGSG，再做销售订单。";

function writeLocalOutputs(allLinesForCsv) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const salesOrderCsv = new Parser({ fields: SALES_ORDER_CSV_FIELDS, withBOM: true }).parse(allLinesForCsv);
  fs.writeFileSync(path.join(OUTPUT_DIR, "sales-order-lines.csv"), salesOrderCsv, "utf-8");

  const transferOrderLines = allLinesForCsv
    .filter((line) => line.transfer_required === "yes")
    .map((line) => ({
      order_name: line.order_name,
      platform: line.platform,
      payment_method: line.payment_method,
      payment_owner: line.payment_owner,
      sales_org: line.sales_org,
      original_sku: line.original_sku,
      product_name_for_check: line.product_name_for_check,
      kingdee_material_code: line.kingdee_material_code,
      quantity: line.quantity,
      transfer_from_stock_org: line.transfer_from_stock_org,
      transfer_to_stock_org: line.transfer_to_stock_org,
      shipping_country: line.shipping_country,
      logistics_provider: line.logistics_provider,
      logistics_service: line.logistics_service,
      remark: TRANSFER_REMARK,
    }));

  const transferOrderCsv = new Parser({ fields: TRANSFER_ORDER_CSV_FIELDS, withBOM: true }).parse(transferOrderLines);
  fs.writeFileSync(path.join(OUTPUT_DIR, "transfer-order-lines.csv"), transferOrderCsv, "utf-8");

  const warehouseNotices = buildWarehouseNotices(allLinesForCsv);
  fs.writeFileSync(path.join(OUTPUT_DIR, "warehouse-notices.txt"), warehouseNotices, "utf-8");
}

function linesToFeishuRows(lines, syncDateSerial) {
  const af = [];
  const uCol = [];
  for (const line of lines) {
    af.push([
      syncDateSerial,
      line.order_name,
      line.product_name_for_check,
      line.payment_method,
      feishuNumericCell(line.unit_price),
      feishuNumericCell(line.quantity),
    ]);
    uCol.push([line.logistics_provider]);
  }
  return { af, uCol };
}

function cellFilled(value) {
  return value != null && String(value).trim() !== "";
}

async function appendGtRowsFromTemplateStrict(feishuToken, spreadsheetToken, sheetRef, startRow, endRow) {
  if (startRow < 2 || endRow < startRow) return;
  const templateRow = startRow - 1;
  const range = `${sheetRef}!G${templateRow}:T${templateRow}`;
  const rows = await readSheetValues(feishuToken, spreadsheetToken, range, { valueRenderOption: "Formula" });
  const templateCells = rows[0] || [];
  if (!templateCells.length) return;

  const out = [];
  for (let r = startRow; r <= endRow; r++) {
    const delta = r - templateRow;
    out.push(templateCells.map((cell) => toFeishuWriteCell(cell, delta)));
  }

  await safeBatchUpdateValues(feishuToken, spreadsheetToken, [
    { range: `${sheetRef}!G${startRow}:T${endRow}`, values: out },
  ], "formula write");
}

function nowIso() {
  return new Date().toISOString();
}

async function tryHighlightAppendRows(feishuToken, spreadsheetToken, sheetRef, startRow, endRow) {
  if (!Number.isFinite(startRow) || !Number.isFinite(endRow) || endRow < startRow) return;
  try {
    const sheets = await querySpreadsheetSheets(feishuToken, spreadsheetToken);
    const sheetId = resolveSpreadsheetSheetId(sheets, sheetRef);
    if (!sheetId) {
      console.warn("新增行标黄失败：无法解析工作表 ID，请核对 FEISHU_SHEET_ID / FEISHU_SHEET_NAME 与工作表标题是否一致");
      return;
    }
    await appendRangeBackgroundColor(feishuToken, spreadsheetToken, sheetId, startRow, endRow, FEISHU_NEW_ROW_HIGHLIGHT_COLOR);
  } catch (error) {
    console.warn(`新增行标黄失败：${error?.message || String(error)}`);
  }
}

/**
 * 同订单号（B列 order_name）视为同物流商：将 U 列对应区间按订单分组纵向合并。
 * 仅合并本次新增行范围，失败不影响主流程。
 */
async function tryMergeLogisticsProviderForNewRows(feishuToken, spreadsheetToken, sheetRef, sheetId, lines) {
  if (!lines?.length) return;
  const byOrder = new Map();
  for (const line of lines) {
    const order = String(line.order_name ?? "").trim();
    const row = Number(line.feishu_row);
    if (!order || !Number.isFinite(row) || row <= 0) continue;
    if (!byOrder.has(order)) byOrder.set(order, []);
    byOrder.get(order).push(row);
  }

  try {
    for (const rows of byOrder.values()) {
      if (rows.length <= 1) continue;
      rows.sort((a, b) => a - b);
      const start = rows[0];
      const end = rows[rows.length - 1];
      if (end <= start) continue;
      // 同一订单新增行通常是连续的；为稳妥仍允许不连续，但只合并连续段
      let segStart = start;
      let prev = start;
      for (let i = 1; i < rows.length; i++) {
        const cur = rows[i];
        if (cur === prev + 1) {
          prev = cur;
          continue;
        }
        if (prev > segStart) {
          await mergeCells(feishuToken, spreadsheetToken, `${sheetId}!U${segStart}:U${prev}`, "MERGE_ALL");
        }
        segStart = cur;
        prev = cur;
      }
      if (prev > segStart) {
        await mergeCells(feishuToken, spreadsheetToken, `${sheetId}!U${segStart}:U${prev}`, "MERGE_ALL");
      }
    }
  } catch (error) {
    console.warn(`同订单号物流商合并失败：${error?.message || String(error)}`);
  }
}

async function writeNewLines(feishuToken, spreadsheetToken, sheetRef, lines, syncDateSerial, startRow) {
  if (!lines.length) return 0;
  const endRow = startRow + lines.length - 1;
  lines.forEach((line, index) => {
    line.feishu_row = startRow + index;
  });
  const { af, uCol } = linesToFeishuRows(lines, syncDateSerial);

  await safeBatchUpdateValues(feishuToken, spreadsheetToken, [
    { range: `${sheetRef}!A${startRow}:F${endRow}`, values: af },
  ], "new append A:F");

  await safeBatchUpdateValues(feishuToken, spreadsheetToken, [
    { range: `${sheetRef}!U${startRow}:U${endRow}`, values: uCol },
  ], "new append U");

  await appendGtRowsFromTemplateStrict(feishuToken, spreadsheetToken, sheetRef, startRow, endRow);

  return lines.length;
}

function printSyncSummary(summary) {
  console.log("同步摘要：");
  console.log(`created: ${summary.created}`);
  console.log(`skipped: ${summary.skipped}`);
  console.log(`compensationCandidates: ${summary.compensationCandidates}`);
  console.log(`compensationSucceeded: ${summary.compensationSucceeded}`);
  console.log(`compensationFailed: ${summary.compensationFailed}`);
  console.log(`failed: ${summary.failed}`);
  console.log(`writtenRows: ${summary.writtenRows}`);
  console.log(`failures: ${JSON.stringify(summary.failures)}`);
}

async function main() {
  loadEnv();
  checkShopifyEnv();
  checkFeishuEnv();

  const shop = normalizeShop(process.env.SHOPIFY_SHOP);
  const tokenShopify = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN).trim();
  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();

  const maps = await loadMappingTables();

  const feishuToken = await getTenantAccessToken(appId, appSecret);

  let spreadsheetToken = envSpreadsheetToken;
  if (spreadsheetToken) {
    console.log("使用 FEISHU_SPREADSHEET_TOKEN");
  } else {
    spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
    console.log("使用 Wiki token 解析飞书表格 token 成功");
  }

  const bRange = `${sheetRef}!B1:B${FEISHU_B_RANGE_ROWS}`;
  const bValues = await readSheetValues(feishuToken, spreadsheetToken, bRange);
  const existingOrderKeys = collectExistingOrderNames(bValues);
  const feishuExistingOrderCount = existingOrderKeys.size;

  let orders;
  try {
    orders = await fetchRecentPaidOrders(shop, tokenShopify, SHOPIFY_FIRST);
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      console.error("请求 Shopify API 超时");
      process.exit(1);
    }
    console.error(err.message || err);
    process.exit(1);
  }

  const shopifyFetchedCount = orders.length;

  const skippedCancelledCount = orders.filter((o) => !!o.cancelledAt).length;
  const cancelledOrderNames = orders.filter((o) => !!o.cancelledAt).map((o) => orderDisplayName(o.name));

  const skippedNotPaidCount = orders.filter((o) => {
    if (o.cancelledAt) return false;
    return String(o.displayFinancialStatus ?? "").toUpperCase() !== "PAID";
  }).length;

  const eligibleOrders = orders.filter(isPaidAndNotCancelled);

  const legacyDuplicateOrderCount = eligibleOrders.filter((o) =>
    existingOrderKeys.has(normalizeOrderKey(o.name)),
  ).length;

  const syncDateSerial = excelDateSerialLocal();
  console.log(
    `同步日期：${formatSyncDate()}（A 列写入日期序列数 ${syncDateSerial}；列格式设为「日期」后显示为年月日；E/F 列为数字）`,
  );
  const newLines = [];
  let skippedByOrderNameCount = 0;
  const sortedOrders = [...eligibleOrders].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const order of sortedOrders) {
    const orderKey = normalizeOrderKey(order.name);
    if (!orderKey) continue;
    if (existingOrderKeys.has(orderKey)) {
      skippedByOrderNameCount += 1;
      continue;
    }
    const orderLines = buildOutputLinesFromOrder(order, maps);
    if (orderLines.length) {
      newLines.push(...orderLines);
    }
  }

  if (newLines.length > 0) {
    writeLocalOutputs(newLines);
  }

  const newOrderCount = new Set(newLines.map((line) => line.order_name).filter(Boolean)).size;
  const newRowCount = newLines.length;
  const errorLineCount = newLines.filter((line) => line.status === "error").length;
  const summary = {
    created: 0,
    skipped: skippedByOrderNameCount,
    compensationCandidates: 0,
    compensationSucceeded: 0,
    compensationFailed: 0,
    failed: 0,
    writtenRows: 0,
    failures: [],
  };

  const cancelledListStr = cancelledOrderNames.length ? cancelledOrderNames.join(", ") : "无";

  console.log(`Shopify 拉取订单数：${shopifyFetchedCount}`);
  console.log(`跳过非已付款订单数：${skippedNotPaidCount}`);
  console.log(`跳过取消订单数：${skippedCancelledCount}`);
  console.log(`跳过取消订单号：${cancelledListStr}`);
  console.log(`飞书已存在订单数：${feishuExistingOrderCount}`);
  console.log(`跳过重复订单数（B 列历史保护）：${skippedByOrderNameCount}`);
  console.log(`B 列命中的已有订单数：${legacyDuplicateOrderCount}`);
  console.log(`本次新增订单数：${newOrderCount}`);
  console.log(`本次新增行数：${newRowCount}`);
  console.log(`错误行数：${errorLineCount}`);

  if (isDryRun()) {
    console.log("DRY_RUN=true，本次不会写入飞书");
  }

  if (newRowCount === 0) {
    console.log("没有新的 Shopify 订单需要写入飞书。");
    printSyncSummary(summary);
    return;
  }

  try {
    const startRow = computeNextAppendRow(bValues);
    for (const line of newLines) {
      if (line._pricing_log) console.log(line._pricing_log);
    }
    const written = await writeNewLines(feishuToken, spreadsheetToken, sheetRef, newLines, syncDateSerial, startRow);
    summary.created = newRowCount;
    summary.writtenRows += written;

    const endRow = startRow + newLines.length - 1;
    if (!isDryRun() && written > 0) {
      // 新增行：写入 V(同步状态) / W(错误说明或后续金蝶结果)，仅写本次新增行，不影响旧行
      const actionValues = newLines.map((line) => [feishuColumnVSyncStatus(line)]);
      const resultValues = newLines.map((line) => [feishuColumnWResult(line)]);
      await safeBatchUpdateValues(
        feishuToken,
        spreadsheetToken,
        [
          { range: `${sheetRef}!${FEISHU_KINGDEE_ACTION_COL}${startRow}:${FEISHU_KINGDEE_ACTION_COL}${endRow}`, values: actionValues },
          { range: `${sheetRef}!${FEISHU_KINGDEE_RESULT_COL}${startRow}:${FEISHU_KINGDEE_RESULT_COL}${endRow}`, values: resultValues },
        ],
        "new append V/W sync status / result",
      );

      const sheets = await querySpreadsheetSheets(feishuToken, spreadsheetToken);
      const sheetId = resolveSpreadsheetSheetId(sheets, sheetRef);
      if (!sheetId) {
        console.warn("新增行标黄失败：无法解析工作表 ID，请核对 FEISHU_SHEET_ID / FEISHU_SHEET_NAME 与工作表标题是否一致");
      } else {
        await tryHighlightAppendRows(feishuToken, spreadsheetToken, sheetRef, startRow, endRow);
        await tryMergeLogisticsProviderForNewRows(feishuToken, spreadsheetToken, sheetRef, sheetId, newLines);
      }
    }
  } catch (error) {
    summary.failed += newRowCount;
    summary.failures.push({ scope: "new_append", error: error?.message || String(error) });
    process.exitCode = 1;
  }

  printSyncSummary(summary);
  console.log("写入飞书成功");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildOutputLinesFromOrder,
  isDryRun,
  isPaidAndNotCancelled,
  linesToFeishuRows,
  main,
  printSyncSummary,
};
