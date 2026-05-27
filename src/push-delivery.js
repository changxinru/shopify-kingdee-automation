const fs = require("fs");
const path = require("path");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues, batchUpdateValues } = require("./lib/feishu-sheets");
const {
  loginBySign,
  isLoginSuccess,
  kingdeeSessionIdFromLogin,
  pushDynamicForm,
  saveDynamicForm,
  submitDynamicForm,
  executeBillQuery,
  isKingdeeSaveSuccess,
  kingdeeSaveErrorMessage,
  kingdeeSaveBillNo,
  kingdeePushedModel,
  formatKingdeeErrorForConsole,
} = require("./kingdee-client");
const { decidePushDeliveryAction, normalize } = require("./lib/push-delivery-rules");

const SHEET_REF_DEFAULT = "独立站";
const LOG_DIR = path.join(getProjectRoot(), "logs");

const COL_V = 21;
const COL_W = 22;

const FIELD_CANDIDATES = {
  status: ["同步状态", "状态", "金蝶状态"],
  paymentOwner: ["收款账户", "付款归属", "payment_owner", "payment owner"],
  logisticsProvider: ["物流商", "物流方式", "物流服务商", "logistics_provider"],
  salesOrderNo: ["金蝶销售订单号", "销售订单号", "销售订单单号", "金蝶结果", "同步结果", "处理结果", "结果", "kingdee_sales_order_no", "sales_order_no"],
  outstockNo: ["销售出库单号", "金蝶销售出库单号", "outstock_no"],
  deliveryNoticeNo: ["发货通知单号", "金蝶发货通知单号", "delivery_notice_no"],
};

function isDryRun() {
  return String(process.env.DRY_RUN ?? "").trim().toLowerCase() === "true";
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

function findColumn(headerIndex, names) {
  for (const name of names) {
    const idx = headerIndex.get(name);
    if (idx != null) return idx;
  }
  return null;
}

function getCell(row, idx) {
  if (idx == null || idx < 0) return "";
  return row?.[idx] ?? "";
}

function getFeishuCredentials() {
  const appId = normalize(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID);
  const appSecret = normalize(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET);
  const wikiToken = normalize(process.env.FEISHU_WIKI_TOKEN);
  const envSpreadsheetToken = normalize(process.env.FEISHU_SPREADSHEET_TOKEN);
  const sheetRef =
    normalize(process.env.FEISHU_SHEET_ID) ||
    normalize(process.env.FEISHU_SHEET_NAME) ||
    SHEET_REF_DEFAULT;

  const missing = [];
  if (!appId) missing.push("FEISHU_APP_ID 或 LARK_APP_ID");
  if (!appSecret) missing.push("FEISHU_APP_SECRET 或 LARK_APP_SECRET");
  if (!envSpreadsheetToken && !wikiToken) missing.push("FEISHU_SPREADSHEET_TOKEN 或 FEISHU_WIKI_TOKEN");
  if (missing.length) throw new Error(`缺少飞书配置：${missing.join("、")}`);

  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
}

function readKingdeeConfig() {
  const baseUrl = normalize(process.env.KINGDEE_BASE_URL);
  const acctId = normalize(process.env.KINGDEE_ACCT_ID);
  const username = normalize(process.env.KINGDEE_USERNAME);
  const appId = normalize(process.env.KINGDEE_APP_ID);
  const appSecret = normalize(process.env.KINGDEE_APP_SECRET);
  const lcidRaw = normalize(process.env.KINGDEE_LCID || "2052");
  const lcidNum = Number(lcidRaw);
  const lcid = Number.isFinite(lcidNum) ? lcidNum : lcidRaw;

  const missing = [];
  if (!baseUrl) missing.push("KINGDEE_BASE_URL");
  if (!acctId) missing.push("KINGDEE_ACCT_ID");
  if (!username) missing.push("KINGDEE_USERNAME");
  if (!appId) missing.push("KINGDEE_APP_ID");
  if (!appSecret) missing.push("KINGDEE_APP_SECRET");
  if (missing.length) throw new Error(`缺少金蝶配置：${missing.join("、")}`);

  return { baseUrl, acctId, username, appId, appSecret, lcid };
}

function isAlreadyHandled(row, cols) {
  const outstockNo = normalize(getCell(row, cols.outstockNo));
  const noticeNo = normalize(getCell(row, cols.deliveryNoticeNo));
  return Boolean(outstockNo || noticeNo);
}

function isCandidateStatus(status) {
  const s = normalize(status);
  if (!s) return true;

  return [
    "4. 完成保存销售订单",
    "金蝶销售订单已生成",
    "待下推",
    "待下推销售出库单",
    "待生成发货通知单",
  ].some((x) => s.includes(x));
}

function extractSalesOrderNo(value) {
  let s = normalize(value);
  if (!s) return "";
  if (s.includes("：")) s = s.split("：").pop();
  if (s.includes(":")) s = s.split(":").pop();
  s = normalize(s);
  const m = s.match(/[A-Za-z0-9_-]+$/);
  return m ? m[0] : s;
}

function readyStatuses() {
  const raw = normalize(process.env.KINGDEE_SALES_ORDER_READY_STATUSES);
  if (!raw) return ["B", "C", "已提交", "已审核"];
  return raw.split(/[;,，、]/).map(normalize).filter(Boolean);
}

function parseSalesOrderStatus(resp) {
  const data = resp?.data;
  if (!Array.isArray(data) || !data.length) return { found: false, status: "", id: "" };

  const first = data[0];
  if (Array.isArray(first)) {
    return {
      found: true,
      billNo: normalize(first[0]),
      status: normalize(first[1]),
      id: normalize(first[2]),
    };
  }

  return {
    found: true,
    billNo: normalize(first.FBillNo || first.BillNo || first.Number),
    status: normalize(first.FDocumentStatus || first.DocumentStatus || first.status),
    id: normalize(first.FID || first.Id || first.id),
  };
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logKingdee(label, payload) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `push-delivery-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${label}\n${JSON.stringify(payload, null, 2)}\n\n`, "utf8");
}

async function updateRowsVW(token, spreadsheetToken, sheetRef, rowNumbers, vText, wText) {
  if (!rowNumbers.length) return;

  if (isDryRun()) {
    console.log(`[DRY_RUN] 更新 V/W：行 ${rowNumbers.join(",")} → V=${vText}, W=${wText}`);
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

async function viewSalesOrder(kdCfg, sessionId, setCookieHeader, salesOrderNo) {
  const formId = normalize(process.env.KINGDEE_FORM_SALE_ORDER || "SAL_SaleOrder");
  const fieldKeys = normalize(process.env.KINGDEE_SALE_ORDER_STATUS_FIELD_KEYS || "FBillNo,FDocumentStatus,FID");

  return executeBillQuery({
    baseUrl: kdCfg.baseUrl,
    sessionId,
    setCookieHeader,
    formId,
    fieldKeys,
    filterString: `FBillNo='${String(salesOrderNo).replace(/'/g, "''")}'`,
    limit: 1,
  });
}

async function processGroup({
  kdCfg,
  sessionId,
  setCookieHeader,
  feishuToken,
  spreadsheetToken,
  sheetRef,
  orderKey,
  items,
}) {
  const rowNumbers = items.map((x) => x.rowNumber);
  const first = items[0];

  const salesOrderNo = first.salesOrderNo;
  const action = first.action;

  const viewResp = await viewSalesOrder(kdCfg, sessionId, setCookieHeader, salesOrderNo);
  logKingdee(`view sales order ${salesOrderNo}`, viewResp);

  const so = parseSalesOrderStatus(viewResp);
  if (!so.found) {
    const msg = `金蝶查不到销售订单：${salesOrderNo}`;
    await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, "5. 同步失败", msg);
    return { ok: false, message: msg };
  }

  if (!readyStatuses().includes(so.status)) {
    return { ok: false, skipped: true, message: `销售订单未提交/未审核，跳过：${salesOrderNo} 状态=${so.status}` };
  }

  if (isDryRun()) {
    const dryText = action.action === "outstock"
      ? `DRY_RUN：将下推销售出库单：${salesOrderNo}`
      : `DRY_RUN：将下推发货通知单：${salesOrderNo}`;
    console.log(dryText);
    return { ok: true, skipped: true, message: dryText };
  }

  const sourceFormId = normalize(process.env.KINGDEE_FORM_SALE_ORDER || "SAL_SaleOrder");

  if (action.action === "outstock") {
    const targetFormId = normalize(process.env.KINGDEE_FORM_OUTSTOCK || "SAL_OUTSTOCK");
    const ruleId = normalize(process.env.KINGDEE_PUSH_RULE_SALE_ORDER_TO_OUTSTOCK);

    const pushResp = await pushDynamicForm({
      baseUrl: kdCfg.baseUrl,
      sessionId,
      setCookieHeader,
      sourceFormId,
      targetFormId,
      billNo: salesOrderNo,
      ruleId,
    });
    logKingdee(`push sales order to outstock ${salesOrderNo}`, pushResp);

    if (pushResp.status >= 400 || !isKingdeeSaveSuccess(pushResp.data)) {
      throw new Error(`销售出库单下推失败：${kingdeeSaveErrorMessage(pushResp.data)}`);
    }

    const model = kingdeePushedModel(pushResp.data);
    if (!model) throw new Error("销售出库单下推成功但未取得目标单据模型，请检查金蝶 Push 返回格式");

    const saveResp = await saveDynamicForm({
      baseUrl: kdCfg.baseUrl,
      sessionId,
      setCookieHeader,
      formId: targetFormId,
      model,
    });
    logKingdee(`save outstock from ${salesOrderNo}`, saveResp);

    if (saveResp.status >= 400 || !isKingdeeSaveSuccess(saveResp.data)) {
      throw new Error(`销售出库单保存失败：${kingdeeSaveErrorMessage(saveResp.data)}`);
    }

    const outstockNo = kingdeeSaveBillNo(saveResp.data);
    if (!outstockNo) throw new Error("销售出库单保存成功但未返回单号");

    const submitResp = await submitDynamicForm({
      baseUrl: kdCfg.baseUrl,
      sessionId,
      setCookieHeader,
      formId: targetFormId,
      billNo: outstockNo,
    });
    logKingdee(`submit outstock ${outstockNo}`, submitResp);

    if (submitResp.status >= 400 || !isKingdeeSaveSuccess(submitResp.data)) {
      throw new Error(`销售出库单提交失败：${kingdeeSaveErrorMessage(submitResp.data)}`);
    }

    const wText = `销售出库单已提交：${outstockNo}；${nowText()}`;
    await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, "销售出库单已提交", wText);
    return { ok: true, message: `${orderKey} → 销售出库单已提交：${outstockNo}` };
  }

  if (action.action === "delivery_notice") {
    const targetFormId = normalize(process.env.KINGDEE_FORM_DELIVERY_NOTICE || "SAL_DELIVERYNOTICE");
    const ruleId = normalize(process.env.KINGDEE_PUSH_RULE_SALE_ORDER_TO_DELIVERY_NOTICE);

    const pushResp = await pushDynamicForm({
      baseUrl: kdCfg.baseUrl,
      sessionId,
      setCookieHeader,
      sourceFormId,
      targetFormId,
      billNo: salesOrderNo,
      ruleId,
    });
    logKingdee(`push sales order to delivery notice ${salesOrderNo}`, pushResp);

    if (pushResp.status >= 400 || !isKingdeeSaveSuccess(pushResp.data)) {
      throw new Error(`发货通知单下推失败：${kingdeeSaveErrorMessage(pushResp.data)}`);
    }

    const model = kingdeePushedModel(pushResp.data);
    if (!model) throw new Error("发货通知单下推成功但未取得目标单据模型，请检查金蝶 Push 返回格式");

    const saveResp = await saveDynamicForm({
      baseUrl: kdCfg.baseUrl,
      sessionId,
      setCookieHeader,
      formId: targetFormId,
      model,
    });
    logKingdee(`save delivery notice from ${salesOrderNo}`, saveResp);

    if (saveResp.status >= 400 || !isKingdeeSaveSuccess(saveResp.data)) {
      throw new Error(`发货通知单保存失败：${kingdeeSaveErrorMessage(saveResp.data)}`);
    }

    const noticeNo = kingdeeSaveBillNo(saveResp.data);
    if (!noticeNo) throw new Error("发货通知单保存成功但未返回单号");

    const wText = `发货通知单已保存：${noticeNo}；${nowText()}`;
    await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, "发货通知单已保存", wText);
    return { ok: true, message: `${orderKey} → 发货通知单已保存：${noticeNo}` };
  }

  const msg = `未知处理动作：${action.action}`;
  await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, rowNumbers, "5. 同步失败", msg);
  return { ok: false, message: msg };
}

async function main() {
  loadEnv();

  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const kdCfg = readKingdeeConfig();

  const feishuToken = await getTenantAccessToken(appId, appSecret);
  let spreadsheetToken = envSpreadsheetToken;
  if (!spreadsheetToken) {
    spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
  }

  const loginResp = await loginBySign(kdCfg);
  if (!isLoginSuccess(loginResp.data)) {
    console.error(formatKingdeeErrorForConsole(loginResp));
    process.exit(1);
  }

  const sessionId = kingdeeSessionIdFromLogin(loginResp.data);
  if (!sessionId) {
    console.error("金蝶登录成功但未解析到 KDSVCSessionId，无法继续。");
    process.exit(1);
  }

  const setCookieHeader = normalize(loginResp.setCookieHeader);

  const values = await readSheetValues(
    feishuToken,
    spreadsheetToken,
    `${sheetRef}!A1:AZ30000`,
    { valueRenderOption: "FormattedValue" }
  );

  const header = values?.[0] || [];
  const rows = values.slice(1);
  const headerIndex = buildHeaderIndex(header);

  const cols = Object.fromEntries(
    Object.entries(FIELD_CANDIDATES).map(([key, names]) => [key, findColumn(headerIndex, names)])
  );

  if (cols.logisticsProvider == null) cols.logisticsProvider = 20;
  if (cols.salesOrderNo == null) {
    cols.salesOrderNo = COL_W;
    console.warn("未找到销售订单号表头，暂时使用 W 列作为销售订单号/金蝶结果列。后续建议在飞书表增加独立表头：金蝶销售订单号");
  }

  const rowsForPlan = [];
  let lastPaymentOwner = "";
  let lastLogisticsProvider = "";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;

    const rawSalesOrderNo = normalize(getCell(row, cols.salesOrderNo));
    const salesOrderNo = extractSalesOrderNo(rawSalesOrderNo);
    if (!salesOrderNo) continue;

    if (isAlreadyHandled(row, cols)) continue;

    const status = normalize(getCell(row, cols.status));
    if (cols.status != null && !isCandidateStatus(status)) continue;

    let paymentOwner = normalize(getCell(row, cols.paymentOwner));
    let logisticsProvider = normalize(getCell(row, cols.logisticsProvider));

    if (paymentOwner) lastPaymentOwner = paymentOwner;
    else paymentOwner = lastPaymentOwner;

    if (logisticsProvider) lastLogisticsProvider = logisticsProvider;
    else logisticsProvider = lastLogisticsProvider;

    const action = decidePushDeliveryAction({ paymentOwner, logisticsProvider });

    if (!action.ok) {
      await updateRowsVW(feishuToken, spreadsheetToken, sheetRef, [rowNumber], "5. 同步失败", action.reason);
      continue;
    }

    rowsForPlan.push({
      rowNumber,
      salesOrderNo,
      paymentOwner,
      logisticsProvider,
      action,
    });
  }

  const groups = new Map();
  for (const item of rowsForPlan) {
    const key = item.salesOrderNo;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  console.log(`push_delivery 候选销售订单数：${groups.size}，候选行数：${rowsForPlan.length}`);
  if (isDryRun()) {
    console.log("DRY_RUN=true，本次不会真实保存/提交金蝶，也不会写入飞书。");
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const [orderKey, items] of groups.entries()) {
    try {
      const ret = await processGroup({
        kdCfg,
        sessionId,
        setCookieHeader,
        feishuToken,
        spreadsheetToken,
        sheetRef,
        orderKey,
        items,
      });

      if (ret.ok && !ret.skipped) done += 1;
      else if (ret.skipped) skipped += 1;
      else failed += 1;

      console.log(ret.message);
    } catch (e) {
      failed += 1;
      const msg = e?.message || String(e);
      console.error(`${orderKey} 失败：${msg}`);
      await updateRowsVW(
        feishuToken,
        spreadsheetToken,
        sheetRef,
        items.map((x) => x.rowNumber),
        "5. 同步失败",
        msg
      );
    }
  }

  console.log(`完成：成功 ${done} 单，跳过 ${skipped} 单，失败 ${failed} 单。`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  isCandidateStatus,
  extractSalesOrderNo,
  parseSalesOrderStatus,
  main,
};
