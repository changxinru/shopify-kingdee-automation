const FEISHU_API = "https://open.feishu.cn/open-apis";

function logFullError(prefix, error) {
  console.error(prefix);
  console.error("error:", error);
  console.error("error.message:", error?.message);
  console.error("error.cause:", error?.cause);
  console.error("error.stack:", error?.stack);
}

async function feishuRequest(path, options = {}) {
  const url = path.startsWith("http") ? path : `${FEISHU_API}${path}`;
  const headers = { ...(options.headers || {}) };
  if (options.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const method = options.method || "GET";
  console.log(`[Feishu Request] ${method} ${url}`);

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(120000),
    });
  } catch (error) {
    logFullError(`[Feishu Fetch Failed] ${method} ${url}`, error);
    throw error;
  }

  const text = await res.text();

  if (!res.ok) {
    console.error(`[Feishu HTTP Error] ${method} ${url}`);
    console.error("status:", res.status);
    console.error("statusText:", res.statusText);
    console.error("response text:", text);
    throw new Error(`飞书 HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    console.error(`[Feishu JSON Parse Error] ${method} ${url}`);
    console.error("status:", res.status);
    console.error("statusText:", res.statusText);
    console.error("response text:", text);
    logFullError("JSON parse error detail:", error);
    throw new Error(`飞书响应不是合法 JSON（HTTP ${res.status}）`);
  }

  if (body.code !== 0) {
    console.error(`[Feishu API Error] ${method} ${url}`);
    console.error("status:", res.status);
    console.error("statusText:", res.statusText);
    console.error("response body:", JSON.stringify(body, null, 2));
    throw new Error(`飞书 API 错误 code=${body.code}：${body.msg || JSON.stringify(body)}`);
  }
  return body;
}

let cachedTenantToken = null;
let cachedTenantTokenExpire = 0;

async function getTenantAccessToken(appId, appSecret) {
  console.log("[Feishu Step] 开始获取 tenant_access_token");
  const now = Date.now() / 1000;
  if (cachedTenantToken && now < cachedTenantTokenExpire - 60) {
    console.log("[Feishu Step] 使用缓存 tenant_access_token");
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
  console.log(`[Feishu Step] tenant_access_token 获取成功，expire=${expire}`);
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
  console.log("[Feishu Step] 开始使用 Wiki token 解析 spreadsheet token");
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
  console.log(`[Feishu Step] Wiki get_node 成功，obj_type=${objType || "(空)"}`);

  if (!objToken) {
    throw new Error("Wiki 节点未返回 obj_token，无法解析为电子表格");
  }

  const isSheet = objType === "sheet" || objType === "sheets";
  if (isSheet) {
    console.log("[Feishu Step] Wiki token 解析 spreadsheet token 成功");
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
  logFullError,
};
