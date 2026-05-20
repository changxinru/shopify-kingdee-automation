const crypto = require("crypto");

/** 金蝶云星空 WebAPI：签名登录（与 LoginBySign 接口约定一致） */
const LOGIN_BY_SIGN_PATH =
  "Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginBySign.common.kdsvc";
const SAVE_PATH = "Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Save.common.kdsvc";
const SUBMIT_PATH = "Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Submit.common.kdsvc";
const AUDIT_PATH = "Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Audit.common.kdsvc";

function normalizeKingdeeBaseUrl(baseUrl) {
  const s = String(baseUrl ?? "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "") + "/";
}

function buildLoginBySignHash(p) {
  const ts = String(p.timestampSec);
  const parts = [p.acctId, p.username, p.appId, p.appSecret, ts].map(String);
  parts.sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  );
  const joined = parts.join("");
  return crypto.createHash("sha256").update(joined, "utf8").digest("hex");
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
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
  return { status: res.status, data, rawBody, url, headers: res.headers };
}

async function loginBySign(config) {
  const base = normalizeKingdeeBaseUrl(config.baseUrl);
  if (!base) throw new Error("KINGDEE_BASE_URL 为空");
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
  return postJson(url, body);
}

function cookieFromLoginResponse(resp) {
  const cookie = resp?.headers?.get?.("set-cookie") || "";
  return cookie
    .split(/,(?=\s*[^;,]+=)/)
    .map((part) => part.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function loginAndGetCookie(config) {
  const base = normalizeKingdeeBaseUrl(config.baseUrl);
  if (!base) throw new Error("KINGDEE_BASE_URL 为空");
  const loginResp = await loginBySign(config);
  if (!isLoginSuccess(loginResp.data)) {
    throw new Error(formatKingdeeErrorForConsole(loginResp));
  }
  return { base, cookie: cookieFromLoginResponse(loginResp) };
}

async function saveDynamicForm(config, formId, model, options = {}) {
  const { base, cookie } = await loginAndGetCookie(config);
  const payload = {
    formid: formId,
    data: JSON.stringify({
      NeedUpDateFields: options.needUpdateFields || [],
      NeedReturnFields: options.needReturnFields || ["FBillNo", "FID"],
      IsDeleteEntry: options.isDeleteEntry ?? true,
      SubSystemId: options.subSystemId ?? "",
      IsVerifyBaseDataField: options.verifyBaseDataField ?? false,
      IsEntryBatchFill: options.isEntryBatchFill ?? true,
      ValidateFlag: options.validateFlag ?? true,
      NumberSearch: options.numberSearch ?? true,
      IsAutoAdjustField: options.autoAdjustField ?? false,
      InterationFlags: options.interationFlags ?? "",
      IgnoreInterationFlag: options.ignoreInterationFlag ?? "",
      IsControlPrecision: options.isControlPrecision ?? false,
      ValidateRepeatJson: options.validateRepeatJson ?? false,
      Model: model,
    }),
  };
  return postJson(base + SAVE_PATH, payload, cookie ? { Cookie: cookie } : {});
}

async function submitDynamicForm(config, formId, idOrNumber, options = {}) {
  return operateDynamicForm(config, SUBMIT_PATH, formId, idOrNumber, options);
}

async function auditDynamicForm(config, formId, idOrNumber, options = {}) {
  return operateDynamicForm(config, AUDIT_PATH, formId, idOrNumber, options);
}

async function operateDynamicForm(config, path, formId, idOrNumber, options = {}) {
  const { base, cookie } = await loginAndGetCookie(config);
  const id = String(idOrNumber?.id || "").trim();
  const number = String(idOrNumber?.number || "").trim();
  const data = {
    CreateOrgId: options.createOrgId || 0,
    Numbers: number ? [number] : [],
    Ids: id,
    SelectedPostId: options.selectedPostId || 0,
    NetworkCtrl: options.networkCtrl || "",
    IgnoreInterationFlag: options.ignoreInterationFlag ?? true,
  };
  const payload = { formid: formId, data: JSON.stringify(data) };
  return postJson(base + path, payload, cookie ? { Cookie: cookie } : {});
}

function parseSaveResult(data) {
  const result = data?.Result || data?.result || data;
  const responseStatus = result?.ResponseStatus || result?.responseStatus || {};
  const isSuccess = Boolean(responseStatus?.IsSuccess ?? responseStatus?.isSuccess);
  const errors = Array.isArray(responseStatus?.Errors || responseStatus?.errors)
    ? (responseStatus.Errors || responseStatus.errors)
    : [];
  const successMessages = Array.isArray(responseStatus?.SuccessEntitys || responseStatus?.successEntitys)
    ? (responseStatus.SuccessEntitys || responseStatus.successEntitys)
    : [];
  const number = result?.Number || result?.number || successMessages?.[0]?.Number || successMessages?.[0]?.number || "";
  const id = result?.Id || result?.id || successMessages?.[0]?.Id || successMessages?.[0]?.id || "";
  return { isSuccess, number, id, errors, result };
}

function parseOperationResult(data) {
  return parseSaveResult(data);
}

function formatSaveError(resp) {
  const parsed = parseSaveResult(resp?.data);
  const details = parsed.errors
    .map((e) => e?.Message || e?.message || e?.FieldName || JSON.stringify(e))
    .filter(Boolean)
    .join("；");
  if (details) return details;
  if (resp?.data) return JSON.stringify(resp.data);
  return resp?.rawBody || `HTTP ${resp?.status || ""}`;
}

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
  SAVE_PATH,
  SUBMIT_PATH,
  AUDIT_PATH,
  normalizeKingdeeBaseUrl,
  buildLoginBySignHash,
  loginBySign,
  parseLoginResult,
  isLoginSuccess,
  saveDynamicForm,
  submitDynamicForm,
  auditDynamicForm,
  parseSaveResult,
  parseOperationResult,
  formatSaveError,
  formatKingdeeErrorForConsole,
};
