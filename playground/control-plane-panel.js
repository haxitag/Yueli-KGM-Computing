/**
 * P0–P2 effective control-plane status. Process env values are read-only and
 * explicitly marked as restart-required; ConfigStore links open writable forms.
 */
(function () {
  let cached = null;

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

  function chip(label, tone = "") {
    return `<span class="control-plane-chip ${tone ? `control-plane-chip--${tone}` : ""}">${escapeHtml(label)}</span>`;
  }

  function valueOf(setting) {
    return setting && typeof setting === "object" && "value" in setting ? setting.value : setting;
  }

  function row(label, value, meta) {
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value ?? "—");
    return `<div class="control-plane-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(rendered)}</strong>${
      meta ? `<small>${escapeHtml(meta)}</small>` : ""
    }</div>`;
  }

  function render(data) {
    const cfg = data.config || {};
    const chat = el("chat-server-default-status");
    if (chat) {
      chat.innerHTML = [
        row("LLM", `${cfg.llm?.provider || "—"} · ${cfg.llm?.model || "—"}`, "ConfigStore · 即时"),
        row("Embedding", `${cfg.embedding?.provider || "—"} · ${cfg.embedding?.model || "—"}`, "ConfigStore · 即时"),
        row("Stream idle", `${valueOf(data.resilience?.streamIdleMs) || 0} ms`, "env/default · 重启"),
      ].join("");
    }

    const memory = el("memory-config-status");
    if (memory) {
      const vectorBackend = cfg.vector?.backend || "—";
      const dbActive = vectorBackend === "chroma";
      memory.innerHTML = [
        row(
          "Database",
          cfg.database?.provider || "—",
          dbActive
            ? "chroma 路径 · 后端变更需重启"
            : "vector=memory 时忽略（InMemoryStore）",
        ),
        row("Vector", vectorBackend, "仅 chroma 创建 Hybrid · 变更需重启"),
        row(
          "PG 高级",
          cfg.database?.provider === "postgresql"
            ? `ssl=${Boolean(cfg.database?.ssl)} · max=${cfg.database?.maxConnections ?? "—"} · idle=${cfg.database?.idleTimeout ?? "—"} · conn=${cfg.database?.connectionTimeout ?? "—"}`
            : "—",
          dbActive ? "重启后生效" : "当前不生效",
        ),
        row("Retrieval TTL", `${cfg.context?.retrievalCacheTtlMs || 0} ms`, "即时"),
      ].join("");
    }

    const front = el("integration-frontstation-status");
    if (front) {
      const f = data.frontstation || {};
      front.innerHTML = [
        row("Mode", valueOf(f.mode), "env/default · 重启"),
        row("Intent / Rerank / Summary", `${valueOf(f.intentMode)} / ${valueOf(f.rerankMode)} / ${valueOf(f.summaryMode)}`),
        row("ONNX", `${valueOf(f.preferOnnx) ? "prefer" : "disabled"} · ${valueOf(f.onnxModelId)}`),
        row("HTTP workers", `intent ${f.intentHttpConfigured ? "on" : "off"} · rerank ${f.rerankHttpConfigured ? "on" : "off"} · summary ${f.summaryHttpConfigured ? "on" : "off"}`),
      ].join("");
    }

    const resilience = el("routing-resilience-status");
    if (resilience) {
      const r = data.resilience || {};
      const cb = r.circuitBreaker || {};
      const live = cb.liveStates && Object.keys(cb.liveStates).length
        ? Object.entries(cb.liveStates)
            .map(([host, state]) => `${host}=${state}`)
            .join(", ")
        : "暂无上游熔断桶";
      resilience.innerHTML = [
        row("权重", valueOf(r.autoRoutingWeights), "ConfigStore · 可热更新"),
        row("Circuit", `timeout ${valueOf(cb.timeoutMs)} ms · threshold ${valueOf(cb.errorThreshold)} · reset ${valueOf(cb.resetTimeoutMs)} ms`, "env/default · 重启"),
        row("Live states", live, "opossum 按 host 分桶"),
        row("Stream idle", `${valueOf(r.streamIdleMs) || 0} ms`, "0=关闭 · 重启"),
        row(
          "Agentic 计数",
          (() => {
            const a = valueOf(r.agentic);
            if (!a || typeof a !== "object") return "—";
            return `reqs=${a.requestsTotal ?? 0} · coding=${a.codingRequests ?? 0} · toolHeavy=${a.toolHeavyRequests ?? 0} · nativeTC=${a.nativeToolCallsRequests ?? 0} · avgRounds=${Number(a.avgRounds ?? 0).toFixed(2)} · lastTTFT=${a.lastFirstTokenMs ?? "—"}ms`;
          })(),
          "进程内快照 · 非 Prometheus SLA · 见 docs/worker-provider-session-tools-slo-eval-audit.md",
        ),
      ].join("");
    }

    const security = el("ops-security-status");
    if (security) {
      const s = data.security || {};
      const mode = valueOf(s.mode);
      security.innerHTML = [
        `<div class="control-plane-chips">${chip(mode, mode === "strict" ? "ok" : "warn")}${chip(s.masterKeyConfigured ? "Master 已配置" : "Master 未配置", s.masterKeyConfigured ? "ok" : "warn")}</div>`,
        row("Rate limit", valueOf(s.rateLimit) || "off", "每身份滑动窗口"),
        row("Trust proxy", valueOf(s.trustProxy), "仅可信反向代理后启用"),
        row("Exempt", (valueOf(s.exemptPathPrefixes) || []).join(", ")),
      ].join("");
    }

    const platform = el("ops-platform-status");
    if (platform) {
      const p = data.platform || {};
      platform.innerHTML = [
        row("Native backend", valueOf(p.native?.servingBackend), p.native?.nativeCoreConfigured ? "native-core configured" : "native-core 未配置"),
        row("GPU simulated", valueOf(p.native?.gpuSimulated), "仅标记模拟，不代表生产 GPU"),
        row("CORS", p.cors?.value, `${p.cors?.source || "default"} · 重启`),
        row("Discovery", `${valueOf(p.discovery?.enabled) ? "on" : "off"} · ports ${(valueOf(p.discovery?.ports) || []).join(",")}`, "重启"),
      ].join("");
    }
  }

  async function refresh() {
    const [statusRes, configRes] = await Promise.all([
      fetch("/v1/kgm/ops/config-status"),
      fetch("/v1/kgm/config"),
    ]);
    if (!statusRes.ok) throw new Error(`config status ${statusRes.status}`);
    if (!configRes.ok) throw new Error(`config ${configRes.status}`);
    cached = { ...(await statusRes.json()), config: await configRes.json() };
    render(cached);
    return cached;
  }

  function bind() {
    document.querySelectorAll("[data-config-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.configTarget;
        window.dispatchEvent(
          new CustomEvent("kgm-switch-workspace", { detail: { workspace: "config" } }),
        );
        window.setTimeout(() => {
          document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 50);
      });
    });
  }

  window.KGM_CONTROL_PLANE = { refresh };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bind();
      refresh().catch(() => {});
    });
  } else {
    bind();
    refresh().catch(() => {});
  }
})();
