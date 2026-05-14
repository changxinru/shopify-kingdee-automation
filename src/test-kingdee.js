const fs = require("fs");
const path = require("path");

const {
  loginBySign,
  isLoginSuccess,
  formatKingdeeErrorForConsole,
} = require("./kingdee-client");

const PROJECT_ROOT = path.join(__dirname, "..");

function getProjectEnvPath() {
  return path.join(PROJECT_ROOT, ".env");
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
  const envPath = getProjectEnvPath();
  try {
    require("dotenv").config({ path: envPath });
  } catch {
    loadEnvFileManual(envPath);
  }
  const need = [
    "KINGDEE_BASE_URL",
    "KINGDEE_ACCT_ID",
    "KINGDEE_APP_ID",
    "KINGDEE_APP_SECRET",
    "KINGDEE_USERNAME",
  ].some((k) => !String(process.env[k] ?? "").trim());
  if (need) {
    loadEnvFileManual(path.join(PROJECT_ROOT, "..", ".env"));
  }
}

function readConfig() {
  const baseUrl = String(process.env.KINGDEE_BASE_URL ?? "").trim();
  const acctId = String(process.env.KINGDEE_ACCT_ID ?? "").trim();
  const username = String(process.env.KINGDEE_USERNAME ?? "").trim();
  const appId = String(process.env.KINGDEE_APP_ID ?? "").trim();
  const appSecret = String(process.env.KINGDEE_APP_SECRET ?? "").trim();
  const lcidRaw = String(process.env.KINGDEE_LCID ?? "2052").trim();
  const lcidNum = Number(lcidRaw);
  const lcid = Number.isFinite(lcidNum) ? lcidNum : lcidRaw;

  const missing = [];
  if (!baseUrl) missing.push("KINGDEE_BASE_URL");
  if (!acctId) missing.push("KINGDEE_ACCT_ID");
  if (!username) missing.push("KINGDEE_USERNAME");
  if (!appId) missing.push("KINGDEE_APP_ID");
  if (!appSecret) missing.push("KINGDEE_APP_SECRET");

  return {
    ok: missing.length === 0,
    missing,
    config: { baseUrl, acctId, username, appId, appSecret, lcid },
  };
}

async function main() {
  loadEnv();
  const { ok, missing, config } = readConfig();
  if (!ok) {
    console.error(`缺少环境变量：${missing.join("、")}`);
    console.error("请在项目根目录 .env 中配置后重试。");
    process.exit(1);
  }

  let resp;
  try {
    resp = await loginBySign(config);
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

  if (isLoginSuccess(resp.data)) {
    console.log("金蝶登录成功");
    process.exit(0);
  }

  console.error(formatKingdeeErrorForConsole(resp));
  process.exit(1);
}

main();
