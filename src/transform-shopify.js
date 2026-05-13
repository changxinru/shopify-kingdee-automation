const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { Parser } = require("json2csv");

const {
  CUSTOMER_CODE,
  PLATFORM,
  normalize,
  parseNumber,
  buildAddress,
  findSkuRule,
  findMaterialCode,
  findPaymentRule,
  splitProducts,
  isUsPaymentCollection,
  resolveFulfillment,
  buildWarehouseNotices,
} = require("./shared/order-logic");

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_DIR = path.join(ROOT, "output");

function readCsv(fileName) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(path.join(DATA_DIR, fileName))
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const shopifyRows = await readCsv("orders_export.csv");
  const skuMaps = await readCsv("sku-product-map.csv");
  const materialMaps = await readCsv("product-material-map.csv");
  const paymentMaps = await readCsv("payment-sales-org-map.csv");
  const countryMaps = await readCsv("country-shipping-method-map.csv");
  const providerMaps = await readCsv("logistics-provider-map.csv");

  const outputLines = [];

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

  for (const row of shopifyRows) {
    const orderName = normalize(row["Name"]);
    const originalSku = normalize(row["Lineitem sku"]);
    const quantity = parseNumber(row["Lineitem quantity"]) || 1;
    const lineitemPrice = parseNumber(row["Lineitem price"]);
    const paymentMethod = normalize(row["Payment Method"]);
    const country = normalize(row["Shipping Country"]);
    const province = normalize(row["Shipping Province"]);
    const receiverName = normalize(row["Shipping Name"]);
    const receiverPhone = normalize(row["Shipping Phone"] || row["Phone"]);
    const receiverAddress = buildAddress(row);

    const errors = [];
    const skuRule = findSkuRule(skuMaps, originalSku);
    if (!skuRule) errors.push(`没有找到 SKU 产品映射：${originalSku}`);

    const paymentRule = findPaymentRule(paymentMaps, paymentMethod);
    if (!paymentRule) errors.push(`没有找到付款方式规则：${paymentMethod}`);

    if (!country) errors.push("缺少 Shipping Country");
    if (!orderName) errors.push("缺少订单号 Name");

    const splitItems = skuRule
      ? splitProducts({ product1: skuRule.product_1, product2: skuRule.product_2, lineitemPrice })
      : [{ productName: "待人工确认", unitPrice: lineitemPrice }];

    for (const item of splitItems) {
      const materialCode = findMaterialCode(materialMaps, item.productName);
      const fulfillment = resolveFulfillment({
        country,
        countryCode: "",
        originalSku,
        productName: item.productName,
        countryMaps,
        providerMaps,
      });
      const lineErrors = [...errors];

      if (!materialCode) lineErrors.push(`没有找到金蝶物料编码：${item.productName}`);
      if (fulfillment.error) lineErrors.push(fulfillment.error);

      const paymentOwner = paymentRule?.payment_owner || "待人工确认";
      const salesOrgVal = paymentRule?.sales_org || "待人工确认";
      const usPayment = isUsPaymentCollection(paymentOwner, salesOrgVal);
      const actualShipStockOrg = fulfillment.stockOrg;
      const salesOrderStockOrg = usPayment ? "XGSG" : actualShipStockOrg;

      outputLines.push({
        order_name: orderName,
        platform: PLATFORM,
        payment_method: paymentMethod,
        payment_owner: paymentOwner,
        sales_org: salesOrgVal,
        customer_code: CUSTOMER_CODE,
        original_sku: originalSku,
        product_name_for_check: item.productName,
        kingdee_material_code: materialCode || "待人工确认",
        quantity,
        unit_price: item.unitPrice,
        actual_ship_stock_org: actualShipStockOrg,
        sales_order_stock_org: salesOrderStockOrg,
        stock_org: salesOrderStockOrg,
        transfer_required: usPayment ? "yes" : "no",
        transfer_from_stock_org: usPayment ? "SZSG" : "",
        transfer_to_stock_org: usPayment ? "XGSG" : "",
        shipping_country: country,
        shipping_province: province,
        receiver_name: receiverName,
        receiver_phone: receiverPhone,
        receiver_address: receiverAddress,
        logistics_provider: fulfillment.logisticsProvider,
        logistics_service: fulfillment.logisticsService,
        fulfillment_type: fulfillment.fulfillmentType,
        need_warehouse_notice: fulfillment.needWarehouseNotice,
        provider_address: fulfillment.providerAddress,
        status: lineErrors.length > 0 ? "error" : "pending_review",
        error: lineErrors.join("; "),
      });
    }
  }

  const salesOrderCsv = new Parser({ fields: SALES_ORDER_CSV_FIELDS, withBOM: true }).parse(outputLines);
  fs.writeFileSync(path.join(OUTPUT_DIR, "sales-order-lines.csv"), salesOrderCsv, "utf-8");

  const transferOrderLines = outputLines
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

  const warehouseNotices = buildWarehouseNotices(outputLines);
  fs.writeFileSync(path.join(OUTPUT_DIR, "warehouse-notices.txt"), warehouseNotices, "utf-8");

  const errorCount = outputLines.filter((line) => line.status === "error").length;
  console.log("转换完成");
  console.log("销售订单明细：output/sales-order-lines.csv");
  console.log("销售调拨单明细：output/transfer-order-lines.csv");
  console.log("仓库通知：output/warehouse-notices.txt");
  console.log(`总行数：${outputLines.length}`);
  console.log(`调拨行数：${transferOrderLines.length}`);
  console.log(`错误行数：${errorCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
