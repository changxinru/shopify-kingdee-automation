const { formatPaymentDisplayNames } = require("./payment-display");
const { normalizeOrderKey } = require("./feishu-sheets");
const { lineSku, lineOrderedQuantity, lineCurrentQuantity, lineDiscountedTotalForComboSplit, computeFeishuEUnitPrice } = require("./shopify-orders");

const {
  CUSTOMER_CODE,
  PLATFORM,
  normalize,
  findSkuRule,
  findMaterialCode,
  findPaymentRule,
  splitProducts,
  isUsPaymentCollection,
  resolveFulfillment,
} = require("../shared/order-logic");

function buildAddressFromShopify(addr) {
  if (!addr) return "";
  return [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country]
    .filter(Boolean)
    .join(", ");
}

function isPaidAndNotCancelled(order) {
  const st = String(order.displayFinancialStatus ?? "").toUpperCase();
  return !order.cancelledAt && st === "PAID";
}

function buildOutputLinesFromOrder(order, maps) {
  if (!isPaidAndNotCancelled(order)) return [];
  const { skuMaps, materialMaps, paymentMaps, countryMaps, providerMaps } = maps;
  const orderName = normalizeOrderKey(order.name) || normalize(order.name);
  const paymentMethod = formatPaymentDisplayNames(order.paymentGatewayNames);
  const country = normalize(order.shippingAddress?.country);
  const countryCode = normalize(String(order.shippingAddress?.countryCodeV2 ?? ""));
  const province = normalize(order.shippingAddress?.province);
  const receiverName = normalize(order.shippingAddress?.name);
  const receiverPhone = normalize(order.shippingAddress?.phone || order.phone);
  const receiverAddress = buildAddressFromShopify(order.shippingAddress);
  const shopifyOrderId = normalize(order.id);

  const outputLines = [];
  const lineEdges = order.lineItems?.edges ?? [];

  for (let lineItemIndex = 0; lineItemIndex < lineEdges.length; lineItemIndex++) {
    const lineNode = lineEdges[lineItemIndex].node;
    const lineItemId = normalize(lineNode?.id);
    const originalSku = lineSku(lineNode);
    const orderedQty = lineOrderedQuantity(lineNode);
    const currentQty = lineCurrentQuantity(lineNode);

    if (orderedQty !== currentQty) {
      const tail = currentQty <= 0 ? "，已跳过旧商品。" : "。";
      console.log(
        `订单 ${orderName} 的 SKU ${originalSku || "(空)"} 已编辑，quantity=${orderedQty}，currentQuantity=${currentQty}${tail}`,
      );
    }

    if (currentQty <= 0) continue;

    const lineTotal = lineDiscountedTotalForComboSplit(lineNode, currentQty);
    const lineFallbackUnit = computeFeishuEUnitPrice(lineNode, currentQty);

    const errors = [];
    const skuRule = findSkuRule(skuMaps, originalSku);
    if (!skuRule) errors.push(`没有找到 SKU 产品映射：${originalSku}`);

    const paymentRule = findPaymentRule(paymentMaps, paymentMethod);
    if (!paymentRule) errors.push(`没有找到付款方式规则：${paymentMethod}`);

    if (!country) errors.push("缺少 Shipping Country");
    if (!orderName) errors.push("缺少订单号 Name");
    if (!shopifyOrderId) errors.push("缺少 Shopify order id");
    if (!lineItemId) errors.push("缺少 Shopify line item id");

    const splitItems = skuRule
      ? splitProducts({
          product1: skuRule.product_1,
          product2: skuRule.product_2,
          lineDiscountedTotal: lineTotal,
          quantity: currentQty,
          lineitemPrice: lineFallbackUnit,
        })
      : [
          {
            productName: "待人工确认",
            unitPrice:
              lineFallbackUnit > 0 ? lineFallbackUnit : currentQty > 0 ? lineTotal / currentQty : 0,
          },
        ];

    for (let splitIndex = 0; splitIndex < splitItems.length; splitIndex++) {
      const item = splitItems[splitIndex];
      const materialCode = findMaterialCode(materialMaps, item.productName);
      const fulfillment = resolveFulfillment({
        country,
        countryCode,
        originalSku,
        productName: item.productName,
        countryMaps,
        providerMaps,
      });
      const lineErrors = [...errors];

      if (!materialCode) lineErrors.push(`没有找到金蝶物料编码：${item.productName}`);
      if (fulfillment.error) lineErrors.push(fulfillment.error);

      const rawOrigU = lineNode?.originalUnitPriceSet?.shopMoney?.amount ?? "";
      const rawDiscU = lineNode?.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ?? "";
      const rawDiscT = lineNode?.discountedTotalSet?.shopMoney?.amount ?? "";
      const pricingLog =
        `[pricing] 订单号=${orderName} SKU=${originalSku || "(空)"} quantity=${orderedQty} currentQuantity=${currentQty} ` +
        `originalUnitPrice=${rawOrigU} discountedUnitPriceAfterAllDiscounts=${rawDiscU} discountedTotalWithCodeDiscounts=${rawDiscT} ` +
        `最终写入飞书E列单价=${item.unitPrice}`;

      let syncKey = "";

      const paymentOwner = paymentRule?.payment_owner || "待人工确认";
      const salesOrgVal = paymentRule?.sales_org || "待人工确认";
      const usPayment = isUsPaymentCollection(paymentOwner, salesOrgVal);
      const actualShipStockOrg = fulfillment.stockOrg;
      const salesOrderStockOrg = usPayment ? "XGSG" : actualShipStockOrg;

      outputLines.push({
        shopify_order_id: shopifyOrderId,
        shopify_line_item_id: lineItemId,
        line_item_index: lineItemIndex,
        split_index: splitIndex,
        order_name: orderName,
        platform: PLATFORM,
        payment_method: paymentMethod,
        payment_owner: paymentOwner,
        sales_org: salesOrgVal,
        customer_code: CUSTOMER_CODE,
        original_sku: originalSku,
        product_name_for_check: item.productName,
        kingdee_material_code: materialCode || "待人工确认",
        quantity: currentQty,
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
        _pricing_log: pricingLog,
      });
    }
  }

  return outputLines;
}

module.exports = {
  buildAddressFromShopify,
  buildOutputLinesFromOrder,
  isPaidAndNotCancelled,
};
