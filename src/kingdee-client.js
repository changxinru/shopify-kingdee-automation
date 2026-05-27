const crypto = require("crypto");

const LOGIN_BY_SIGN_PATH =
  "Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginBySign.common.kdsvc";

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

function getSetCookieHeader(headers) {
  if (!headers) return "";
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((x) => String(x).split(";")[0]).join("; ");
  }
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    const arr = raw && raw["set-cookie"];
    if (Array.isArray(arr)) return arr.map((x) => String(x).split(";")[0]).join("; ");
  }
  const one = typeof headers.get === "function" ? headers.get("set-cookie") : "";
  return one ? String(one).split(";")[0] : "";
}

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
    // keep rawBody
  }

  return {
    status: res.status,
    data,
    rawBody,
    url,
    setCookieHeader: getSetCookieHeader(res.headers),
  };
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

function kingdeeSessionIdFromLogin(data) {
  if (!data || typeof data !== "object") return "";
  return String(
    data.KDSVCSessionId ??
    data.KdSvcSessionId ??
    data.KDSVCSESSIONID ??
    data.SessionId ??
    data.sessionId ??
    data.Context?.SessionId ??
    ""
  ).trim();
}

async function callDynamicFormService({
  baseUrl,
  sessionId,
  setCookieHeader = "",
  serviceName,
  parameters,
}) {
  const base = normalizeKingdeeBaseUrl(baseUrl);
  if (!base) throw new Error("KINGDEE_BASE_URL 为空");
  if (!serviceName) throw new Error("serviceName 为空");

  const url =
    base +
    `Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.${serviceName}.common.kdsvc`;

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (sessionId) headers["kdservice-sessionid"] = sessionId;
  if (setCookieHeader) headers.Cookie = setCookieHeader;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ parameters }),
  });

  const rawBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    // keep rawBody
  }

  return { status: res.status, data, rawBody, url };
}

async function saveDynamicForm({ baseUrl, sessionId, setCookieHeader = "", formId, model }) {
  return callDynamicFormService({
    baseUrl,
    sessionId,
    setCookieHeader,
    serviceName: "Save",
    parameters: [
      formId,
      JSON.stringify({
        NeedUpDateFields: [],
        NeedReturnFields: ["FBillNo", "FID"],
        IsDeleteEntry: false,
        SubSystemId: "",
        IsVerifyBaseDataField: false,
        IsEntryBatchFill: true,
        ValidateFlag: true,
        NumberSearch: true,
        IsAutoAdjustField: false,
        InterationFlags: "",
        IgnoreInterationFlag: "",
        Model: model,
      }),
    ],
  });
}

async function submitDynamicForm({ baseUrl, sessionId, setCookieHeader = "", formId, billNo }) {
  return callDynamicFormService({
    baseUrl,
    sessionId,
    setCookieHeader,
    serviceName: "Submit",
    parameters: [
      formId,
      JSON.stringify({
        Numbers: [billNo],
        Ids: "",
      }),
    ],
  });
}

async function pushDynamicForm({
  baseUrl,
  sessionId,
  setCookieHeader = "",
  sourceFormId,
  targetFormId,
  billNo,
  ruleId = "",
}) {
  return callDynamicFormService({
    baseUrl,
    sessionId,
    setCookieHeader,
    serviceName: "Push",
    parameters: [
      sourceFormId,
      JSON.stringify({
        Ids: "",
        Numbers: [billNo],
        EntryIds: "",
        RuleId: ruleId,
        TargetFormId: targetFormId,
        IsEnableDefaultRule: !ruleId,
        IsDraftWhenSaveFail: true,
        CustomParams: {},
      }),
    ],
  });
}

async function executeBillQuery({ baseUrl, sessionId, setCookieHeader = "", formId, fieldKeys, filterString, limit = 1 }) {
  return callDynamicFormService({
    baseUrl,
    sessionId,
    setCookieHeader,
    serviceName: "ExecuteBillQuery",
    parameters: [
      {
        FormId: formId,
        FieldKeys: fieldKeys,
        FilterString: filterString,
        OrderString: "",
        TopRowCount: limit,
        StartRow: 0,
        Limit: limit,
      },
    ],
  });
}

function normalizeKingdeeResultData(data) {
  if (!data || typeof data !== "object") return data;
  const raw = data.Result ?? data.result;
  if (typeof raw === "string") {
    try {
      return { ...data, Result: JSON.parse(raw) };
    } catch {
      return data;
    }
  }
  return data;
}

function getKingdeeResult(data) {
  const normalized = normalizeKingdeeResultData(data);
  return normalized?.Result ?? normalized?.result ?? normalized;
}

function isKingdeeSaveSuccess(data) {
  const result = getKingdeeResult(data);
  const status = result?.ResponseStatus ?? result?.responseStatus;
  if (status && typeof status === "object") {
    const ok = status.IsSuccess ?? status.isSuccess;
    return ok === true || String(ok).toLowerCase() === "true";
  }
  const ok = result?.IsSuccess ?? result?.isSuccess;
  return ok === true || String(ok).toLowerCase() === "true";
}

function kingdeeSaveErrorMessage(data) {
  const result = getKingdeeResult(data);
  const status = result?.ResponseStatus ?? result?.responseStatus;
  const errors = status?.Errors ?? status?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => e.Message || e.message || JSON.stringify(e)).join("；");
  }
  return String(
    result?.Message ??
    result?.message ??
    data?.Message ??
    data?.message ??
    JSON.stringify(data)
  );
}

function kingdeeSaveBillNo(data) {
  const result = getKingdeeResult(data);
  const status = result?.ResponseStatus ?? result?.responseStatus;
  const success = status?.SuccessEntitys ?? status?.successEntitys ?? [];
  const candidates = [
    result?.Number,
    result?.BillNo,
    result?.FBillNo,
    success?.[0]?.Number,
    success?.[0]?.BillNo,
    success?.[0]?.FBillNo,
  ];
  return String(candidates.find((x) => x) ?? "").trim();
}

function kingdeePushedModel(data) {
  const result = getKingdeeResult(data);
  return (
    result?.Model ??
    result?.Data?.[0] ??
    result?.data?.[0] ??
    result?.TargetData?.[0] ??
    null
  );
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
  normalizeKingdeeBaseUrl,
  buildLoginBySignHash,
  loginBySign,
  parseLoginResult,
  isLoginSuccess,
  kingdeeSessionIdFromLogin,
  callDynamicFormService,
  saveDynamicForm,
  submitDynamicForm,
  pushDynamicForm,
  executeBillQuery,
  isKingdeeSaveSuccess,
  kingdeeSaveErrorMessage,
  kingdeeSaveBillNo,
  kingdeePushedModel,
  normalizeKingdeeResultData,
  formatKingdeeErrorForConsole,
};
