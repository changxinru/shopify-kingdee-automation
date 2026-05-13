const GATEWAY_PRETTY = {
  shopify_payments: "Shopify Payments",
  paypal: "PayPal Express Checkout",
  paypal_express_checkout: "PayPal Express Checkout",
  airwallex: "Airwallex - Cards and Local Payment Methods",
  shop_cash: "Shop Cash",
};

function titleCaseWords(s) {
  return String(s)
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ")
    .trim();
}

function prettifyUnknownGateway(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return titleCaseWords(t.replace(/_/g, " "));
}

/**
 * @param {string[]} names paymentGatewayNames from Shopify
 */
function formatPaymentDisplayNames(names) {
  if (!names?.length) return "";
  return names
    .map((n) => {
      const key = String(n).trim().toLowerCase();
      if (GATEWAY_PRETTY[key]) return GATEWAY_PRETTY[key];
      return prettifyUnknownGateway(n);
    })
    .filter(Boolean)
    .join(" + ");
}

module.exports = { formatPaymentDisplayNames, prettifyUnknownGateway };
