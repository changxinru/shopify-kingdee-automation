const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.KINGDEE_UI_PORT || 3000);
const ROOT = path.join(__dirname, "..");

let running = null;
let logs = [];
let lastExitCode = null;

const tasks = {
  "transfer-then-sales": {
    title: "一键：调拨 → 销售订单",
    script: path.join(__dirname, "run-kingdee-transfer-then-sales.js"),
    dryRun: false,
  },
  transfer: {
    title: "只跑调拨单",
    script: path.join(__dirname, "create-transfer-orders-from-feishu.js"),
    dryRun: false,
  },
  sales: {
    title: "只跑销售订单",
    script: path.join(__dirname, "create-direct-sales-orders-from-feishu.js"),
    dryRun: false,
  },
  "dry-transfer-then-sales": {
    title: "测试：调拨 → 销售订单（Dry Run）",
    script: path.join(__dirname, "run-kingdee-transfer-then-sales.js"),
    dryRun: true,
  },
  "dry-sales": {
    title: "测试：只跑销售订单（Dry Run）",
    script: path.join(__dirname, "create-direct-sales-orders-from-feishu.js"),
    dryRun: true,
  },
};

function addLog(line) {
  const text = String(line || "");
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  logs.push(`[${time}] ${text}`);
  if (logs.length > 1500) logs = logs.slice(-1500);
}

function runTask(key) {
  const task = tasks[key];
  if (!task) return { ok: false, message: "未知任务" };
  if (running) return { ok: false, message: `已有任务正在运行：${running.title}` };

  logs = [];
  lastExitCode = null;
  running = { key, title: task.title, startedAt: new Date().toISOString() };
  addLog(`开始：${task.title}`);
  if (task.dryRun) addLog("DRY_RUN=true，不会真实调用金蝶保存/提交/审核，也不会真实回写飞书。");

  const child = spawn(process.execPath, [task.script], {
    cwd: ROOT,
    env: { ...process.env, ...(task.dryRun ? { DRY_RUN: "true" } : {}) },
    shell: false,
  });

  child.stdout.on("data", (data) => addLog(data.toString()));
  child.stderr.on("data", (data) => addLog(data.toString()));
  child.on("error", (error) => addLog(`启动失败：${error.message}`));
  child.on("close", (code) => {
    lastExitCode = code;
    addLog(code === 0 ? "完成。" : `失败，退出码：${code}`);
    running = null;
  });

  return { ok: true, message: `已启动：${task.title}` };
}

function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function pageHtml() {
  const buttons = Object.entries(tasks)
    .map(([key, task]) => `<button onclick="runTask('${key}')">${task.title}</button>`)
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>金蝶自动化操作面板</title>
  <style>
    body { font-family: Arial, 'Microsoft YaHei', sans-serif; margin: 0; background: #f6f7f9; color: #222; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .desc { color: #666; margin-bottom: 22px; }
    .card { background: white; border-radius: 16px; padding: 22px; box-shadow: 0 8px 24px rgba(0,0,0,.08); margin-bottom: 18px; }
    .buttons { display: flex; flex-wrap: wrap; gap: 12px; }
    button { border: 0; border-radius: 12px; padding: 13px 18px; font-size: 16px; cursor: pointer; background: #1664ff; color: white; }
    button:hover { filter: brightness(.95); }
    button:disabled { background: #aaa; cursor: not-allowed; }
    .status { font-weight: 700; margin-bottom: 10px; }
    pre { background: #101828; color: #d0d5dd; border-radius: 12px; padding: 16px; overflow: auto; min-height: 360px; white-space: pre-wrap; }
    .hint { color: #666; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>金蝶自动化操作面板</h1>
    <div class="desc">点按钮即可执行，不用手动输入 npm 命令。</div>

    <div class="card">
      <div class="buttons">${buttons}</div>
    </div>

    <div class="card hint">
      推荐日常使用：<b>一键：调拨 → 销售订单</b>。<br />
      第一次或不确定时，先点 Dry Run 测试，不会真实写入金蝶。
    </div>

    <div class="card">
      <div class="status" id="status">状态：未运行</div>
      <pre id="log"></pre>
    </div>
  </div>

<script>
async function runTask(key) {
  const resp = await fetch('/run?task=' + encodeURIComponent(key), { method: 'POST' });
  const data = await resp.json();
  alert(data.message || '已发送');
  refresh();
}
async function refresh() {
  const resp = await fetch('/status');
  const data = await resp.json();
  document.getElementById('status').textContent = data.running
    ? '状态：运行中 - ' + data.running.title
    : '状态：空闲' + (data.lastExitCode === null ? '' : '，上次退出码：' + data.lastExitCode);
  document.getElementById('log').textContent = data.logs.join('\n');
}
setInterval(refresh, 1500);
refresh();
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageHtml());
    return;
  }
  if (req.method === "POST" && url.pathname === "/run") {
    sendJson(res, runTask(url.searchParams.get("task")));
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, { running, logs, lastExitCode });
    return;
  }
  sendJson(res, { ok: false, message: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`金蝶自动化操作面板已启动：http://localhost:${PORT}`);
  console.log("保持这个窗口不要关闭。关闭窗口后，按钮面板也会停止。");
});
