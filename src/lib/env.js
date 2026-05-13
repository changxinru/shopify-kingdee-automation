const fs = require("fs");
const path = require("path");

function getProjectRoot() {
  return path.join(__dirname, "..", "..");
}

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
  const PROJECT_ROOT = getProjectRoot();
  const envPath = path.join(PROJECT_ROOT, ".env");
  try {
    require("dotenv").config({ path: envPath });
  } catch {
    loadEnvFileManual(envPath);
  }
  const needShop = !String(process.env.SHOPIFY_SHOP ?? "").trim();
  const needToken = !String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? "").trim();
  if (needShop || needToken) {
    loadEnvFileManual(path.join(PROJECT_ROOT, "..", ".env"));
  }
}

module.exports = { loadEnv, getProjectRoot };
