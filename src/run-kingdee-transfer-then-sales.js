const { spawnSync } = require("child_process");
const path = require("path");

function runStep(name, scriptPath) {
  console.log(`\n========== ${name} ==========`);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status}`);
  }
}

function main() {
  const transferScript = path.join(__dirname, "create-transfer-orders-from-feishu.js");
  const salesScript = path.join(__dirname, "create-direct-sales-orders-from-feishu.js");

  runStep("1/2 Kingdee transfer: Save + Submit + Audit", transferScript);
  runStep("2/2 Kingdee sales order", salesScript);

  console.log("\nKingdee transfer-then-sales flow completed.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}

module.exports = { main };
