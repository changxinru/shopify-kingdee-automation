const OUTSTOCK_CARRIERS = ["立达", "万邑"];

function normalize(value) {
  return String(value ?? "").trim();
}

function shouldCreateOutstockByLogisticsProvider(logisticsProvider) {
  const provider = normalize(logisticsProvider);
  return OUTSTOCK_CARRIERS.some((keyword) => provider.includes(keyword));
}

function decidePushDeliveryAction(row) {
  const paymentOwner = normalize(row?.paymentOwner ?? row?.收款账户 ?? row?.付款归属);
  const logisticsProvider = normalize(row?.logisticsProvider ?? row?.物流商 ?? row?.物流方式 ?? row?.物流服务商);

  if (!logisticsProvider) {
    return {
      ok: false,
      action: "error",
      reason: "缺少物流商，无法判断后续下推方式",
      paymentOwner,
      logisticsProvider,
    };
  }

  if (shouldCreateOutstockByLogisticsProvider(logisticsProvider)) {
    return {
      ok: true,
      action: "outstock",
      target: "销售出库单",
      steps: ["销售订单下推销售出库单", "保存销售出库单", "提交销售出库单"],
      statusText: "销售出库单已提交",
      paymentOwner,
      logisticsProvider,
    };
  }

  return {
    ok: true,
    action: "delivery_notice",
    target: "发货通知单",
    steps: ["销售订单下推发货通知单", "保存发货通知单"],
    statusText: "发货通知单已保存",
    paymentOwner,
    logisticsProvider,
  };
}

module.exports = {
  OUTSTOCK_CARRIERS,
  normalize,
  shouldCreateOutstockByLogisticsProvider,
  decidePushDeliveryAction,
};
