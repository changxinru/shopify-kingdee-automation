# Shopify → 金蝶销售订单试跑项目

## 第一次运行

1. 安装 Node.js LTS
2. 打开 Cursor 或 PowerShell，进入本项目目录
3. 运行：

```bash
npm install
npm start
```

## 输入文件

把 Shopify 导出的 CSV 放到：

```text
data/orders_export.csv
```

## 规则文件

```text
data/sku-product-map.csv                 Shopify SKU → 产品1/产品2
data/product-material-map.csv            产品名 → 金蝶物料编码
data/payment-sales-org-map.csv           付款方式 → 销售组织
data/country-shipping-method-map.csv     国家代码 → 店小秘物流方式
data/logistics-provider-map.csv          物流方式关键词 → 物流商/库存组织/地址
```

## 输出文件

```text
output/sales-order-lines.csv   销售订单明细
output/warehouse-notices.txt   给仓库的发货通知，仅非美国国内仓订单生成
```

## 检查重点

- status 是否为 error
- SKU 是否拆分正确
- material_code 是否正确
- sales_org 是否为 MGSG / XGSG
- 美国订单 need_warehouse_notice 应该是 no
- 非美国订单 need_warehouse_notice 应该是 yes
