function normalizeSyncKeyPart(value) {
  return String(value ?? "").trim();
}

function buildSyncKey(shopifyOrderId, lineItemId, splitIndex) {
  const orderPart = normalizeSyncKeyPart(shopifyOrderId);
  const linePart = normalizeSyncKeyPart(lineItemId);
  const splitPart = normalizeSyncKeyPart(splitIndex);

  if (!orderPart || !linePart || splitPart === "") {
    throw new Error("Cannot build sync_key without order id, line item id, and split index");
  }

  return `${orderPart}__${linePart}__${splitPart}`;
}

module.exports = {
  buildSyncKey,
  normalizeSyncKeyPart,
};
