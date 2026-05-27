const { loadEnv } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues } = require("./lib/feishu-sheets");
const { decidePushDeliveryAction, normalize } = require("./lib/push-delivery-rules");

const SHEET_REF_DEFAULT = "独立站";

const FIELD_CANDIDATES = {
  status: ["同步状态", "状态", "金蝶状态"],
  paymentOwner: ["收款账户", "付款归属", "payment_owner", "payment owner"],
  logisticsProvider: ["物流商", "物流方式", "物流服务商", "logistics_provider"],
  salesOrderNo: ["金蝶销售订单号", "销售订单号", "销售订单单号", "金蝶结果", "同步结果", "处理结果", "结果", "kingdee_sales_order_no", "sales_order_no"],
  outstockNo: ["销售出库单号", "金蝶销售出库单号", "outstock_no"],
  deliveryNoticeNo: ["发货通知单号", "金蝶发货通知单号", "delivery_notice_no"],
};

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

  if (missing.length) {
    throw new Error(`缺少飞书配置：${missing.join("、")}`);
  }

  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
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

  // 兼容：金蝶销售订单已保存：XGSGXSDD2605160002
  if (s.includes("：")) s = s.split("：").pop();
  if (s.includes(":")) s = s.split(":").pop();

  s = normalize(s);

  // 再兜底提取最后一段类似单号的内容
  const m = s.match(/[A-Za-z0-9_-]+$/);
  return m ? m[0] : s;
}

async function main() {
  loadEnv();

  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const feishuToken = await getTenantAccessToken(appId, appSecret);

  let spreadsheetToken = envSpreadsheetToken;
  if (!spreadsheetToken) {
    spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
  }

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

  // 当前表里 U 列通常是物流商，W 列通常是金蝶结果。
  if (cols.logisticsProvider == null) cols.logisticsProvider = 20;
  if (cols.salesOrderNo == null) {
    cols.salesOrderNo = 22;
    console.warn("未找到销售订单号表头，暂时使用 W 列作为销售订单号/金蝶结果列。后续建议在飞书表增加独立表头：金蝶销售订单号");
  }

  const plan = [];
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

    // 飞书合并单元格时，下面行读出来可能为空，所以继承上一行。
    if (paymentOwner) lastPaymentOwner = paymentOwner;
    else paymentOwner = lastPaymentOwner;

    if (logisticsProvider) lastLogisticsProvider = logisticsProvider;
    else logisticsProvider = lastLogisticsProvider;

    const action = decidePushDeliveryAction({
      paymentOwner,
      logisticsProvider,
    });

    plan.push({
      rowNumber,
      salesOrderNo,
      paymentOwner,
      logisticsProvider,
      action: action.action,
      target: action.target || "",
      statusText: action.statusText || "",
      reason: action.reason || "",
    });
  }

  console.log("push_delivery 待处理计划：");
  console.table(plan);
  console.log(`共 ${plan.length} 条待处理记录`);

  console.log("");
  console.log("当前版本只做读取和分流验证，还没有真实调用金蝶下推。");
  console.log("确认分流结果正确后，再进入下一步：接入金蝶下推/保存/提交。");
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
  main,
};
