const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.KINGDEE_UI_PORT || 3000);
const ROOT = path.join(__dirname, "..");

let running = null;
let logs = [];
let lastExitCode = null;

const tasks = {
  sync: {
    title: "同步 Shopify → 飞书",
    command: "npm run sync",
    description: "从 Shopify 拉取订单并同步到飞书表格。",
    script: path.join(__dirname, "sync.js"),
  },
  flow: {
    title: "一键：调拨 → 销售订单",
    command: "npm run kingdee:transfer-then-sales",
    description: "调拨单保存、提交、审核后回写 V=3，然后自动生成销售订单并回写 V=4。",
    script: path.join(__dirname, "run-kingdee-transfer-then-sales.js"),
  },
  sales: {
    title: "只生成销售订单",
    command: "npm run kingdee:direct-sales",
    description: "只处理 V=1 和 V=3 的销售订单，成功后回写 V=4。",
    script: path.join(__dirname, "create-direct-sales-orders-from-feishu.js"),
  },
};

function addLog(text) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  logs.push(`[${time}] ${String(text || "")}`);
  if (logs.length > 1500) logs = logs.slice(-1500);
}

function runTask(key) {
  const task = tasks[key];
  if (!task) return { ok: false, message: "未知任务" };
  if (running) return { ok: false, message: `已有任务正在运行：${running.title}` };

  logs = [];
  lastExitCode = null;
  running = { key, title: task.title, command: task.command };
  addLog(`开始：${task.title}`);
  addLog(`实际调用指令：${task.command}`);

  const child = spawn(process.execPath, [task.script], {
    cwd: ROOT,
    env: process.env,
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

function json(res, data, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function htmlEscape(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function page() {
  const cards = Object.entries(tasks).map(([key, task]) => {
    return `<div class="task">
      <h2>${htmlEscape(task.title)}</h2>
      <p>${htmlEscape(task.description)}</p>
      <div class="label">实际调用指令</div>
      <code>${htmlEscape(task.command)}</code>
      <form method="POST" action="/run" onsubmit="return confirm('确认执行：${htmlEscape(task.title)}\\n\\n${htmlEscape(task.command)}')">
        <input type="hidden" name="task" value="${htmlEscape(key)}" />
        <button type="submit">点击执行</button>
      </form>
    </div>`;
  }).join("\n");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>自动化操作面板</title>
  <style>
    body{font-family:Arial,'Microsoft YaHei',sans-serif;background:#f6f7f9;margin:0;color:#222}.wrap{max-width:1100px;margin:0 auto;padding:28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.task,.card{background:#fff;border-radius:16px;padding:22px;box-shadow:0 8px 24px rgba(0,0,0,.08)}.task{border-left:6px solid #1664ff}h1{margin:0 0 8px}h2{font-size:18px;margin:0 0 10px}p{color:#666;line-height:1.6}.label{font-size:13px;color:#888;margin:14px 0 6px}code{display:block;background:#101828;color:#d0d5dd;border-radius:10px;padding:12px;overflow:auto}button{margin-top:14px;border:0;border-radius:12px;padding:12px 18px;background:#1664ff;color:#fff;font-size:15px;cursor:pointer}pre{background:#101828;color:#d0d5dd;border-radius:12px;padding:16px;min-height:320px;white-space:pre-wrap;overflow:auto}.card{margin-top:18px}
  </style></head><body><div class="wrap"><h1>自动化操作面板</h1><p>只保留当前实际使用的 3 个命令。点击后先确认，确认后才正式启动。</p><div class="grid">${cards}</div><div class="card"><b id="status">状态：未运行</b><pre id="log"></pre></div></div>
  <script>async function refresh(){const r=await fetch('/status');const d=await r.json();document.getElementById('status').textContent=d.running?'状态：运行中 - '+d.running.title+'｜'+d.running.command:'状态：空闲'+(d.lastExitCode===null?'':'，上次退出码：'+d.lastExitCode);document.getElementById('log').textContent=d.logs.join('\n')}setInterval(refresh,1500);refresh();</script>
  </body></html>`;
}

function parseBody(req, cb) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => cb(new URLSearchParams(body)));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }
  if (req.method === "POST" && url.pathname === "/run") {
    parseBody(req, (params) => {
      const result = runTask(params.get("task"));
      res.writeHead(303, { Location: "/" });
      res.end(result.message);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    json(res, { running, logs, lastExitCode });
    return;
  }
  json(res, { ok: false, message: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`自动化操作面板已启动：http://localhost:${PORT}`);
  console.log("保持这个窗口不要关闭。关闭窗口后，按钮面板也会停止。");
});
