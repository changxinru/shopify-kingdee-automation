const fs = require("fs");
const path = require("path");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues, batchUpdateValues } = require("./lib/feishu-sheets");
const { saveDynamicForm, submitDynamicForm, auditDynamicForm, parseSaveResult, parseOperationResult, formatSaveError } = require("./kingdee-client");

const OUTPUT_DIR = path.join(getProjectRoot(), "output");
const SHEET_REF_DEFAULT = "独立站";
const READ_RANGE_ROWS = 30000;
const STATUS_WAIT_TRANSFER = "2. 待先生成调拨单";
const STATUS_TRANSFER_DONE_WAIT_SALES = "3. 调拨完成待生成销售订单";
const STATUS_FAILED = "5. 同步失败";
const COL_V_STATUS = 22;

const normalize = (s) => String(s ?? "").trim();
const boolEnv = (name) => ["1", "true", "yes", "y"].includes(normalize(process.env[name]).toLowerCase());
const isDryRun = () => boolEnv("DRY_RUN");
const getByCol = (row, i) => (i == null || i < 0 ? "" : row?.[i] ?? "");
const toNumber = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : NaN; };
const refNumber = (v) => { const s = normalize(v); return s ? { FNumber: s } : undefined; };
const refNumberUpper = (v) => { const s = normalize(v); return s ? { FNUMBER: s } : undefined; };
function mustRef(field, value) { const r = refNumber(value); if (!r) throw new Error(`Missing Kingdee field: ${field}`); return r; }

function buildHeaderIndex(headerRow) {
  const m = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalize(headerRow[i]);
    if (key && !m.has(key)) m.set(key, i);
  }
  return m;
}
function getByHeader(headerIndex, row, names, fallbackCol0) {
  for (const name of names) {
    const i = headerIndex.get(name);
    if (i != null) return getByCol(row, i);
  }
  return fallbackCol0 == null ? "" : getByCol(row, fallbackCol0);
}
function checkFeishuEnv() {
  const missing = [];
  if (!normalize(process.env.FEISHU_APP_ID ?? process.env.LARK_APP_ID)) missing.push("FEISHU_APP_ID/LARK_APP_ID");
  if (!normalize(process.env.FEISHU_APP_SECRET ?? process.env.LARK_APP_SECRET)) missing.push("FEISHU_APP_SECRET/LARK_APP_SECRET");
  if (!normalize(process.env.FEISHU_SPREADSHEET_TOKEN) && !normalize(process.env.FEISHU_WIKI_TOKEN)) missing.push("FEISHU_SPREADSHEET_TOKEN/FEISHU_WIKI_TOKEN");
  if (missing.length) throw new Error(`Missing Feishu config: ${missing.join(", ")}`);
}
function getFeishuCredentials() {
  return {
    appId: normalize(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID),
    appSecret: normalize(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET),
    wikiToken: normalize(process.env.FEISHU_WIKI_TOKEN),
    envSpreadsheetToken: normalize(process.env.FEISHU_SPREADSHEET_TOKEN),
    sheetRef: normalize(process.env.FEISHU_SHEET_ID) || normalize(process.env.FEISHU_SHEET_NAME) || SHEET_REF_DEFAULT,
  };
}
function checkKingdeeEnv() {
  const missing = [];
  for (const k of ["KINGDEE_BASE_URL", "KINGDEE_ACCT_ID", "KINGDEE_APP_ID", "KINGDEE_APP_SECRET", "KINGDEE_USERNAME"]) if (!normalize(process.env[k])) missing.push(k);
  if (missing.length) throw new Error(`Missing Kingdee config: ${missing.join(", ")}`);
}
function getKingdeeConfig() {
  const lcid = Number(normalize(process.env.KINGDEE_LCID || "2052"));
  return {
    baseUrl: normalize(process.env.KINGDEE_BASE_URL),
    acctId: normalize(process.env.KINGDEE_ACCT_ID),
    username: normalize(process.env.KINGDEE_USERNAME),
    appId: normalize(process.env.KINGDEE_APP_ID),
    appSecret: normalize(process.env.KINGDEE_APP_SECRET),
    lcid: Number.isFinite(lcid) ? lcid : normalize(process.env.KINGDEE_LCID || "2052"),
  };
}
function salesOrgFromOwnerOrPaymentMethod(owner, method) {
  const o = normalize(owner);
  if (o === "美国") return "MGSG";
  if (o === "香港") return "XGSG";
  const m = normalize(method);
  if (m.includes("Shopify Payments") || m.includes("Shop Cash")) return "MGSG";
  if (m.includes("PayPal Express Checkout") || m.includes("Airwallex")) return "XGSG";
  return "";
}
function buildTransferModel(orderName, items, headerIndex) {
  const r0 = items[0].row;
  const billDate = normalize(getByCol(r0, 0));
  const paymentMethod = normalize(getByCol(r0, 3));
  const paymentOwner = normalize(getByHeader(headerIndex, r0, ["收款账户", "付款归属", "payment_owner", "payment owner"], null));
  const salesOrg = salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod);
  const fromOrg = normalize(process.env.KINGDEE_TRANSFER_FROM_ORG || "SZSG");
  const toOrg = normalize(process.env.KINGDEE_TRANSFER_TO_ORG || "XGSG");
  const srcStockId = normalize(process.env.KINGDEE_TRANSFER_SRC_STOCK_ID || "SZSGCK002");
  const destStockId = normalize(process.env.KINGDEE_TRANSFER_DEST_STOCK_ID || "XGSGCK014");
  const unitId = normalize(process.env.KINGDEE_TRANSFER_UNIT_ID || "Pcs");
  const stockStatus = normalize(process.env.KINGDEE_TRANSFER_STOCK_STATUS || "KCZT01_SYS");
  const ownerType = normalize(process.env.KINGDEE_TRANSFER_OWNER_TYPE || "BD_OwnerOrg");
  const keeperType = normalize(process.env.KINGDEE_TRANSFER_KEEPER_TYPE || "BD_KeeperOrg");
  const missing = [];
  if (!orderName) missing.push("orderName");
  if (!billDate) missing.push("billDate");
  if (!salesOrg) missing.push("salesOrg");
  if (missing.length) throw new Error(`Missing transfer header: ${missing.join(", ")}`);
  const entries = items.map((item) => {
    const r = item.row;
    const materialCode = normalize(getByCol(r, 7));
    const qty = toNumber(getByCol(r, 5));
    if (!materialCode || !Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid transfer entry row ${item.rowNumber}`);
    return {
      FMaterialId: mustRef("material", materialCode),
      FUnitID: mustRef("unit", unitId),
      FQty: qty,
      FSrcStockId: mustRef("srcStock", srcStockId),
      FSrcStockLocId: {},
      FDestStockId: mustRef("destStock", destStockId),
      FDestStockLocId: {},
      FSrcStockStatusId: mustRef("srcStockStatus", stockStatus),
      FDestStockStatusId: mustRef("destStockStatus", stockStatus),
      FOwnerTypeOutId: ownerType,
      FOwnerOutId: mustRef("ownerOut", fromOrg),
      FOwnerTypeId: ownerType,
      FOwnerId: mustRef("ownerIn", toOrg),
      FKeeperTypeOutId: keeperType,
      FKeeperOutId: mustRef("keeperOut", fromOrg),
      FKeeperTypeId: keeperType,
      FKeeperId: mustRef("keeperIn", toOrg),
      FBaseUnitId: mustRef("baseUnit", unitId),
      FBaseQty: qty,
      FNoteEntry: orderName,
      FSrcBillNo: orderName,
    };
  });
  return {
    FID: 0,
    FBillNo: "",
    FBillTypeID: refNumberUpper(normalize(process.env.KINGDEE_TRANSFER_BILL_TYPE || "ZJDB01_SYS")),
    FBizType: normalize(process.env.KINGDEE_TRANSFER_BIZ_TYPE || "NORMAL"),
    FTransferDirect: normalize(process.env.KINGDEE_TRANSFER_DIRECT || "GENERAL"),
    FTransferBizType: normalize(process.env.KINGDEE_TRANSFER_BIZ_TYPE_DETAIL || "OverOrgTransfer"),
    FSaleOrgId: refNumber(salesOrg),
    FSettleOrgId: refNumber(salesOrg),
    FStockOutOrgId: mustRef("fromOrg", fromOrg),
    FOwnerTypeOutIdHead: ownerType,
    FOwnerOutIdHead: mustRef("ownerOutHead", fromOrg),
    FStockOrgId: mustRef("toOrg", toOrg),
    FOwnerTypeIdHead: ownerType,
    FOwnerIdHead: mustRef("ownerInHead", toOrg),
    FDate: billDate,
    FNote: `shopify-feishu transfer ${orderName}`,
    FThirdSrcBillNo: orderName,
    FThirdSystem: "shopify-feishu",
    FBillEntry: entries,
  };
}
function buildStatusUpdates(sheetRef, rowNumbers, status, resultText) {
  return rowNumbers.flatMap((rowNo) => [
    { range: `${sheetRef}!V${rowNo}:V${rowNo}`, values: [[status]] },
    { range: `${sheetRef}!W${rowNo}:W${rowNo}`, values: [[resultText || ""]] },
  ]);
}
async function main() {
  loadEnv();
  checkFeishuEnv();
  checkKingdeeEnv();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const feishuToken = await getTenantAccessToken(appId, appSecret);
  const spreadsheetToken = envSpreadsheetToken || await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
  const values = await readSheetValues(feishuToken, spreadsheetToken, `${sheetRef}!A1:W${READ_RANGE_ROWS}`, { valueRenderOption: "FormattedValue" });
  const headerIndex = buildHeaderIndex(values?.[0] || []);
  const rows = values.slice(1);
  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = rows[i];
    if (normalize(getByCol(row, COL_V_STATUS - 1)) === STATUS_WAIT_TRANSFER) candidates.push({ rowNumber, row });
  }
  const groups = new Map();
  for (const item of candidates) {
    const orderName = normalize(getByCol(item.row, 1));
    if (!orderName) continue;
    if (!groups.has(orderName)) groups.set(orderName, []);
    groups.get(orderName).push(item);
  }
  const kingdeeConfig = getKingdeeConfig();
  const allUpdates = [];
  const results = [];
  let successOrders = 0;
  let failedOrders = 0;
  for (const [orderName, items] of groups.entries()) {
    const rowNumbers = items.map((x) => x.rowNumber);
    try {
      const model = buildTransferModel(orderName, items, headerIndex);
      fs.writeFileSync(path.join(OUTPUT_DIR, `kingdee-transfer-${orderName.replace(/[^a-zA-Z0-9_-]/g, "") || "order"}.json`), JSON.stringify(model, null, 2), "utf-8");
      if (isDryRun()) {
        results.push({ orderName, ok: true, dryRun: true, rowNumbers, message: "DRY_RUN transfer JSON only" });
        continue;
      }
      const formId = normalize(process.env.KINGDEE_TRANSFER_FORM_ID || "STK_TransferDirect");
      const saveResp = await saveDynamicForm(kingdeeConfig, formId, model, { verifyBaseDataField: false, autoAdjustField: true, ignoreInterationFlag: true, isControlPrecision: false, validateRepeatJson: false });
      const saved = parseSaveResult(saveResp.data);
      if (!saved.isSuccess) throw new Error(formatSaveError(saveResp));
      const submitResp = await submitDynamicForm(kingdeeConfig, formId, { id: saved.id, number: saved.number }, { ignoreInterationFlag: true });
      const submitted = parseOperationResult(submitResp.data);
      if (!submitted.isSuccess) throw new Error(`Transfer saved but submit failed: ${formatSaveError(submitResp)}`);
      const auditResp = await auditDynamicForm(kingdeeConfig, formId, { id: submitted.id || saved.id, number: submitted.number || saved.number }, { ignoreInterationFlag: true });
      const audited = parseOperationResult(auditResp.data);
      if (!audited.isSuccess) throw new Error(`Transfer submitted but audit failed: ${formatSaveError(auditResp)}`);
      const billNo = audited.number || submitted.number || saved.number || audited.id || submitted.id || saved.id || "done";
      const msg = `金蝶调拨单已保存提交并审核：${billNo}`;
      allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_TRANSFER_DONE_WAIT_SALES, msg));
      results.push({ orderName, ok: true, billNo, saveId: saved.id, submitId: submitted.id, auditId: audited.id, rowNumbers });
      successOrders += 1;
    } catch (error) {
      const msg = error?.message || String(error);
      allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_FAILED, msg));
      results.push({ orderName, ok: false, rowNumbers, error: msg });
      failedOrders += 1;
    }
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, "kingdee-transfer-results.json"), JSON.stringify(results, null, 2), "utf-8");
  if (allUpdates.length && !isDryRun()) await batchUpdateValues(feishuToken, spreadsheetToken, allUpdates);
  console.log(`V列待先生成调拨单行数：${candidates.length}`);
  console.log(`实际处理订单数：${groups.size}`);
  console.log(`成功订单数：${successOrders}`);
  console.log(`失败订单数：${failedOrders}`);
  if (isDryRun()) console.log("DRY_RUN=true，未调用金蝶 Save/Submit/Audit，未回写飞书状态。");
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { buildTransferModel, main };
