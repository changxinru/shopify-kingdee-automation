const fs = require("fs");
const path = require("path");
const { Parser } = require("json2csv");

const { loadEnv, getProjectRoot } = require("./lib/env");
const { getTenantAccessToken, getSpreadsheetTokenFromWiki } = require("./feishu-client");
const { readSheetValues, batchUpdateValues } = require("./lib/feishu-sheets");

const OUTPUT_DIR = path.join(getProjectRoot(), "output");

const SHEET_REF_DEFAULT = "独立站";
const STATUS_HEADER = "同步状态";
const ERROR_HEADER = "错误信息";

const STATUS_WAIT_KINGDEE = "待同步金蝶";
const STATUS_WAIT_TRANSFER_REVIEW = "待审核调拨";
const STATUS_TRANSFER_CONFIRMED = "调拨已确认";
const STATUS_WAIT_SALES_ORDER = "待生成销售订单";
const STATUS_SALES_ORDER_DONE = "金蝶销售订单已生成";
const STATUS_FAILED = "同步失败";
const STATUS_DONE = "已完成";
const STATUS_WAIT_CHECK = "待检查";

function normalize(s) {
  return String(s ?? "").trim();
}

function toNumber(v) {
  const cleaned = String(v ?? "").replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
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

function buildHeaderIndex(headerRow) {
  const idx = new Map();
  for (let i = 0; i < headerRow.length; i++) {
    const key = normalize(headerRow[i]);
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, i);
  }
  return idx;
}

function getByCol(valuesRow, colIndex0) {
  if (colIndex0 == null || colIndex0 < 0) return "";
  return valuesRow?.[colIndex0] ?? "";
}

function paymentOwnerFromRow(headerIndex, row) {
  // 若表里有“收款账户”列则优先用；否则返回空并走付款方式(D列)兜底
  const candidates = ["收款账户", "付款归属", "payment_owner", "payment owner"];
  for (const name of candidates) {
    const idx = headerIndex.get(name);
    if (idx != null) {
      const v = normalize(getByCol(row, idx));
      if (v) return v;
    }
  }
  return "";
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

function actualShipStockOrgFromLogisticsProvider(logisticsProvider) {
  const lp = normalize(logisticsProvider);
  if (!lp) return "";
  if (lp.includes("万邑") || lp.includes("立达")) return "XGSG";
  const szKeywords = ["云途", "燕文", "4PX", "法世威", "迅田", "顺丰", "易通关", "中通", "跨越", "货拉拉"];
  if (szKeywords.some((k) => lp.includes(k))) return "SZSG";
  return "";
}

function transferRule(paymentOwner, actualShipStockOrg) {
  const owner = normalize(paymentOwner);
  if (owner === "美国" && actualShipStockOrg === "SZSG") {
    return {
      transfer_required: "yes",
      transfer_from_stock_org: "SZSG",
      transfer_to_stock_org: "XGSG",
      sales_order_stock_org: "XGSG",
    };
  }
  return {
    transfer_required: "no",
    transfer_from_stock_org: "",
    transfer_to_stock_org: "",
    sales_order_stock_org: actualShipStockOrg,
  };
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

function getFeishuCredentials() {
  const appId = String(process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || "").trim();
  const wikiToken = String(process.env.FEISHU_WIKI_TOKEN || "").trim();
  const envSpreadsheetToken = String(process.env.FEISHU_SPREADSHEET_TOKEN || "").trim();
  const sheetRef = String(process.env.FEISHU_SHEET_ID || "").trim() || String(process.env.FEISHU_SHEET_NAME || SHEET_REF_DEFAULT).trim();
  return { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef };
}

async function main() {
  loadEnv();
  checkFeishuEnv();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { appId, appSecret, wikiToken, envSpreadsheetToken, sheetRef } = getFeishuCredentials();
  const feishuToken = await getTenantAccessToken(appId, appSecret);

  let spreadsheetToken = envSpreadsheetToken;
  if (!spreadsheetToken) {
    spreadsheetToken = await getSpreadsheetTokenFromWiki(wikiToken, feishuToken);
  }

  const values = await readSheetValues(feishuToken, spreadsheetToken, `${sheetRef}!A1:AZ30000`, { valueRenderOption: "FormattedValue" });
  const header = values?.[0] || [];
  const rows = values.slice(1);

  const headerIndex = buildHeaderIndex(header);
  const statusIdx = headerIndex.get(STATUS_HEADER);
  const errorIdx = headerIndex.get(ERROR_HEADER);

  if (statusIdx == null || errorIdx == null) {
    console.error(`飞书缺少列：${STATUS_HEADER} / ${ERROR_HEADER}（请先运行 npm run sync 或手动补表头）`);
    process.exit(1);
  }

  const toProcess = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const status = normalize(getByCol(row, statusIdx));
    if (status === STATUS_WAIT_KINGDEE) {
      toProcess.push({ rowNumber: i + 2, row });
    }
  }

  const groups = new Map();
  for (const item of toProcess) {
    const orderName = normalize(getByCol(item.row, 1)); // B 列
    if (!orderName) continue;
    if (!groups.has(orderName)) groups.set(orderName, []);
    groups.get(orderName).push(item);
  }

  const salesPreview = [];
  const transferPreview = [];
  const statusUpdates = [];

  let needTransferOrders = 0;
  let noTransferOrders = 0;
  let errorLines = 0;

  for (const [orderName, items] of groups.entries()) {
    let orderNeedTransfer = false;
    let orderHasError = false;

    for (const item of items) {
      const r = item.row;
      const rowNo = item.rowNumber;

      const billDate = normalize(getByCol(r, 0)); // A
      const productNameForCheck = normalize(getByCol(r, 2)); // C
      const paymentMethod = normalize(getByCol(r, 3)); // D
      const taxPrice = toNumber(getByCol(r, 4)); // E
      const qty = toNumber(getByCol(r, 5)); // F
      const materialCode = normalize(getByCol(r, 7)); // H
      const deliveryDate = normalize(getByCol(r, 11)) || billDate; // L
      const contactInfo = normalize(getByCol(r, 12)); // M
      const logisticsProvider = normalize(getByCol(r, 20)); // U

      const paymentOwner = paymentOwnerFromRow(headerIndex, r);
      const salesOrg = salesOrgFromOwnerOrPaymentMethod(paymentOwner, paymentMethod);
      const actualShipStockOrg = actualShipStockOrgFromLogisticsProvider(logisticsProvider);

      const missing = [];
      if (!orderName) missing.push("缺少订单号(B列)");
      if (!billDate) missing.push("缺少日期(A列)");
      if (!materialCode) missing.push("缺少物料编码(H列)");
      if (!Number.isFinite(taxPrice)) missing.push("缺少单价(E列)");
      if (!Number.isFinite(qty) || qty <= 0) missing.push("缺少数量(F列)");
      if (!logisticsProvider) missing.push("缺少物流商(U列)");
      if (!salesOrg) missing.push("无法识别销售组织（收款账户/付款方式）");
      if (!actualShipStockOrg) missing.push("无法从物流商识别发货库存组织");

      if (missing.length) {
        const msg = missing.join("；");
        statusUpdates.push({
          range: `${sheetRef}!${indexToColumnName(statusIdx + 1)}${rowNo}:${indexToColumnName(statusIdx + 1)}${rowNo}`,
          values: [[STATUS_FAILED]],
        });
        statusUpdates.push({
          range: `${sheetRef}!${indexToColumnName(errorIdx + 1)}${rowNo}:${indexToColumnName(errorIdx + 1)}${rowNo}`,
          values: [[msg]],
        });
        errorLines += 1;
        orderHasError = true;
        orderHasError = true;
        continue;
      }

      const tr = transferRule(paymentOwner, actualShipStockOrg);
      if (tr.transfer_required === "yes") orderNeedTransfer = true;

      salesPreview.push({
        order_name: orderName,
        bill_date: billDate,
        sales_org: salesOrg,
        customer_code: "CUST0042",
        currency: "人民币",
        material_code: materialCode,
        tax_price: taxPrice,
        qty: qty,
        actual_ship_stock_org: actualShipStockOrg,
        sales_order_stock_org: tr.sales_order_stock_org,
        transfer_required: tr.transfer_required,
        delivery_date: deliveryDate,
        contact_info: contactInfo,
        logistics_provider: logisticsProvider,
        remark: `独立站订单 ${orderName} ${logisticsProvider}`,
        product_name_for_check: productNameForCheck,
        source_sheet: SHEET_REF_DEFAULT,
      });

      if (tr.transfer_required === "yes") {
        transferPreview.push({
          order_name: orderName,
          bill_date: billDate,
          from_stock_org: "SZSG",
          to_stock_org: "XGSG",
          material_code: materialCode,
          qty: qty,
          product_name_for_check: productNameForCheck,
          logistics_provider: logisticsProvider,
          remark: "美国收款订单，实际从 SZSG 发货，需先做销售调拨 SZSG → XGSG，再做销售订单",
        });
      }
    }

    if (!orderHasError) {
      // 更新本订单所有行：待审核调拨 / 待生成销售订单，错误信息清空
      const newStatus = orderNeedTransfer ? STATUS_WAIT_TRANSFER_REVIEW : STATUS_WAIT_SALES_ORDER;
      if (orderNeedTransfer) needTransferOrders += 1;
      else noTransferOrders += 1;

      for (const item of items) {
        const rowNo = item.rowNumber;
        statusUpdates.push({
          range: `${sheetRef}!${indexToColumnName(statusIdx + 1)}${rowNo}:${indexToColumnName(statusIdx + 1)}${rowNo}`,
          values: [[newStatus]],
        });
        statusUpdates.push({
          range: `${sheetRef}!${indexToColumnName(errorIdx + 1)}${rowNo}:${indexToColumnName(errorIdx + 1)}${rowNo}`,
          values: [[""]],
        });
      }
    }
  }

  const salesFields = [
    "order_name",
    "bill_date",
    "sales_org",
    "customer_code",
    "currency",
    "material_code",
    "tax_price",
    "qty",
    "actual_ship_stock_org",
    "sales_order_stock_org",
    "transfer_required",
    "delivery_date",
    "contact_info",
    "logistics_provider",
    "remark",
    "product_name_for_check",
    "source_sheet",
  ];

  const transferFields = [
    "order_name",
    "bill_date",
    "from_stock_org",
    "to_stock_org",
    "material_code",
    "qty",
    "product_name_for_check",
    "logistics_provider",
    "remark",
  ];

  const salesPath = path.join(OUTPUT_DIR, "kingdee-sales-order-preview.csv");
  const transferPath = path.join(OUTPUT_DIR, "kingdee-transfer-preview.csv");

  const salesCsv = new Parser({ fields: salesFields, withBOM: true }).parse(salesPreview);
  fs.writeFileSync(salesPath, salesCsv, "utf-8");

  const transferCsv = new Parser({ fields: transferFields, withBOM: true }).parse(transferPreview);
  fs.writeFileSync(transferPath, transferCsv, "utf-8");

  // 回写飞书状态/错误信息
  if (statusUpdates.length) {
    await batchUpdateValues(feishuToken, spreadsheetToken, statusUpdates);
  }

  console.log(`飞书读取行数：${rows.length}`);
  console.log(`待同步金蝶行数：${toProcess.length}`);
  console.log(`销售订单预览行数：${salesPreview.length}`);
  console.log(`调拨预览行数：${transferPreview.length}`);
  console.log(`需要调拨订单数：${needTransferOrders}`);
  console.log(`不需要调拨订单数：${noTransferOrders}`);
  console.log(`错误行数：${errorLines}`);
  console.log(`销售订单预览文件：output/kingdee-sales-order-preview.csv`);
  console.log(`调拨预览文件：output/kingdee-transfer-preview.csv`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

