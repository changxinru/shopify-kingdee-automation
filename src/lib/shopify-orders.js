const path = require("path");
const csv = require("csv-parser");
const fs = require("fs");
const { getProjectRoot } = require("./env");

const SHOPIFY_API_VERSION = "2024-10";

const ORDERS_QUERY = `
  query RecentPaidOrders($first: Int!, $query: String!) {
    orders(first: $first, reverse: true, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          cancelReason
          paymentGatewayNames
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          email
          phone
          shippingAddress {
            name
            address1
            address2
            city
            province
            provinceCode
            country
            countryCodeV2
            zip
            phone
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                sku
                quantity
                currentQuantity
                discountedTotalSet(withCodeDiscounts: true) {
                  shopMoney {
                    amount
                  }
                }
                discountedUnitPriceAfterAllDiscountsSet {
                  shopMoney {
                    amount
                  }
                }
                originalTotalSet {
                  shopMoney {
                    amount
                  }
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
                variant {
                  sku
                }
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeShop(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!s.includes(".")) {
    s = `${s}.myshopify.com`;
  }
  return s;
}

function readCsv(dataDir, fileName) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(path.join(dataDir, fileName))
      .pipe(csv())
      .on("data", (row) => {
        const cleaned = {};
        for (const [k, v] of Object.entries(row)) {
          const nk = String(k).replace(/^\ufeff/, "").trim();
          cleaned[nk] = v;
        }
        rows.push(cleaned);
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function loadMappingTables() {
  const dataDir = path.join(getProjectRoot(), "data");
  const [skuMaps, materialMaps, paymentMaps, countryMaps, providerMaps] = await Promise.all([
    readCsv(dataDir, "sku-product-map.csv"),
    readCsv(dataDir, "product-material-map.csv"),
    readCsv(dataDir, "payment-sales-org-map.csv"),
    readCsv(dataDir, "country-shipping-method-map.csv"),
    readCsv(dataDir, "logistics-provider-map.csv"),
  ]);
  return { skuMaps, materialMaps, paymentMaps, countryMaps, providerMaps };
}

const PAID_ORDERS_QUERY = "financial_status:paid";

async function fetchRecentPaidOrders(shop, accessToken, first) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: ORDERS_QUERY,
      variables: { first, query: PAID_ORDERS_QUERY },
    }),
    signal: AbortSignal.timeout(120000),
  });

  let data;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Shopify 响应不是合法 JSON（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    console.error("请求 Shopify API 失败：", res.status);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  if (data.errors?.length) {
    const msg = data.errors.map((e) => e.message).join("; ");
    throw new Error(`Shopify GraphQL 错误：${msg}`);
  }

  const edges = data.data?.orders?.edges ?? [];
  return edges.map((e) => e.node);
}

function lineSku(node) {
  const s = String(node?.sku ?? "").trim();
  if (s) return s;
  return String(node?.variant?.sku ?? "").trim();
}

function parseMoneyAmount(lineNode, pathFns) {
  for (const get of pathFns) {
    const raw = get(lineNode);
    const n = Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

/** Shopify 下单数量（可能与 currentQuantity 不同，仅作对照） */
function lineOrderedQuantity(lineNode) {
  const q = Number(lineNode?.quantity);
  return Number.isFinite(q) ? q : 0;
}

/**
 * 当前有效数量（飞书 F 列）；缺省时回退 quantity，与其它字段对齐。
 */
function lineCurrentQuantity(lineNode) {
  if (lineNode?.currentQuantity != null && lineNode?.currentQuantity !== "") {
    const cq = Number(lineNode.currentQuantity);
    if (Number.isFinite(cq)) return cq;
  }
  return lineOrderedQuantity(lineNode);
}

/** 含优惠码的行折扣后总价（GraphQL 已使用 discountedTotalSet(withCodeDiscounts: true)） */
function lineDiscountedTotalWithCodeDiscounts(lineNode) {
  return parseMoneyAmount(lineNode, [
    (n) => n?.discountedTotalSet?.shopMoney?.amount,
  ]);
}

function lineDiscountedUnitAfterAll(lineNode) {
  return parseMoneyAmount(lineNode, [
    (n) => n?.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount,
  ]);
}

function lineOriginalTotal(lineNode) {
  return parseMoneyAmount(lineNode, [(n) => n?.originalTotalSet?.shopMoney?.amount]);
}

function lineOriginalUnit(lineNode) {
  const u = Number(String(lineNode?.originalUnitPriceSet?.shopMoney?.amount ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(u) && u > 0 ? u : NaN;
}

/**
 * 飞书 E 列单价（非 combo 整行；combo 仍由 splitProducts 按行总价拆分）
 */
function computeFeishuEUnitPrice(lineNode, currentQty) {
  const du = lineDiscountedUnitAfterAll(lineNode);
  if (Number.isFinite(du) && du > 0) return du;

  const dt = lineDiscountedTotalWithCodeDiscounts(lineNode);
  if (Number.isFinite(dt) && dt > 0 && currentQty > 0) return dt / currentQty;

  const ot = lineOriginalTotal(lineNode);
  if (Number.isFinite(ot) && ot > 0 && currentQty > 0) return ot / currentQty;

  const ou = lineOriginalUnit(lineNode);
  if (Number.isFinite(ou) && ou > 0) return ou;

  return 0;
}

/**
 * combo 拆分的行折扣后成交总价：
 * 1) discountedTotalSet(withCodeDiscounts: true)
 * 2) 若该行总额仍等于券前 originalTotal，但 discountedUnitPriceAfterAllDiscounts 显示已打折，则用 单价×数量（兼容优惠码在行总额上未体现的返回）
 * 3) discountedUnitPriceAfterAllDiscounts × currentQuantity
 */
function lineDiscountedTotalForComboSplit(lineNode, currentQty) {
  const dt = lineDiscountedTotalWithCodeDiscounts(lineNode);
  const du = lineDiscountedUnitAfterAll(lineNode);
  const ot = lineOriginalTotal(lineNode);
  const fromUnit =
    Number.isFinite(du) && du > 0 && Number.isFinite(currentQty) && currentQty > 0 ? du * currentQty : NaN;

  if (Number.isFinite(dt) && dt > 0) {
    if (
      Number.isFinite(fromUnit) &&
      Number.isFinite(ot) &&
      ot > 0 &&
      Math.abs(dt - ot) <= 0.015 &&
      Math.abs(fromUnit - dt) > 0.015
    ) {
      return fromUnit;
    }
    return dt;
  }
  if (Number.isFinite(fromUnit)) return fromUnit;

  return 0;
}

/** 订单「商品侧」应付池：与后台 Total 一致，为 currentTotalPriceSet 减运费（税费等差额通过 scale 摊回行金额） */
function orderProductPoolAfterShipping(order) {
  const total = parseMoneyAmount(order, [(n) => n?.currentTotalPriceSet?.shopMoney?.amount]);
  const ship = parseMoneyAmount(order, [(n) => n?.totalShippingPriceSet?.shopMoney?.amount]);
  if (!Number.isFinite(total) || total <= 0) return NaN;
  const s = Number.isFinite(ship) && ship > 0 ? ship : 0;
  return Math.max(0, total - s);
}

/**
 * 行折后小计之和 与 订单 Total−运费 不一致时（多为税费），按比例调整行金额，使飞书 E 列与顾客实付对齐。
 */
function scaleFactorLineTotalsToOrderTotal(order, sumLineDiscountedTotals) {
  const pool = orderProductPoolAfterShipping(order);
  const sum = sumLineDiscountedTotals;
  if (!Number.isFinite(pool) || pool <= 0 || !Number.isFinite(sum) || sum <= 0) return 1;
  if (Math.abs(pool - sum) < 0.005) return 1;
  return pool / sum;
}

function roundMoney2(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

module.exports = {
  SHOPIFY_API_VERSION,
  PAID_ORDERS_QUERY,
  normalizeShop,
  loadMappingTables,
  fetchRecentPaidOrders,
  lineSku,
  lineOrderedQuantity,
  lineCurrentQuantity,
  lineDiscountedTotalWithCodeDiscounts,
  lineDiscountedTotalForComboSplit,
  computeFeishuEUnitPrice,
  orderProductPoolAfterShipping,
  scaleFactorLineTotalsToOrderTotal,
  roundMoney2,
};
