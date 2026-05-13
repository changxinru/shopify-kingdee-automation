const FEISHU_API = "https://open.feishu.cn/open-apis";

async function feishuRequest(path, options = {}) {
  const url = path.startsWith("http") ? path : `${FEISHU_API}${path}`;
  const headers = { ...(options.headers || {}) };
  if (options.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书响应不是合法 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(`飞书 HTTP ${res.status}：${JSON.stringify(body)}`);
  }
  if (body.code !== 0) {
    throw new Error(`飞书 API 错误 code=${body.code}：${body.msg || JSON.stringify(body)}`);
  }
  return body;
}

let cachedTenantToken = null;
let cachedTenantTokenExpire = 0;

async function getTenantAccessToken(appId, appSecret) {
  const now = Date.now() / 1000;
  if (cachedTenantToken && now < cachedTenantTokenExpire - 60) {
    return cachedTenantToken;
  }
  const body = await feishuRequest("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const token = body.tenant_access_token;
  const expire = body.expire ?? 7200;
  if (!token) throw new Error("飞书 tenant_access_token 为空");
  cachedTenantToken = token;
  cachedTenantTokenExpire = now + expire;
  return token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * 将知识库 Wiki 节点 token 解析为电子表格 spreadsheet token（用于 sheets v2 API）。
 * @param {string} wikiToken 知识库节点 token（URL 中 /wiki/ 后的片段）
 * @param {string} tenantAccessToken tenant_access_token
 * @returns {Promise<string>}
 */
async function getSpreadsheetTokenFromWiki(wikiToken, tenantAccessToken) {
  const w = String(wikiToken ?? "").trim();
  if (!w) throw new Error("FEISHU_WIKI_TOKEN 为空");

  const t = String(tenantAccessToken ?? "").trim();
  if (!t) throw new Error("tenant_access_token 为空，无法调用 Wiki API");

  const path = `/wiki/v2/spaces/get_node?token=${encodeURIComponent(w)}`;
  const body = await feishuRequest(path, {
    method: "GET",
    headers: authHeaders(t),
  });

  const node = body.data?.node;
  if (!node || typeof node !== "object") {
    throw new Error("Wiki get_node 返回缺少 data.node");
  }

  const objType = String(node.obj_type ?? "").toLowerCase();
  const objToken = String(node.obj_token ?? "").trim();

  if (!objToken) {
    throw new Error("Wiki 节点未返回 obj_token，无法解析为电子表格");
  }

  const isSheet = objType === "sheet" || objType === "sheets";
  if (isSheet) {
    return objToken;
  }

  if (objType === "bitable") {
    throw new Error(
      "Wiki 节点为多维表格(bitable)，obj_token 不能用于电子表格 sheets API。请改用独立电子表格链接并配置 FEISHU_SPREADSHEET_TOKEN。",
    );
  }

  throw new Error(
    `Wiki 节点 obj_type=${objType || "(空)"}，需要为 sheet 才能解析为 spreadsheet token（当前 obj_token 已返回但类型不受支持）`,
  );
}

module.exports = {
  FEISHU_API,
  feishuRequest,
  authHeaders,
  getTenantAccessToken,
  getSpreadsheetTokenFromWiki,
};
