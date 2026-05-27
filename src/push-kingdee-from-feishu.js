/**
 * 飞书「独立站」→ 金蝶：仅处理 Y=1（与 sync 标黄配套）且 V=待直接生成销售订单 的行，按 B 列分组 Save 销售订单。
 */

const { loadEnv } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues, batchUpdateValues } = require("./lib/feishu-sheets");
const {
  loginBySign,
  isLoginSuccess,
  kingdeeSessionIdFromLogin,
  saveDynamicForm,
  isKingdeeSaveSuccess,
  kingdeeSaveErrorMessage,
  kingdeeSaveBillNo,
  formatKingdeeErrorForConsole,
} = require("./kingdee-client");

const SHEET_REF_DEFAULT = "独立站";

const COL_A = 0;
const COL_B = 1;
const COL_D = 3;
const COL_E = 4;
const COL_F = 5;
const COL_G = 6;
const COL_H = 7;
const COL_L = 11;
const COL_M = 12;
const COL_U = 20;
const COL_V = 21;
const COL_W = 22;
const COL_Y = 24;

const SYNC_STATUS_DIRECT_SALES = "1. 待直接生成销售订单";
const SYNC_STATUS_DIRECT_SALES_PLAIN = "待直接生成销售订单";
const SYNC_STATUS_SALES_SAVED = "4. 完成保存销售订单";
const SYNC_STATUS_FAILED = "5. 同步失败";

const FORM_ID_SALE_ORDER = "SAL_SaleOrder";
const CUST_NUMBER = "CUST0042";

function normalize(s) {
  return String(s ?? "").trim();
}

function isDryRun() {
  return String(process.env.DRY_RUN ?? "").trim().toLowerCase() === "true";
}

function requireYellowMarker() {
  const v = String(process.env.PUSH_KINGDEE_REQUIRE_YELLOW_MARKER ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

function pad2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "00";
  return x < 10 ? `0${x}` : String(x);
}

function excelSerialToKingdeeDateTime(serial) {
  const s = Number(serial);
  if (!Number.isFinite(s)) return "";
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + s * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} 00:00:00`;
}

function parseCellToKingdeeDateTime(cell) {
  if (cell == null || cell === "") return "";
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return excelSerialToKingdeeDateTime(cell);
  }
  const s = String(cell).trim();
  const m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (m) {
    return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} 00:00:00`;
  }
  return "";
}

function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const cleaned = String(v ?? "").replace(/,/g, "").replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod) {
  const owner = normalize(paymentOwner);
  if (owner === "美国") return "MGSG";
  if (owner === "香港") return "XGSG";

  const m = normalize(paymentMethod);
  if (m.includes("Shopify Payments")) return "MGSG";
  if (m.includes("PayPal Express Checkout")) return "XGSG";
  if (m.includes("Airwallex")) return "XGSG";
  return "";
}

function salesOrderStockOrgFromLogistics(logisticsProvider) {
  const lp = normalize(logisticsProvider);
  if (!lp) return "";
  if (lp.includes("万邑") || lp.includes("立达")) return "XGSG";
  const szKeywords = ["云途", "燕文", "4PX", "法世威", "迅田", "顺丰", "易通关", "中通", "跨越", "货拉拉"];
  if (szKeywords.some((k) => lp.includes(k))) return "SZSG";
  return "";
}

function isUsReceiptAccount(gCol, dCol) {
  const owner = normalize(gCol);
  if (owner === "美国") return true;
  const m = normalize(dCol);
  if (m.includes("Shopify Payments")) return true;
  return false;
}

function matchesDirectSalesV(v) {
  const t = normalize(v);
  return t === SYNC_STATUS_DIRECT_SALES || t === SYNC_STATUS_DIRECT_SALES_PLAIN;
}

function normalizeKingdeeSaveData(data) {
  if (!data || typeof data !== "object") return data;
  const raw = data.Result ?? data.result;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return { ...data, Result: parsed };
    } catch {
      return data;
    }
  }
  return data;
}

function checkFeishuEnv() {
  const missing = [];
  if (!String(process.env.FEISHU_APP_ID ?? process.env.LARK_APP_ID ?? "").trim()) missing.push("FEISHU_APP_ID（或 LARK_APP_ID）");
  if (!String(process.env.FEISHU_APP_SECRET ?? process.env.LARK_APP_SECRET ?? "").trim()) missing.push("FEISHU_APP_SECRET（或 LARK_APP_SECRET）");
  const hasSpreadsheet = String(process.env.FEISHU_SPREADSHEET_TOKEN ?? "").trim();
  const hasWiki = String(process.env.FEISHU_WIKI_TOKEN ?? "").trim();
  if (!hasSpreadsheet && !hasWiki) missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  if (missing.length) {
    console.error(`缺少飞书配置：${missing.join("、")}`);
    process.exit(1);
  }
}

function checkKingdeeEnv() {
  const missing = [];
  if (!String(process.env.KINGDEE_BASE_URL ?? "").trim()) missing.push("KINGDEE_BASE_URL");
  if (!String(process.env.KINGDEE_ACCT_ID ?? "").trim()) missing.push("KINGDEE_ACCT_ID");
  if (!String(process.env.KINGDEE_USERNAME ?? "").trim()) missing.push("KINGDEE_USERNAME");
  if (!String(process.env.KINGDEE_APP_ID ?? "").trim()) missing.push("KINGDEE_APP_ID");
  if (!String(process.env.KINGDEE_APP_SECRET ?? "").trim()) missing.push("KINGDEE_APP_SECRET");
  if (missing.length) {
    console.error(`缺少金蝶配置：${missing.join("、")}`);
    process.exit(1);
  }
}

function getFeishuCredentials() {
  const appId = String(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || "").trim();
  const wikiToken = String(process.env.FEISHU_WIKI_TOKEN || "").trim();
  const envSpreadsheetToken = String(process.env.FEISHU_SPREADSHEET_TOKEN || "").trim();
  const sheetRef = String(process.env.FEISHU_SHEET_ID || "").trim() || String(process.env.FEISHU_SHEET_NAME || SHEET_REF_DEFAULT).trim();
  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
}

function readKingdeeConfig() {
  const baseUrl = String(process.env.KINGDEE_BASE_URL ?? "").trim();
  const acctId = String(process.env.KINGDEE_ACCT_ID ?? "").trim();
  const username = String(process.env.KINGDEE_USERNAME ?? "").trim();
  const appId = String(process.env.KINGDEE_APP_ID ?? "").trim();
  const appSecret = String(process.env.KINGDEE_APP_SECRET ?? "").trim();
  const lcidRaw = String(process.env.KINGDEE_LCID ?? "2052").trim();
  const lcidNum = Number(lcidRaw);
  const lcid = Number.isFinite(lcidNum) ? lcidNum : lcidRaw;
  return { baseUrl, acctId, username, appId, appSecret, lcid };
}

async function updateRowsVW(token, spreadsheetToken, sheetRef, rowNumbers, vText, wText) {
  if (!rowNumbers.length) return;
  if (isDryRun()) {
    console.log(`[DRY_RUN] 更新 V/W：行 ${rowNumbers.join(",")} → V=${vText}`);
    return;
  }
  const valueRanges = [];
  for (const r of rowNumbers) {
    valueRanges.push({ range: `${sheetRef}!V${r}:V${r}`, values: [[vText]] });
    valueRanges.push({ range: `${sheetRef}!W${r}:W${r}`, values: [[wText]] });
  }
  const chunkSize = 80;
  for (let i = 0; i < valueRanges.length; i += chunkSize) {
    await batchUpdateValues(token, spreadsheetToken, valueRanges.slice(i, i + chunkSize));
  }
}

async function main() {
  loadEnv();
  checkFeishuEnv();
  checkKingdeeEnv();

  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const feishuToken = await getTenantAccessToken(appId, appSecret);

  let spreadsheetToken = envSpreadsheetToken;
  if (!spreadsheetToken) {
    spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
  }

  const values = await readSheetValues(feishuToken, spreadsheetToken, `${sheetRef}!A1:AZ30000`, {
    valueRenderOption: "UnformattedValue",
  });

  const rows = values.slice(1);
  const needY = requireYellowMarker();

  /** @type {{ rowNumber: number, row: any[] }[]} */
  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;
    const yVal = normalize(row[COL_Y]);
    if (needY && yVal !== "1") continue;

    const vVal = row[COL_V];
    if (!matchesDirectSalesV(vVal)) continue;

    const orderNo = normalize(row[COL_B]);
    if (!orderNo) continue;

    candidates.push({ rowNumber, row });
  }

  if (candidates.length === 0) {
    console.log("没有待处理的行（需 Y=1 且 V=待直接生成销售订单；旧表可设 PUSH_KINGDEE_REQUIRE_YELLOW_MARKER=false 试跑）。");
    return;
  }

  const groups = new Map();
  for (const item of candidates) {
    const key = normalize(item.row[COL_B]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const kdCfg = readKingdeeConfig();
  let loginResp;
  try {
    loginResp = await loginBySign(kdCfg);
  } catch (e) {
    console.error(e?.stack || String(e));
    process.exit(1);
  }

  if (!isLoginSuccess(loginResp.data)) {
    console.error(formatKingdeeErrorForConsole(loginResp));
    process.exit(1);
  }

  const sessionId = kingdeeSessionIdFromLogin(loginResp.data);
  if (!sessionId) {
    console.error("登录成功但未解析到 KDSVCSessionId，无法调用 Save。");
    process.exit(1);
  }

  const setCookieHeader = String(loginResp.setCookieHeader ?? "").trim();

  let saved = 0;
  let failed = 0;

  for (const [orderNo, items] of groups.entries()) {
    items.sort((a, b) => a.rowNumber - b.rowNumber);
    const rowNumbers = items.map((x) => x.rowNumber);

    const first = items[0].row;
    const logisticsForNote = normalize(first[COL_U]);
    const receiptG = normalize(first[COL_G]);
    const paymentD = normalize(first[COL_D]);
    const salesOrg = salesOrgFromOwnerOrPaymentMethod(receiptG, paymentD);
    const mainDateRaw = first[COL_A];
    const fDate = parseCellToKingdeeDateTime(mainDateRaw);

    const reasons = [];
    if (!fDate) reasons.push("A列主日期无效或为空");
    if (!salesOrg) reasons.push("无法根据首行 G/D 列解析销售组织（美国/香港或付款方式）");

    const entryPayloads = [];
    for (const { row } of items) {
      const mat = normalize(row[COL_H]);
      const qty = toNumber(row[COL_F]);
      const price = toNumber(row[COL_E]);
      const u = normalize(row[COL_U]);
      const stockOrg = salesOrderStockOrgFromLogistics(u);
      const aDate = parseCellToKingdeeDateTime(row[COL_A]);
      const lDate = parseCellToKingdeeDateTime(row[COL_L]);
      const delivery = lDate || aDate || fDate;

      if (!mat) reasons.push("存在行物料代码(H)为空");
      if (!Number.isFinite(qty) || qty <= 0) reasons.push("存在行数量(F)无效");
      if (!Number.isFinite(price)) reasons.push("存在行单价(E)无效");
      if (!stockOrg) reasons.push("存在行物流(U)无法匹配库存组织");
      if (isUsReceiptAccount(row[COL_G], row[COL_D]) && stockOrg === "SZSG") {
        reasons.push("美国收款+国内发货(SZSG)应先调拨，本脚本不处理");
      }
      if (!delivery) reasons.push("存在行交货日期(L/A)均无效");

      entryPayloads.push({
        FEntryID: 0,
        FMaterialId: { FNumber: mat },
        FQty: qty,
        FTaxPrice: price,
        FStockOrgId: { FNumber: stockOrg },
        FDeliveryDate: delivery,
        FDZ: normalize(row[COL_M]),
        FEntryNote: normalize(row[COL_B]),
      });
    }

    if (reasons.length) {
      const msg = [...new Set(reasons)].join("；");
      console.warn(`跳过订单 ${orderNo}：${msg}`);
      await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, SYNC_STATUS_FAILED, msg);
      failed += 1;
      continue;
    }

    const model = {
      FID: 0,
      FDate: fDate,
      FSaleOrgId: { FNumber: salesOrg },
      FCustId: { FNumber: CUST_NUMBER },
      FNote: `独立站订单 ${orderNo} ${logisticsForNote}`.trim(),
      FSaleOrderEntry: entryPayloads,
    };

    let saveResp;
    try {
      saveResp = await saveDynamicForm({
        baseUrl: kdCfg.baseUrl,
        sessionId,
        setCookieHeader,
        formId: FORM_ID_SALE_ORDER,
        model,
      });
    } catch (e) {
      failed += 1;
      const errText = e?.message || String(e);
      console.error(`订单 ${orderNo} Save 请求异常：${errText}`);
      await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, SYNC_STATUS_FAILED, errText);
      continue;
    }

    const parsed = normalizeKingdeeSaveData(saveResp.data);
    if (saveResp.status >= 400 || !parsed || !isKingdeeSaveSuccess(parsed)) {
      failed += 1;
      const errMsg =
        parsed && !isKingdeeSaveSuccess(parsed)
          ? kingdeeSaveErrorMessage(parsed)
          : formatKingdeeErrorForConsole(saveResp);
      console.error(`订单 ${orderNo} 保存失败：${errMsg}`);
      await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, SYNC_STATUS_FAILED, errMsg);
      continue;
    }

    const billNo = kingdeeSaveBillNo(parsed) || "";
    const wText = billNo ? `金蝶销售订单号：${billNo}` : "金蝶销售订单号：（未返回单号）";
    await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, SYNC_STATUS_SALES_SAVED, wText);
    saved += 1;
    console.log(`已保存销售订单 ${orderNo} → ${billNo || "(无单号)"}`);
  }

  console.log(`完成：成功 ${saved} 单，失败或校验未通过 ${failed} 单，候选行 ${candidates.length}。`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
