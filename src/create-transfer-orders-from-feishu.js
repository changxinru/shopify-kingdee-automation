const fs = require("fs");
const path = require("path");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues, batchUpdateValues } = require("./lib/feishu-sheets");
const {
  saveDynamicForm,
  submitDynamicForm,
  parseSaveResult,
  parseOperationResult,
  formatSaveError,
} = require("./kingdee-client");

const OUTPUT_DIR = path.join(getProjectRoot(), "output");
const SHEET_REF_DEFAULT = "独立站";
const READ_RANGE_ROWS = 30000;

const STATUS_WAIT_TRANSFER = "2. 待先生成调拨单";
const STATUS_TRANSFER_DONE_WAIT_SALES = "3. 调拨完成待生成销售订单";
const STATUS_FAILED = "5. 同步失败";
const COL_V_STATUS = 22;

function normalize(s) { return String(s ?? "").trim(); }
function toNumber(v) {
  const cleaned = String(v ?? "").replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function boolEnv(name) { return ["1", "true", "yes", "y"].includes(normalize(process.env[name]).toLowerCase()); }
function isDryRun() { return boolEnv("DRY_RUN"); }
function getByCol(row, colIndex0) { return colIndex0 == null || colIndex0 < 0 ? "" : row?.[colIndex0] ?? ""; }
function refNumber(value) { const s = normalize(value); return s ? { FNumber: s } : undefined; }
function refNumberUpper(value) { const s = normalize(value); return s ? { FNUMBER: s } : undefined; }
function mustRef(field, value) { const ref = refNumber(value); if (!ref) throw new Error(`缺少金蝶字段：${field}`); return ref; }

function buildHeaderIndex(headerRow) {
  const idx = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalize(headerRow[i]);
    if (key && !idx.has(key)) idx.set(key, i);
  }
  return idx;
}
function getByHeader(headerIndex, row, names, fallbackCol0) {
  for (const name of names) {
    const idx = headerIndex.get(name);
    if (idx != null) return getByCol(row, idx);
  }
  return fallbackCol0 == null ? "" : getByCol(row, fallbackCol0);
}

function checkFeishuEnv() {
  const missing = [];
  if (!normalize(process.env.FEISHU_APP_ID ?? process.env.LARK_APP_ID)) missing.push("FEISHU_APP_ID（或 LARK_APP_ID）");
  if (!normalize(process.env.FEISHU_APP_SECRET ?? process.env.LARK_APP_SECRET)) missing.push("FEISHU_APP_SECRET（或 LARK_APP_SECRET）");
  if (!normalize(process.env.FEISHU_SPREADSHEET_TOKEN) && !normalize(process.env.FEISHU_WIKI_TOKEN)) missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  if (missing.length) throw new Error(`缺少飞书配置：${missing.join("、")}`);
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
  for (const k of ["KINGDEE_BASE_URL", "KINGDEE_ACCT_ID", "KINGDEE_APP_ID", "KINGDEE_APP_SECRET", "KINGDEE_USERNAME"]) {
    if (!normalize(process.env[k])) missing.push(k);
  }
  if (missing.length) throw new Error(`缺少金蝶配置：${missing.join("、")}`);
}
function getKingdeeConfig() {
  const lcidRaw = normalize(process.env.KINGDEE_LCID || "2052");
  const lcidNum = Number(lcidRaw);
  return {
    baseUrl: normalize(process.env.KINGDEE_BASE_URL),
    acctId: normalize(process.env.KINGDEE_ACCT_ID),
    username: normalize(process.env.KINGDEE_USERNAME),
    appId: normalize(process.env.KINGDEE_APP_ID),
    appSecret: normalize(process.env.KINGDEE_APP_SECRET),
    lcid: Number.isFinite(lcidNum) ? lcidNum : lcidRaw,
  };
}
function paymentOwnerFromRow(headerIndex, row) {
  return normalize(getByHeader(headerIndex, row, ["收款账户", "付款归属", "payment_owner", "payment owner"], null));
}
function salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod) {
  const owner = normalize(paymentOwner);
  if (owner === "美国") return "MGSG";
  if (owner === "香港") return "XGSG";
  const m = normalize(paymentMethod);
  if (m.includes("Shopify Payments") || m.includes("Shop Cash")) return "MGSG";
  if (m.includes("PayPal Express Checkout") || m.includes("Airwallex")) return "XGSG";
  return "";
}
function transferRule(headerIndex, row) {
  const paymentMethod = normalize(getByCol(row, 3));
  const paymentOwner = paymentOwnerFromRow(headerIndex, row);
  return {
    paymentMethod,
    paymentOwner,
    salesOrg: salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod),
    fromOrg: normalize(process.env.KINGDEE_TRANSFER_FROM_ORG || "SZSG"),
    toOrg: normalize(process.env.KINGDEE_TRANSFER_TO_ORG || "XGSG"),
  };
}

function buildTransferModel(orderName, items, headerIndex) {
  const r0 = items[0].row;
  const billDate = normalize(getByCol(r0, 0));
  const logisticsProvider = normalize(getByCol(r0, 20));
  const { paymentMethod, paymentOwner, salesOrg, fromOrg, toOrg } = transferRule(headerIndex, r0);
  const billType = normalize(process.env.KINGDEE_TRANSFER_BILL_TYPE || "ZJDB01_SYS");
  const bizType = normalize(process.env.KINGDEE_TRANSFER_BIZ_TYPE || "NORMAL");
  const transferDirect = normalize(process.env.KINGDEE_TRANSFER_DIRECT || "GENERAL");
  const transferBizType = normalize(process.env.KINGDEE_TRANSFER_BIZ_TYPE_DETAIL || "OverOrgTransfer");
  const srcStockId = normalize(process.env.KINGDEE_TRANSFER_SRC_STOCK_ID || "SZSGCK002");
  const destStockId = normalize(process.env.KINGDEE_TRANSFER_DEST_STOCK_ID || "XGSGCK014");
  const stockStatus = normalize(process.env.KINGDEE_TRANSFER_STOCK_STATUS || "KCZT01_SYS");
  const ownerType = normalize(process.env.KINGDEE_TRANSFER_OWNER_TYPE || "BD_OwnerOrg");
  const keeperType = normalize(process.env.KINGDEE_TRANSFER_KEEPER_TYPE || "BD_KeeperOrg");
  const unitId = normalize(process.env.KINGDEE_TRANSFER_UNIT_ID || "Pcs");
  const remark = `独立站订单 ${orderName} 先做销售调拨：${fromOrg} → ${toOrg}；${logisticsProvider}`;

  const missingHead = [];
  if (!orderName) missingHead.push("缺少订单号(B列)");
  if (!billDate) missingHead.push("缺少日期(A列)");
  if (!fromOrg) missingHead.push("缺少调出库存组织");
  if (!toOrg) missingHead.push("缺少调入库存组织");
  if (!salesOrg) missingHead.push(`无法识别销售组织（付款方式：${paymentMethod}，收款归属：${paymentOwner}）`);
  if (!srcStockId) missingHead.push("缺少调出仓库 KINGDEE_TRANSFER_SRC_STOCK_ID");
  if (!destStockId) missingHead.push("缺少调入仓库 KINGDEE_TRANSFER_DEST_STOCK_ID");
  if (srcStockId && destStockId && srcStockId === destStockId) missingHead.push("调出仓库和调入仓库不能相同");
  if (missingHead.length) throw new Error(missingHead.join("；"));

  const entries = items.map((item) => {
    const r = item.row;
    const rowNo = item.rowNumber;
    const materialCode = normalize(getByCol(r, 7));
    const qty = toNumber(getByCol(r, 5));
    const productName = normalize(getByCol(r, 2));
    const missing = [];
    if (!materialCode) missing.push(`第 ${rowNo} 行缺少物料编码(H列)`);
    if (!Number.isFinite(qty) || qty <= 0) missing.push(`第 ${rowNo} 行缺少数量(F列)`);
    if (missing.length) throw new Error(missing.join("；"));
    return {
      FMaterialId: mustRef("物料编码", materialCode),
      FUnitID: mustRef("单位", unitId),
      FQty: qty,
      FSrcStockId: mustRef("调出仓库", srcStockId),
      FSrcStockLocId: {},
      FDestStockId: mustRef("调入仓库", destStockId),
      FDestStockLocId: {},
      FSrcStockStatusId: mustRef("调出库存状态", stockStatus),
      FDestStockStatusId: mustRef("调入库存状态", stockStatus),
      FOwnerTypeOutId: ownerType,
      FOwnerOutId: mustRef("调出货主", fromOrg),
      FOwnerTypeId: ownerType,
      FOwnerId: mustRef("调入货主", toOrg),
      FKeeperTypeOutId: keeperType,
      FKeeperOutId: mustRef("调出保管者", fromOrg),
      FKeeperTypeId: keeperType,
      FKeeperId: mustRef("调入保管者", toOrg),
      FBaseUnitId: mustRef("基本单位", unitId),
      FBaseQty: qty,
      FNoteEntry: `${orderName} ${productName}`,
      FSrcBillNo: orderName,
    };
  });

  return {
    FID: 0,
    FBillNo: "",
    FBillTypeID: refNumberUpper(billType),
    FBizType: bizType,
    FTransferDirect: transferDirect,
    FTransferBizType: transferBizType,
    FSaleOrgId: refNumber(salesOrg),
    FSettleOrgId: refNumber(salesOrg),
    FStockOutOrgId: mustRef("调出库存组织", fromOrg),
    FOwnerTypeOutIdHead: ownerType,
    FOwnerOutIdHead: mustRef("调出货主", fromOrg),
    FStockOrgId: mustRef("调入库存组织", toOrg),
    FOwnerTypeIdHead: ownerType,
    FOwnerIdHead: mustRef("调入货主", toOrg),
    FDate: billDate,
    FNote: remark,
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
  let spreadsheetToken = envSpreadsheetToken || await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);

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
        results.push({ orderName, ok: true, dryRun: true, rowNumbers, message: "DRY_RUN=true，已生成金蝶调拨单 JSON，未调用 Save/Submit" });
        continue;
      }

      const formId = normalize(process.env.KINGDEE_TRANSFER_FORM_ID || "STK_TransferDirect");
      const saveResp = await saveDynamicForm(kingdeeConfig, formId, model, {
        verifyBaseDataField: false,
        autoAdjustField: true,
        ignoreInterationFlag: true,
        isControlPrecision: false,
        validateRepeatJson: false,
      });
      const saved = parseSaveResult(saveResp.data);
      if (!saved.isSuccess) throw new Error(formatSaveError(saveResp));

      const submitResp = await submitDynamicForm(kingdeeConfig, formId, { id: saved.id, number: saved.number }, { ignoreInterationFlag: true });
      const submitted = parseOperationResult(submitResp.data);
      if (!submitted.isSuccess) throw new Error(`调拨单已保存但提交失败：${formatSaveError(submitResp)}`);

      const billNo = submitted.number || saved.number || submitted.id || saved.id || "已保存并提交";
      const msg = `金蝶调拨单已保存并提交：${billNo}`;
      allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_TRANSFER_DONE_WAIT_SALES, msg));
      results.push({ orderName, ok: true, billNo, saveId: saved.id, submitId: submitted.id, rowNumbers });
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
  if (isDryRun()) console.log("DRY_RUN=true，未调用金蝶 Save/Submit，未回写飞书状态。");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { buildTransferModel, main };
