/**
 * Playground memory / cache / context / KV / token observability panel.
 */
(function () {
  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fmtBytes(n) {
    const v = Number(n || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(2)} MB`;
    return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function money(n) {
    return `$${Number(n || 0).toFixed(4)}`;
  }

  async function api(path) {
    const res = await fetch(path);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  function renderSummary(data) {
    const box = el("memory-obs-summary");
    if (!box) return;
    const mem = data.memory?.stats || {};
    const cache = data.cache?.retrieval || {};
    const tokens = data.tokenUsage?.summary7d || {};
    const kvTotal = (data.kvCache?.runtimes || []).reduce(
      (s, r) => s + Number(r.kvResidentBytes || 0),
      0,
    );
    box.innerHTML = `
      <div class="routing-summary-card"><span>记忆块</span><strong>${mem.totalChunks ?? 0}</strong></div>
      <div class="routing-summary-card"><span>用户数</span><strong>${mem.userCount ?? 0}</strong></div>
      <div class="routing-summary-card"><span>检索缓存命中率</span><strong>${
        cache.hitRate == null ? (cache.enabled ? "—" : "未启用") : `${(cache.hitRate * 100).toFixed(1)}%`
      }</strong></div>
      <div class="routing-summary-card"><span>KV 常驻(估)</span><strong>${fmtBytes(kvTotal)}</strong></div>
      <div class="routing-summary-card"><span>Token(7d)</span><strong>${tokens.totalTokens ?? 0}</strong></div>
      <div class="routing-summary-card"><span>成本(7d)</span><strong>${money(tokens.totalCostUsd)}</strong></div>
    `;
  }

  function renderRecords(memory) {
    const statsEl = el("memory-obs-stats");
    const listEl = el("memory-obs-records");
    if (!statsEl || !listEl) return;
    const stats = memory?.stats || {};
    statsEl.innerHTML = memory?.inspectable
      ? `backend=<code>${escapeHtml(stats.backend)}</code> · 驱逐=${escapeHtml(
          stats.evictionPolicy || "n/a",
        )} · 上限/用户=${stats.maxChunksPerUser ?? "—"} · 总上限=${stats.maxTotalChunks ?? "—"}`
      : `<span class="is-warn">${escapeHtml(memory?.note || "不可 inspect")}</span>`;

    const records = memory?.records || [];
    if (!records.length) {
      listEl.innerHTML =
        '<div class="managed-empty">暂无记忆记录。可通过 <code>POST /v1/kgm/memory</code> 写入，或在对话路径自动召回后积累。</div>';
      return;
    }
    listEl.innerHTML = records
      .map((r) => {
        const preview = String(r.text || "").slice(0, 180);
        return `<article class="memory-record-card">
          <header><strong>${escapeHtml(r.id)}</strong>
            <span>${escapeHtml(r.userId)} · ${escapeHtml(r.source)}</span></header>
          <p>${escapeHtml(preview)}${String(r.text || "").length > 180 ? "…" : ""}</p>
          <footer>${escapeHtml(r.createdAt || "")}${
            r.lastAccessedAt ? ` · accessed ${escapeHtml(r.lastAccessedAt)}` : ""
          }</footer>
        </article>`;
      })
      .join("");
  }

  function renderCompression(modes) {
    const box = el("memory-obs-compression");
    if (!box) return;
    box.innerHTML = (modes || [])
      .map(
        (m) => `<div class="memory-obs-row">
        <strong>${escapeHtml(m.id)}</strong>
        <span class="sandbox-status ${m.available ? "running" : "stopped"}">${
          m.available ? "available" : "not wired"
        }</span>
        <p>${escapeHtml(m.description || "")}</p>
        ${m.maxEvidenceChars != null ? `<p class="helper-text">maxEvidenceChars=${m.maxEvidenceChars}</p>` : ""}
      </div>`,
      )
      .join("");
  }

  function renderCache(cache) {
    const box = el("memory-obs-cache");
    if (!box) return;
    const r = cache?.retrieval || {};
    const opt = cache?.responseOptimizer;
    box.innerHTML = `
      <div class="memory-obs-row">
        <strong>检索缓存 (ContextBuilder)</strong>
        <p>enabled=${r.enabled ? "yes" : "no"} · ttlMs=${r.ttlMs ?? 0} · entries=${r.entries ?? 0}</p>
        <p>hits=${r.hits ?? 0} · misses=${r.misses ?? 0} · hitRate=${
          r.hitRate == null ? "—" : (r.hitRate * 100).toFixed(1) + "%"
        }</p>
        <p class="helper-text">启用：配置 <code>context.retrievalCacheTtlMs &gt; 0</code></p>
      </div>
      <div class="memory-obs-row">
        <strong>响应缓存 (Optimizer)</strong>
        <p>${
          opt
            ? `size=${opt.currentSize ?? opt.size ?? "—"}/${opt.maxSize ?? "—"} · hits=${opt.hits ?? "—"} · misses=${opt.misses ?? "—"} · hitRate=${
                opt.hitRate != null ? `${(Number(opt.hitRate) * 100).toFixed(1)}%` : "—"
              }`
            : "未启用或无统计（见 GET /v1/kgm/optimize/stats）"
        }</p>
      </div>
      <p class="helper-text">${escapeHtml(cache?.note || "")}</p>
    `;
  }

  function renderContext(ctx) {
    const box = el("memory-obs-context");
    if (!box) return;
    const last = ctx?.lastBuildSummary;
    box.innerHTML = `
      <p>最近组装：<code>${escapeHtml(ctx?.lastBuildAt || "尚未构建")}</code></p>
      ${
        last
          ? `<ul>
        <li>evidence=${last.evidenceCount}</li>
        <li>signals=${last.signalCount}</li>
        <li>ycbEvidence=${last.ycbEvidenceCount}</li>
        <li>graphEnabled=${last.graphEnabled}</li>
        <li>budgetTruncated≈${last.budgetTruncated}</li>
      </ul>`
          : '<p class="helper-text">尚无动态上下文构建记录；发起带记忆召回的对话后会出现。</p>'
      }
      <p class="helper-text">预算：maxEvidenceChars=${ctx?.evidenceBudget?.maxEvidenceChars ?? "—"} · artifactPreview=${
        ctx?.evidenceBudget?.artifactPreviewChars ?? "—"
      }</p>
    `;
  }

  function renderKv(kv) {
    const box = el("memory-obs-kv");
    if (!box) return;
    const rows = kv?.runtimes || [];
    if (!rows.length) {
      box.innerHTML = `<div class="managed-empty">暂无 managed runtime。创建推理实例后可看到 KV 常驻字节与 prefix cacheHits。</div>
        <p class="helper-text">${escapeHtml(kv?.ds4Note || "")}</p>
        <p class="helper-text">Prometheus：${escapeHtml(kv?.prometheus || "")}</p>`;
      return;
    }
    box.innerHTML = `
      <table class="ops-table"><thead><tr>
        <th>Runtime</th><th>Kind</th><th>KV 常驻</th><th>cacheHits</th><th>hitRate</th><th>tok/s</th>
      </tr></thead><tbody>
      ${rows
        .map(
          (r) => `<tr>
          <td>${escapeHtml(r.modelName || r.id)}</td>
          <td>${escapeHtml(r.runtime)}</td>
          <td>${fmtBytes(r.kvResidentBytes)}</td>
          <td>${r.cacheHits}/${r.cacheMisses}</td>
          <td>${r.prefixCacheHitRate == null ? "—" : `${(r.prefixCacheHitRate * 100).toFixed(1)}%`}</td>
          <td>${Number(r.avgOutputTokensPerSecond || 0).toFixed(1)}</td>
        </tr>`,
        )
        .join("")}
      </tbody></table>
      <p class="helper-text">${escapeHtml(kv?.ds4Note || "")}</p>
    `;
  }

  function renderTokens(tokenUsage) {
    const box = el("memory-obs-tokens");
    if (!box) return;
    const s = tokenUsage?.summary7d;
    if (!s || s.available === false) {
      box.innerHTML =
        '<div class="managed-empty">用量账本暂不可用或为空。对话产生 usage 后会写入 ops SQLite（默认 data/kgm-ops.sqlite）。</div>';
      return;
    }
    const byModel = (s.byModel || []).slice(0, 8);
    box.innerHTML = `
      <div class="routing-summary-cards">
        <div class="routing-summary-card"><span>请求</span><strong>${s.totalRequests || 0}</strong></div>
        <div class="routing-summary-card"><span>Tokens</span><strong>${s.totalTokens || 0}</strong></div>
        <div class="routing-summary-card"><span>成本</span><strong>${money(s.totalCostUsd)}</strong></div>
        <div class="routing-summary-card"><span>成功率</span><strong>${((s.successRate || 0) * 100).toFixed(1)}%</strong></div>
      </div>
      ${
        byModel.length
          ? `<table class="ops-table"><thead><tr><th>模型</th><th>请求</th><th>Tokens</th><th>成本</th></tr></thead><tbody>${byModel
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.model)}</td><td>${r.requests}</td><td>${r.tokens}</td><td>${money(
                    r.costUsd,
                  )}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : ""
      }
    `;
  }

  async function refresh() {
    const userId = el("memory-obs-user-id")?.value?.trim() || "";
    const limit = el("memory-obs-limit")?.value || "40";
    const qs = new URLSearchParams();
    if (userId) qs.set("userId", userId);
    qs.set("limit", String(limit));
    const data = await api(`/v1/kgm/observability/context?${qs.toString()}`);
    renderSummary(data);
    renderRecords(data.memory);
    renderCompression(data.compression?.modes);
    renderCache(data.cache);
    renderContext(data.dynamicContext);
    renderKv(data.kvCache);
    renderTokens(data.tokenUsage);
    const updated = el("memory-obs-updated");
    if (updated) updated.textContent = `更新于 ${data.timestamp || new Date().toISOString()}`;
  }

  function wire() {
    el("memory-obs-refresh-btn")?.addEventListener("click", () => {
      refresh().catch((err) => window.alert(String(err.message || err)));
    });
    el("memory-obs-clear-retrieval-btn")?.addEventListener("click", () => {
      fetch("/v1/kgm/observability/retrieval-cache/clear", { method: "POST" })
        .then((r) => r.json())
        .then(() => refresh())
        .catch((err) => window.alert(String(err.message || err)));
    });
    el("memory-obs-goto-ops-btn")?.addEventListener("click", () => {
      if (window.kgmPlaygroundInstance?.switchWorkspace) {
        window.kgmPlaygroundInstance.switchWorkspace("ops");
      }
    });
    window.KGM_MEMORY_OBS = { refresh };
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
