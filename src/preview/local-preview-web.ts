function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function encodedPreviewPath(value: string): string {
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function safeNonce(value: string): string {
  if (!/^[A-Za-z0-9+/_=-]{8,160}$/.test(value)) {
    throw new Error("手机预览页面 nonce 无效。");
  }
  return value;
}

export function localPreviewOpenContentSecurityPolicy(nonce: string): string {
  const value = safeNonce(nonce);
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    `style-src 'nonce-${value}'`,
    `script-src 'nonce-${value}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function localPreviewViewerContentSecurityPolicy(nonce: string): string {
  const value = safeNonce(nonce);
  return [
    "default-src 'none'",
    `style-src 'nonce-${value}'`,
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createLocalPreviewOpenHtml(nonce: string): string {
  const safeHtmlNonce = escapeHtml(safeNonce(nonce));
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f6f7f9">
  <meta name="robots" content="noindex,nofollow">
  <title>正在准备手机预览</title>
  <style nonce="${safeHtmlNonce}">
    :root { color-scheme: light; --ink:#17191d; --muted:#69707d; --line:#dfe3e8; --paper:#fff; --accent:#1769e8; --soft:#eaf2ff; --danger:#b42318; }
    * { box-sizing:border-box; }
    html, body { min-height:100%; }
    body { margin:0; background:#f6f7f9; color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button { font:inherit; }
    .page { min-height:100vh; min-height:100dvh; display:grid; place-items:center; padding:calc(28px + env(safe-area-inset-top)) 24px calc(28px + env(safe-area-inset-bottom)); }
    .deploy { width:min(100%, 540px); }
    .wordmark { margin-bottom:38px; font-size:14px; font-weight:700; letter-spacing:-.01em; }
    h1 { max-width:460px; margin:0; font-size:clamp(28px,8vw,44px); line-height:1.08; letter-spacing:-.035em; text-wrap:balance; }
    .lead { max-width:440px; margin:18px 0 0; color:var(--muted); font-size:16px; }
    .progress-shell { margin-top:38px; }
    .progress-track { height:7px; overflow:hidden; border-radius:7px; background:var(--line); }
    .progress-bar { width:100%; height:100%; border-radius:inherit; background:var(--accent); transform:scaleX(.04); transform-origin:left center; transition:transform .42s cubic-bezier(.2,.8,.2,1), background-color .2s ease-out; }
    .progress-bar.is-error { background:var(--danger); }
    .progress-meta { display:flex; align-items:baseline; justify-content:space-between; gap:20px; margin-top:13px; }
    .status { font-weight:650; }
    .percent { color:var(--muted); font-variant-numeric:tabular-nums; }
    .steps { display:grid; gap:11px; margin:30px 0 0; padding:0; list-style:none; color:var(--muted); }
    .step { display:grid; grid-template-columns:18px minmax(0,1fr); gap:10px; align-items:center; }
    .step-dot { width:8px; height:8px; border-radius:50%; background:#c8cdd5; transition:background .2s, transform .2s; }
    .step.is-active { color:var(--ink); }
    .step.is-active .step-dot { background:var(--accent); transform:scale(1.22); }
    .step.is-done .step-dot { background:#4f8c65; }
    .error { margin-top:24px; padding:14px 0; color:var(--danger); border-top:1px solid #efc9c5; border-bottom:1px solid #efc9c5; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px; }
    .action { min-height:44px; padding:0 17px; border:0; border-radius:12px; cursor:pointer; font-weight:650; }
    .action-primary { color:#fff; background:var(--ink); }
    .action-secondary { color:var(--ink); background:transparent; box-shadow:inset 0 0 0 1px var(--line); }
    .action:focus-visible { outline:3px solid rgba(23,105,232,.28); outline-offset:3px; }
    [hidden] { display:none !important; }
    @media (prefers-reduced-motion:reduce) { .progress-bar, .step-dot { transition:none; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="deploy" aria-labelledby="deploy-title">
      <div class="wordmark">WeRelay</div>
      <h1 id="deploy-title">正在部署到服务器上，以方便手机预览</h1>
      <p class="lead">每次打开都会重新读取电脑上的页面或文件，确保你看到的是当前最新版本。</p>
      <div class="progress-shell">
        <div class="progress-track" id="progress-track" role="progressbar" aria-label="部署进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="4">
          <div class="progress-bar" id="progress-bar"></div>
        </div>
        <div class="progress-meta">
          <div class="status" id="status" aria-live="polite">正在请求电脑准备最新内容</div>
          <div class="percent" id="percent">4%</div>
        </div>
      </div>
      <ol class="steps" aria-label="部署步骤">
        <li class="step is-active" data-threshold="4"><span class="step-dot"></span><span>连接电脑</span></li>
        <li class="step" data-threshold="12"><span class="step-dot"></span><span>读取本地内容</span></li>
        <li class="step" data-threshold="82"><span class="step-dot"></span><span>整理页面资源</span></li>
        <li class="step" data-threshold="90"><span class="step-dot"></span><span>部署到服务器</span></li>
      </ol>
      <div class="error" id="error" role="alert" hidden></div>
      <div class="actions" id="actions" hidden>
        <button class="action action-primary" id="retry" type="button">重新部署</button>
        <button class="action action-secondary" id="back" type="button">返回任务</button>
      </div>
    </section>
  </main>
  <script nonce="${safeHtmlNonce}">
    (function () {
      var target = new URL(window.location.href).searchParams.get("target") || "";
      var progressBar = document.getElementById("progress-bar");
      var progressTrack = document.getElementById("progress-track");
      var status = document.getElementById("status");
      var percent = document.getElementById("percent");
      var error = document.getElementById("error");
      var actions = document.getElementById("actions");
      var retry = document.getElementById("retry");
      var back = document.getElementById("back");
      var steps = Array.prototype.slice.call(document.querySelectorAll(".step"));
      var stopped = false;

      function setProgress(value, message) {
        var next = Math.max(0, Math.min(100, Number(value) || 0));
        progressBar.style.transform = "scaleX(" + (next / 100) + ")";
        progressTrack.setAttribute("aria-valuenow", String(next));
        percent.textContent = Math.round(next) + "%";
        status.textContent = message || "正在准备手机预览";
        steps.forEach(function (step) {
          var threshold = Number(step.dataset.threshold || 0);
          step.classList.toggle("is-done", next > threshold + 8);
          step.classList.toggle("is-active", next >= threshold && next <= threshold + 18);
        });
      }

      async function request(path, options) {
        var response = await fetch(path, options);
        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(payload.error || "部署请求失败，请稍后重试。");
        return payload;
      }

      function fail(message) {
        stopped = true;
        progressBar.classList.add("is-error");
        progressTrack.setAttribute("aria-valuetext", "部署失败");
        status.textContent = "部署没有完成";
        percent.textContent = "失败";
        steps.forEach(function (step) { step.classList.remove("is-active"); });
        error.textContent = message || "部署失败，请确认电脑上的页面仍可打开。";
        error.hidden = false;
        actions.hidden = false;
      }

      async function poll(jobId) {
        while (!stopped) {
          var payload = await request("/api/previews/jobs/" + encodeURIComponent(jobId));
          setProgress(payload.progress, payload.message);
          if (payload.status === "ready" && payload.readyUrl) {
            await new Promise(function (resolve) { setTimeout(resolve, 260); });
            location.replace(payload.readyUrl);
            return;
          }
          if (payload.status === "failed") {
            fail(payload.error);
            return;
          }
          await new Promise(function (resolve) { setTimeout(resolve, 420); });
        }
      }

      async function deploy() {
        stopped = false;
        progressBar.classList.remove("is-error");
        progressTrack.removeAttribute("aria-valuetext");
        error.hidden = true;
        actions.hidden = true;
        setProgress(4, "正在请求电脑准备最新内容");
        if (!target) {
          fail("缺少本地页面或文件地址，请返回任务后重新点击链接。");
          return;
        }
        try {
          var payload = await fetch("/api/previews/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: target })
          }).then(async function (response) {
            var body = await response.json().catch(function () { return {}; });
            if (!response.ok) throw new Error(body.error || "无法创建部署任务。");
            return body;
          });
          setProgress(payload.progress, payload.message);
          await poll(payload.jobId);
        } catch (requestError) {
          fail(requestError && requestError.message || "部署请求失败，请稍后重试。");
        }
      }

      retry.addEventListener("click", deploy);
      back.addEventListener("click", function () { location.href = "/"; });
      void deploy();
    })();
  </script>
</body>
</html>`;
}

export function createLocalPreviewViewerHtml(params: {
  nonce: string;
  deploymentId: string;
  entryPath: string;
  sourceLabel: string;
}): string {
  const safeHtmlNonce = escapeHtml(safeNonce(params.nonce));
  const contentPath = `/preview/content/${encodeURIComponent(params.deploymentId)}/${encodedPreviewPath(params.entryPath)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow">
  <meta name="theme-color" content="#ffffff">
  <title>${escapeHtml(params.sourceLabel)} · 手机预览</title>
  <style nonce="${safeHtmlNonce}">
    * { box-sizing:border-box; }
    html, body { width:100%; height:100%; margin:0; overflow:hidden; background:#fff; color:#17191d; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .viewer { width:100%; height:100%; display:grid; grid-template-rows:auto minmax(0,1fr); }
    .bar { min-height:40px; display:flex; align-items:center; gap:10px; padding:calc(7px + env(safe-area-inset-top)) 12px 7px; border-bottom:1px solid #e5e7eb; background:#fff; }
    .brand { font-weight:750; }
    .source { min-width:0; overflow:hidden; color:#6b7280; text-overflow:ellipsis; white-space:nowrap; }
    iframe { display:block; width:100%; height:100%; border:0; background:#fff; }
  </style>
</head>
<body>
  <main class="viewer">
    <header class="bar"><span class="brand">手机预览</span><span class="source">${escapeHtml(params.sourceLabel)}</span></header>
    <iframe src="${escapeHtml(contentPath)}" title="${escapeHtml(params.sourceLabel)}" sandbox="allow-scripts allow-downloads allow-popups allow-modals"></iframe>
  </main>
</body>
</html>`;
}
