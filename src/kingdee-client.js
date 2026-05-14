const crypto = require("crypto");

/** 金蝶云星空 WebAPI：签名登录（与 LoginBySign 接口约定一致） */
const LOGIN_BY_SIGN_PATH =
  "Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginBySign.common.kdsvc";

/**
 * @param {string} baseUrl 站点根路径，如 https://host/k3cloud/
 * @returns {string} 以 / 结尾的基址
 */
function normalizeKingdeeBaseUrl(baseUrl) {
  const s = String(baseUrl ?? "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "") + "/";
}

/**
 * AppId + AppSecret + 时间戳的 SHA256（hex），参与排序的字段与官方示例一致：
 * [acctId, username, appId, appSecret, timestamp] 按 UTF-8 字节字典序排序后拼接，再 SHA256（与
 * github.com/deep-project/kingdee 中 LoginBySign 实现一致）。
 *
 * @param {{ acctId: string, username: string, appId: string, appSecret: string, timestampSec: number|string }} p
 */
function buildLoginBySignHash(p) {
  const ts = String(p.timestampSec);
  const parts = [p.acctId, p.username, p.appId, p.appSecret, ts].map(String);
  parts.sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  );
  const joined = parts.join("");
  return crypto.createHash("sha256").update(joined, "utf8").digest("hex");
}

/**
 * 调用 LoginBySign，不在请求中传递用户明文密码。
 *
 * @param {{
 *   baseUrl: string,
 *   acctId: string,
 *   username: string,
 *   appId: string,
 *   appSecret: string,
 *   lcid?: number|string,
 * }} config
 * @returns {Promise<{ status: number, data: object|null, rawBody: string, url: string }>}
 */
async function loginBySign(config) {
  const base = normalizeKingdeeBaseUrl(config.baseUrl);
  if (!base) {
    throw new Error("KINGDEE_BASE_URL 为空");
  }
  const url = base + LOGIN_BY_SIGN_PATH;
  const timestampSec = Math.floor(Date.now() / 1000);
  const sign = buildLoginBySignHash({
    acctId: config.acctId,
    username: config.username,
    appId: config.appId,
    appSecret: config.appSecret,
    timestampSec,
  });
  const lcid = String(config.lcid ?? 2052);
  const body = {
    parameters: [
      config.acctId,
      config.username,
      config.appId,
      String(timestampSec),
      sign,
      lcid,
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const rawBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    /* 保留 rawBody */
  }
  return { status: res.status, data, rawBody, url };
}

/**
 * @param {object|null} data
 * @returns {{ resultType: number|null, message: string }}
 */
function parseLoginResult(data) {
  if (!data || typeof data !== "object") {
    return { resultType: null, message: "" };
  }
  const raw = data.LoginResultType ?? data.loginResultType;
  const n = raw === undefined || raw === null ? NaN : Number(raw);
  const message = String(data.Message ?? data.message ?? "");
  return {
    resultType: Number.isFinite(n) ? n : null,
    message,
  };
}

function isLoginSuccess(data) {
  const { resultType } = parseLoginResult(data);
  return resultType === 1;
}

/**
 * 用于失败输出：金蝶返回的完整信息（不打印 appSecret）。
 *
 * @param {{ status: number, data: object|null, rawBody: string, url: string }} resp
 */
function formatKingdeeErrorForConsole(resp) {
  const lines = [];
  lines.push(`HTTP ${resp.status}`);
  lines.push(`请求地址：${resp.url}`);
  if (resp.data && typeof resp.data === "object") {
    lines.push(JSON.stringify(resp.data, null, 2));
  } else {
    lines.push(resp.rawBody);
  }
  return lines.join("\n");
}

module.exports = {
  LOGIN_BY_SIGN_PATH,
  normalizeKingdeeBaseUrl,
  buildLoginBySignHash,
  loginBySign,
  parseLoginResult,
  isLoginSuccess,
  formatKingdeeErrorForConsole,
};
