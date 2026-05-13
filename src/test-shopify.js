const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const SHOPIFY_API_VERSION = "2024-10";

/** 项目根目录（含 package.json 的目录）下的 .env */
function getProjectEnvPath() {
  return path.join(PROJECT_ROOT, ".env");
}

/**
 * 简单解析 .env：按行 KEY=VALUE，写入 process.env。
 * 忽略空行与 # 注释；支持去掉首尾引号。
 */
function loadEnvFileManual(envPath) {
  if (!fs.existsSync(envPath)) return;
  let text = fs.readFileSync(envPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) process.env[key] = value;
  }
}

function loadEnv() {
  const envPath = getProjectEnvPath();
  try {
    require("dotenv").config({ path: envPath });
  } catch {
    loadEnvFileManual(envPath);
  }
  // 若包内 .env 未配置完整，再尝试上级目录（常见于 .env 放在仓库根目录）
  const needShop = !String(process.env.SHOPIFY_SHOP ?? "").trim();
  const needToken = !String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim();
  if (needShop || needToken) {
    loadEnvFileManual(path.join(PROJECT_ROOT, "..", ".env"));
  }
}

function normalizeShop(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!s.includes(".")) {
    s = `${s}.myshopify.com`;
  }
  return s;
}

function checkEnv() {
  const missing = [];
  if (!String(process.env.SHOPIFY_SHOP ?? "").trim()) {
    missing.push("SHOPIFY_SHOP");
  }
  if (!String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim()) {
    missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  }
  if (missing.length) {
    const list = missing.join("、");
    console.error(`缺少环境变量：${list}`);
    console.error("请在 .env 中配置上述变量后重试。");
    process.exit(1);
  }
}

const ORDERS_QUERY = `
  query RecentOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          name
          paymentGatewayNames
          shippingAddress {
            country
          }
          lineItems(first: 100) {
            edges {
              node {
                sku
                quantity
                variant {
                  sku
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchRecentOrders(shop, accessToken, first) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: ORDERS_QUERY, variables: { first } }),
    signal: AbortSignal.timeout(60000),
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

function formatPaymentMethod(names) {
  if (!names?.length) return "";
  return names.join(", ");
}

function lineSku(node) {
  const s = String(node?.sku ?? "").trim();
  if (s) return s;
  return String(node?.variant?.sku ?? "").trim();
}

function linePrice(node) {
  const amount = node?.originalUnitPriceSet?.shopMoney?.amount;
  return amount != null ? String(amount) : "";
}

function printOrderSummary(order, index) {
  console.log("");
  console.log(`--- 订单 ${index + 1} ---`);
  console.log(`Name: ${order.name ?? ""}`);
  console.log(`Payment Method: ${formatPaymentMethod(order.paymentGatewayNames)}`);
  console.log(`Shipping Country: ${order.shippingAddress?.country ?? ""}`);

  const lineEdges = order.lineItems?.edges ?? [];
  if (lineEdges.length === 0) {
    console.log("(无行项目)");
    return;
  }

  for (let i = 0; i < lineEdges.length; i++) {
    const node = lineEdges[i].node;
    console.log(`  [行 ${i + 1}] Lineitem sku: ${lineSku(node)}`);
    console.log(`  [行 ${i + 1}] Lineitem quantity: ${node.quantity ?? ""}`);
    console.log(`  [行 ${i + 1}] Lineitem price: ${linePrice(node)}`);
  }
}

async function main() {
  loadEnv();
  checkEnv();

  const shop = normalizeShop(process.env.SHOPIFY_SHOP);
  const token = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN).trim();

  let orders;
  try {
    orders = await fetchRecentOrders(shop, token, 10);
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      console.error("请求 Shopify API 超时（60s）");
      process.exit(1);
    }
    console.error(err.message || err);
    process.exit(1);
  }

  console.log(`拉到的订单数量：${orders.length}`);

  const top = orders.slice(0, 3);
  console.log("");
  console.log(`前 ${top.length} 个订单关键信息：`);
  top.forEach((order, i) => printOrderSummary(order, i));
}

main();
