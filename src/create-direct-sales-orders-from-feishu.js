const fs = require("fs");
const path = require("path");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const {
  readSheetValues,
  batchUpdateValues,
} = require("./lib/feishu-sheets");
const {
  saveDynamicForm,
  parseSaveResult,
  formatSaveError,
} = require("./kingdee-client");

const OUTPUT_DIR = path.join(getProjectRoot(), "output");
const SHEET_REF_DEFAULT = "独立站";
const READ_RANGE_ROWS = 30000;

const STATUS_DIRECT_SALES = "1. 待直接生成销售订单";
const STATUS_SALES_DONE = "4. 完成保存销售订单";
const STATUS_FAILED = "5. 同步失败";

const COL_V_STATUS = 22;

function normalize(s) {
  return String(s ?? "").trim();
}

function toNumber(v) {
  const cleaned = String(v ?? "").replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function boolEnv(name) {
  return ["1", "true", "yes", "y"].includes(normalize(process.env[name]).toLowerCase());
}

function isDryRun() {
  return boolEnv("DRY_RUN");
}

function buildHeaderIndex(headerRow) {
  const idx = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalize(headerRow[i]);
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, i);
  }
  return idx;
}

function getByCol(row, colIndex0) {
  if (colIndex0 == null || colIndex0 < 0) return "";
  return row?.[colIndex0] ?? "";
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
  const hasSpreadsheet = normalize(process.env.FEISHU_SPREADSHEET_TOKEN);
  const hasWiki = normalize(process.env.FEISHU_WIKI_TOKEN);
  if (!hasSpreadsheet && !hasWiki) missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  if (missing.length) throw new Error(`缺少飞书配置：${missing.join("、")}`);
}

function getFeishuCredentials() {
  const appId = normalize(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID);
  const appSecret = normalize(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET);
  const wikiToken = normalize(process.env.FEISHU_WIKI_TOKEN);
  const envSpreadsheetToken = normalize(process.env.FEISHU_SPREADSHEET_TOKEN);
  const sheetRef = normalize(process.env.FEISHU_SHEET_ID) || normalize(process.env.FEISHU_SHEET_NAME) || SHEET_REF_DEFAULT;
  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
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
  if (m.includes("Shopify Payments")) return "MGSG";
  if (m.includes("PayPal Express Checkout")) return "XGSG";
  if (m.includes("Airwallex")) return "XGSG";
  if (m.includes("Shop Cash")) return "MGSG";
  return "";
}

function actualShipStockOrgFromLogisticsProvider(logisticsProvider) {
  const lp = normalize(logisticsProvider);
  if (!lp) return "";
  if (lp.includes("万邑") || lp.includes("立达")) return "XGSG";
  const szKeywords = ["云途", "燕文", "4PX", "法世威", "迅田", "顺丰", "易通关", "中通", "跨越", "货拉拉"];
  if (szKeywords.some((k) => lp.includes(k))) return "SZSG";
  return "";
}

function refNumber(value) {
  const s = normalize(value);
  return s ? { FNumber: s } : undefined;
}

function mustRef(field, value) {
  const ref = refNumber(value);
  if (!ref) throw new Error(`缺少金蝶字段：${field}`);
  return ref;
}

function buildSaleOrderModel(orderName, items, headerIndex) {
  const first = items[0];
  const r0 = first.row;
  const billDate = normalize(getByCol(r0, 0));
  const paymentMethod = normalize(getByCol(r0, 3));
  const paymentOwner = paymentOwnerFromRow(headerIndex, r0);
  const salesOrg = salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod);
  const logisticsProvider = normalize(getByCol(r0, 20));
  const stockOrg = actualShipStockOrgFromLogisticsProvider(logisticsProvider);
  const customerCode = normalize(process.env.KINGDEE_CUSTOMER_CODE || "CUST0042");
  const sellerCode = normalize(process.env.KINGDEE_SELLER_CODE || "");
  const settleOrg = normalize(process.env.KINGDEE_SETTLE_ORG || salesOrg);
  const receiveOrg = normalize(process.env.KINGDEE_RECEIVE_ORG || salesOrg);
  const currency = normalize(process.env.KINGDEE_CURRENCY || "PRE007");
  const saleDept = normalize(process.env.KINGDEE_SALE_DEPT || "");
  const remark = `独立站订单 ${orderName} ${logisticsProvider}`;

  const entries = [];
  for (const item of items) {
    const r = item.row;
    const rowNo = item.rowNumber;
    const materialCode = normalize(getByCol(r, 7));
    const qty = toNumber(getByCol(r, 5));
    const taxPrice = toNumber(getByCol(r, 4));
    const deliveryDate = normalize(getByCol(r, 11)) || billDate;
    const missing = [];
    if (!materialCode) missing.push(`第 ${rowNo} 行缺少物料编码(H列)`);
    if (!Number.isFinite(qty) || qty <= 0) missing.push(`第 ${rowNo} 行缺少数量(F列)`);
    if (!Number.isFinite(taxPrice)) missing.push(`第 ${rowNo} 行缺少单价(E列)`);
    if (missing.length) throw new Error(missing.join("；"));

    entries.push({
      FMaterialId: mustRef("物料编码", materialCode),
      FQty: qty,
      FPrice: taxPrice,
      FTaxPrice: taxPrice,
      FEntryTaxRate: Number(process.env.KINGDEE_TAX_RATE || 0),
      FDeliveryDate: deliveryDate,
      FStockOrgId: mustRef("库存组织", stockOrg),
    });
  }

  const missing = [];
  if (!orderName) missing.push("缺少订单号(B列)");
  if (!billDate) missing.push("缺少日期(A列)");
  if (!salesOrg) missing.push("无法识别销售组织（D列付款方式/收款账户）");
  if (!stockOrg) missing.push("无法从 U 列物流商识别库存组织");
  if (!customerCode) missing.push("缺少客户编码 KINGDEE_CUSTOMER_CODE");
  if (missing.length) throw new Error(missing.join("；"));

  const model = {
    FBillTypeID: mustRef("单据类型", normalize(process.env.KINGDEE_SALE_ORDER_BILL_TYPE || "XSDD01_SYS")),
    FDate: billDate,
    FSaleOrgId: mustRef("销售组织", salesOrg),
    FCustId: mustRef("客户", customerCode),
    FSettleCurrId: mustRef("结算币别", currency),
    FSaleOrderEntry: entries,
    F_PAEZ_Text: orderName,
    FNote: remark,
  };

  if (settleOrg) model.FSettleOrgIds = refNumber(settleOrg);
  if (receiveOrg) model.FReceiveOrgId = refNumber(receiveOrg);
  if (sellerCode) model.FSalerId = refNumber(sellerCode);
  if (saleDept) model.FSaleDeptId = refNumber(saleDept);

  return model;
}

function buildStatusUpdates(sheetRef, rowNumbers, status, resultText) {
  const updates = [];
  for (const rowNo of rowNumbers) {
    updates.push({ range: `${sheetRef}!V${rowNo}:V${rowNo}`, values: [[status]] });
    updates.push({ range: `${sheetRef}!W${rowNo}:W${rowNo}`, values: [[resultText || ""]] });
  }
  return updates;
}

async function main() {
  loadEnv();
  checkFeishuEnv();
  checkKingdeeEnv();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const feishuToken = await getTenantAccessToken(appId, appSecret);
  let spreadsheetToken = envSpreadsheetToken;
  if (!spreadsheetToken) spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);

  const values = await readSheetValues(feishuToken, spreadsheetToken, `${sheetRef}!A1:W${READ_RANGE_ROWS}`, { valueRenderOption: "FormattedValue" });
  const header = values?.[0] || [];
  const rows = values.slice(1);
  const headerIndex = buildHeaderIndex(header);

  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = rows[i];
    const status = normalize(getByCol(row, COL_V_STATUS - 1));
    if (status !== STATUS_DIRECT_SALES) continue;
    candidates.push({ rowNumber, row });
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
      const model = buildSaleOrderModel(orderName, items, headerIndex);
      fs.writeFileSync(
        path.join(OUTPUT_DIR, `kingdee-direct-sales-${orderName.replace(/[^a-zA-Z0-9_-]/g, "") || "order"}.json`),
        JSON.stringify(model, null, 2),
        "utf-8",
      );

      if (isDryRun()) {
        const msg = "DRY_RUN=true，已生成金蝶销售订单 JSON，未调用 Save";
        allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_DIRECT_SALES, msg));
        results.push({ orderName, ok: true, dryRun: true, rowNumbers, message: msg });
        continue;
      }

      const resp = await saveDynamicForm(kingdeeConfig, normalize(process.env.KINGDEE_SALE_ORDER_FORM_ID || "SAL_SaleOrder"), model);
      const parsed = parseSaveResult(resp.data);
      if (!parsed.isSuccess) {
        throw new Error(formatSaveError(resp));
      }
      const billNo = parsed.number || parsed.id || "已保存";
      const msg = `金蝶销售订单已保存：${billNo}`;
      allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_SALES_DONE, msg));
      results.push({ orderName, ok: true, billNo, rowNumbers });
      successOrders += 1;
    } catch (error) {
      const msg = error?.message || String(error);
      allUpdates.push(...buildStatusUpdates(sheetRef, rowNumbers, STATUS_FAILED, msg));
      results.push({ orderName, ok: false, rowNumbers, error: msg });
      failedOrders += 1;
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "kingdee-direct-sales-results.json"), JSON.stringify(results, null, 2), "utf-8");

  if (allUpdates.length && !isDryRun()) {
    await batchUpdateValues(feishuToken, spreadsheetToken, allUpdates);
  }

  console.log(`V列待直接生成销售订单行数：${candidates.length}`);
  console.log(`实际处理行数：${candidates.length}`);
  console.log(`实际处理订单数：${groups.size}`);
  console.log(`成功订单数：${successOrders}`);
  console.log(`失败订单数：${failedOrders}`);
  if (isDryRun()) console.log("DRY_RUN=true，未调用金蝶 Save，未回写飞书状态。");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildSaleOrderModel,
  main,
};
