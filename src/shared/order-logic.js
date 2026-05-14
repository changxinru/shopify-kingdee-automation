const CUSTOMER_CODE = "CUST0042";
const PLATFORM = "独立站";
const SPEAKER_FIXED_PRICE = 320;

/** 美国 Winit：按原始 Lineitem SKU（与飞书/Shopify 一致，大小写不敏感） */
const US_WINIT_SKUS = new Set(
  [
    "PartyKeys-Black",
    "PartyKeys-White",
    "PartyStudio - Black",
    "PartyStudio - White",
    "Black 72keys+case",
    "White 72keys+case",
    "Studio+36keys black",
    "Studio+36keys white",
    "Studio+72keys black",
    "Studio+72keys white",
  ].map((s) => s.toLowerCase()),
);

/** 美国立达：按原始 SKU */
const US_LIDA_SKUS = new Set(
  [
    "POPUPIANO COMBO-BLACK",
    "POPUPIANO COMBO-WHITE",
    "POPUPIANO 1-BAG-BLACK",
    "POPUPIANO EXTRAPIANO 1-BLACK",
    "POPUPIANO EXTRAPIANO 1-WHITE",
    "POPUSOUND-BLACK",
    "POPUSOUND-WHITE",
  ].map((s) => s.toLowerCase()),
);

/**
 * 国家/地区（中文名、英文名、ISO）→ 完整物流服务字符串（与业务表一致）
 * 用于非美国订单；再经 extractShortCarrier 得到飞书 U 列大物流商。
 */
const COUNTRY_KEY_TO_LOGISTICS = (() => {
  const m = {};
  const add = (keys, service) => {
    for (const k of keys) {
      m[normalizeLower(k)] = service;
    }
  };
  add(["it", "italy", "意大利"], "云途-云途全球专线挂号（特惠带电）");
  add(["il", "israel", "以色列"], "燕文新系统-燕文专线快递-特货");
  add(["au", "australia", "澳大利亚"], "视感4PX-联邮通定制产品-澳洲Aupost-带电");
  add(["fr", "france", "法国"], "云途-云途全球精选专线挂号（特惠带电）");
  add(["gb", "uk", "united kingdom", "英国"], "云途-云途全球云选专线挂号（带电）");
  add(["ch", "switzerland", "瑞士"], "燕文新系统-燕文专线快递-特货");
  add(["kr", "korea", "south korea", "韩国"], "燕文新系统-燕文专线追踪-特货");
  add(["ca", "canada", "加拿大"], "燕文新系统-燕文专线追踪-特货");
  add(["cz", "czech republic", "捷克共和国", "czechia"], "云途-云途全球专线挂号（特惠带电）");
  add(["lt", "lithuania", "立陶宛"], "燕文新系统-燕文专线追踪-特货");
  add(["es", "spain", "西班牙"], "云途-云途全球专线挂号（特惠带电）");
  add(["sg", "singapore", "新加坡"], "视感4PX-4PX-S邮速递");
  add(["se", "sweden", "瑞典"], "云途-云途全球专线挂号（特惠带电）");
  add(["mx", "mexico", "墨西哥"], "燕文新系统-燕文专线追踪-特货");
  add(["be", "belgium", "比利时"], "云途-云途全球专线挂号（特惠带电）");
  add(["sk", "slovakia", "斯洛伐克共和国", "slovak republic"], "云途-云途全球专线挂号（特惠带电）");
  add(["tr", "turkey", "土耳其"], "燕文新系统-燕文专线快递-特货");
  add(["fi", "finland", "芬兰"], "燕文新系统-燕文专线快递-特货");
  add(["ua", "ukraine", "乌克兰"], "燕文新系统-燕文专线追踪-特货");
  add(["ae", "united arab emirates", "阿拉伯联合酋长国", "uae"], "燕文新系统-燕文专线追踪-特货");
  add(["am", "armenia", "亚美尼亚"], "自定义-法世威快递专线");
  add(["nz", "new zealand", "新西兰"], "燕文新系统-燕文专线追踪-特货");
  add(["uz", "uzbekistan", "乌兹别克斯坦"], "自定义-法世威快递专线");
  add(["in", "india", "印度"], "燕文新系统-燕文专线追踪-特货");
  add(["pl", "poland", "波兰"], "云途-云途全球专线挂号（特惠带电）");
  add(["my", "malaysia", "马来西亚"], "视感顺丰国际-国际电商专递-CD");
  add(["hr", "croatia", "克罗地亚"], "云途-云途全球专线挂号（特惠带电）");
  add(["ro", "romania", "罗马尼亚"], "云途-云途全球专线挂号（特惠带电）");
  add(["no", "norway", "挪威"], "燕文新系统-燕文专线追踪-特货");
  add(["de", "germany", "德国"], "云途-云途全球云选专线挂号（带电）");
  add(["pt", "portugal", "葡萄牙"], "云途-云途中包专线挂号（特惠带电）");
  add(["bg", "bulgaria", "保加利亚"], "云途-云途全球专线挂号（特惠带电）");
  add(["at", "austria", "奥地利"], "云途-云途全球专线挂号（特惠带电）");
  add(["om", "oman", "阿曼"], "自定义-法世威快递专线");
  add(["lv", "latvia", "拉脱维亚"], "云途-云途全球专线挂号（特惠带电）");
  add(["gr", "greece", "希腊"], "云途-云途大货专线挂号（特惠带电）");
  add(["nl", "netherlands", "荷兰"], "云途-云途中包专线挂号（特惠带电）");
  add(["jp", "japan", "日本"], "迅田");
  return m;
})();

const CARRIER_KEYWORD_ORDER = ["云途", "燕文", "法世威", "易通关", "顺丰", "跨越", "货拉拉", "中通", "迅田", "4PX"];

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeLower(value) {
  return normalize(value).toLowerCase();
}

function parseNumber(value) {
  const cleaned = String(value ?? "0").replace(/[^0-9.-]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function buildAddress(row) {
  return [
    row["Shipping Address1"],
    row["Shipping Address2"],
    row["Shipping City"],
    row["Shipping Province"],
    row["Shipping Zip"],
    row["Shipping Country"],
  ]
    .filter(Boolean)
    .join(", ");
}

function findSkuRule(skuMaps, shopifySku) {
  return skuMaps.find((item) => normalizeLower(item.shopify_sku) === normalizeLower(shopifySku));
}

function findMaterialCode(materialMaps, productName) {
  const found = materialMaps.find((item) => normalizeLower(item.product_name) === normalizeLower(productName));
  return found?.kingdee_material_code || "";
}

function findPaymentRule(paymentMaps, paymentMethod) {
  const exact = paymentMaps.find((item) => normalizeLower(item.payment_method) === normalizeLower(paymentMethod));
  if (exact) return exact;

  if (paymentMethod.includes("Shopify Payments")) {
    return { payment_method: paymentMethod, sales_org: "MGSG", payment_owner: "美国" };
  }
  if (paymentMethod.includes("PayPal Express Checkout")) {
    return { payment_method: paymentMethod, sales_org: "XGSG", payment_owner: "香港" };
  }
  if (paymentMethod.includes("Airwallex")) {
    return { payment_method: paymentMethod, sales_org: "XGSG", payment_owner: "香港" };
  }
  if (paymentMethod.includes("Shop Cash")) {
    return { payment_method: paymentMethod, sales_org: "MGSG", payment_owner: "美国" };
  }
  return undefined;
}

/**
 * @param {object} opts
 * @param {string} [opts.lineDiscountedTotal] 行折扣后总价（Shopify）；有则按 /quantity 得到单价基准
 * @param {number} [opts.quantity=1]
 * @param {number|string} opts.lineitemPrice 单品时：已由上游按「折后单价优先链」算出；combo 时为折后单行兜底单价
 */
function splitProducts({ product1, product2, lineDiscountedTotal, quantity = 1, lineitemPrice }) {
  product1 = normalize(product1);
  product2 = normalize(product2);
  const qty = Math.max(1, parseNumber(quantity) || 1);

  const d = lineDiscountedTotal != null ? parseNumber(lineDiscountedTotal) : NaN;
  let perUnitForSplit;
  if (Number.isFinite(d) && d > 0) {
    perUnitForSplit = d / qty;
  } else {
    perUnitForSplit = parseNumber(lineitemPrice);
  }

  if (!product2) {
    const li = parseNumber(lineitemPrice);
    if (Number.isFinite(li) && li > 0) return [{ productName: product1, unitPrice: li }];
    return [{ productName: product1, unitPrice: perUnitForSplit }];
  }

  const products = [product1, product2];
  const speaker = products.find((p) => p.includes("二代音响"));
  const other = products.find((p) => !p.includes("二代音响"));

  if (speaker && other) {
    return [
      { productName: other, unitPrice: perUnitForSplit - SPEAKER_FIXED_PRICE },
      { productName: speaker, unitPrice: SPEAKER_FIXED_PRICE },
    ];
  }

  return products.map((productName) => ({ productName, unitPrice: perUnitForSplit / products.length }));
}

function isUsCountry(country, countryCode) {
  const c = normalizeLower(country);
  const code = normalizeLower(countryCode || "");
  if (code === "us") return true;
  return (
    c === "us" ||
    c === "usa" ||
    c === "united states" ||
    c === "united states of america" ||
    c === "美国"
  );
}

function isUsPaymentCollection(paymentOwner, salesOrg) {
  return normalize(paymentOwner) === "美国" || normalize(salesOrg) === "MGSG";
}

function findCountryShippingService(countryMaps, country) {
  const found = countryMaps.find((item) => normalizeLower(item.country) === normalizeLower(country));
  return found?.logistics_service || "";
}

function findProviderByService(providerMaps, logisticsService) {
  const svc = normalize(logisticsService);
  if (!svc) return undefined;
  const bySubstring = providerMaps.find((item) => {
    const kw = normalize(item.provider_keyword ?? "");
    return kw && svc.includes(kw);
  });
  if (bySubstring) return bySubstring;
  const short = extractShortCarrier(svc);
  if (!short || short === "待人工确认") return undefined;
  return providerMaps.find((item) => normalize(item.provider_keyword ?? "") === short);
}

function resolveNonUsLogisticsService(countryName, countryCode) {
  const nameK = normalizeLower(countryName);
  const codeK = normalizeLower(countryCode || "").replace(/^country\./i, "");
  if (codeK && COUNTRY_KEY_TO_LOGISTICS[codeK]) return COUNTRY_KEY_TO_LOGISTICS[codeK];
  if (nameK && COUNTRY_KEY_TO_LOGISTICS[nameK]) return COUNTRY_KEY_TO_LOGISTICS[nameK];
  return "";
}

function extractShortCarrier(logisticsService) {
  const s = normalize(logisticsService);
  if (!s) return "待人工确认";
  for (const kw of CARRIER_KEYWORD_ORDER) {
    if (s.includes(kw)) {
      if (kw === "迅田") return "迅田";
      return kw;
    }
  }
  return "待人工确认";
}

/**
 * @param {object} p
 * @param {string} p.country shipping country 文本
 * @param {string} [p.countryCode] ISO 如 US、JP
 * @param {string} p.originalSku 原始 SKU
 * @param {string} p.productName 拆分后中文名（用于美国未匹配时的错误信息）
 * @param {object[]} p.countryMaps
 * @param {object[]} p.providerMaps
 */
function resolveFulfillment({ country, countryCode, originalSku, productName, countryMaps, providerMaps }) {
  const skuKey = normalizeLower(originalSku);

  if (isUsCountry(country, countryCode)) {
    if (US_WINIT_SKUS.has(skuKey)) {
      const full = "万邑";
      return {
        logisticsProvider: full,
        logisticsService: full,
        stockOrg: "XGSG",
        fulfillmentType: "overseas_direct_sales_order",
        needWarehouseNotice: "no",
        providerAddress: "",
      };
    }
    if (US_LIDA_SKUS.has(skuKey)) {
      return {
        logisticsProvider: "立达",
        logisticsService: "立达",
        stockOrg: "XGSG",
        fulfillmentType: "overseas_direct_sales_order",
        needWarehouseNotice: "no",
        providerAddress: "",
      };
    }
    return {
      logisticsProvider: "待人工确认",
      logisticsService: "待人工确认",
      stockOrg: "待人工确认",
      fulfillmentType: "manual_review",
      needWarehouseNotice: "no",
      providerAddress: "",
      error: `美国订单未匹配物流 SKU：${originalSku || "(空)"}（产品：${productName}）`,
    };
  }

  let logisticsService =
    resolveNonUsLogisticsService(country, countryCode) ||
    findCountryShippingService(countryMaps, countryCode) ||
    findCountryShippingService(countryMaps, country);

  if (!logisticsService) {
    return {
      logisticsProvider: "待人工确认",
      logisticsService: "待人工确认",
      stockOrg: "待人工确认",
      fulfillmentType: "manual_review",
      needWarehouseNotice: "yes",
      providerAddress: "",
      error: `没有找到国家物流规则：${country || ""} / ${countryCode || ""}`,
    };
  }

  const shortCarrier = extractShortCarrier(logisticsService);
  const provider = findProviderByService(providerMaps, logisticsService);
  if (!provider) {
    if (shortCarrier !== "待人工确认") {
      return {
        logisticsProvider: shortCarrier,
        logisticsService,
        stockOrg: "SZSG",
        fulfillmentType: "china_warehouse_sales_order",
        needWarehouseNotice: "yes",
        providerAddress: "",
      };
    }
    return {
      logisticsProvider: "待人工确认",
      logisticsService,
      stockOrg: "待人工确认",
      fulfillmentType: "manual_review",
      needWarehouseNotice: "yes",
      providerAddress: "",
      error: `没有从物流方式识别到快递商配置（data/logistics-provider-map.csv 与物流串）：${logisticsService}`,
    };
  }

  return {
    logisticsProvider: shortCarrier,
    logisticsService,
    stockOrg: provider.stock_org,
    fulfillmentType: "china_warehouse_sales_order",
    needWarehouseNotice: "yes",
    providerAddress: provider.provider_address,
  };
}

function buildWarehouseNotices(lines) {
  const needNotice = lines.filter((line) => line.need_warehouse_notice === "yes");
  const grouped = new Map();

  for (const line of needNotice) {
    const key = [line.order_name, line.payment_owner, line.logistics_provider, line.logistics_service].join("||");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(line);
  }

  const notices = [];
  for (const group of grouped.values()) {
    const first = group[0];
    const productLines = group
      .map((line, index) => `${index + 1}. ${line.product_name_for_check} × ${line.quantity}`)
      .join("\n");

    notices.push(
      [
        `平台：${PLATFORM}`,
        `付款归属：${first.payment_owner}`,
        `订单号：${first.order_name}`,
        "",
        "发货产品：",
        productLines,
        "",
        `快递商：${first.logistics_provider}`,
        `快递方式：${first.logistics_service}`,
        "",
        "请发到以下快递商地址：",
        first.provider_address || "",
        "",
        "-----------------------------",
      ].join("\n"),
    );
  }

  return notices.join("\n\n");
}

module.exports = {
  CUSTOMER_CODE,
  PLATFORM,
  SPEAKER_FIXED_PRICE,
  normalize,
  normalizeLower,
  parseNumber,
  buildAddress,
  findSkuRule,
  findMaterialCode,
  findPaymentRule,
  splitProducts,
  isUsCountry,
  isUsPaymentCollection,
  findCountryShippingService,
  findProviderByService,
  resolveFulfillment,
  buildWarehouseNotices,
};
