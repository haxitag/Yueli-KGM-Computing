/**
 * Playground P0 服务端配置：默认 LLM/Embedding → 记忆后端/TTL → Worker 门闩 → 沙箱 adapter。
 * 读写 /v1/kgm/config；密钥留空表示不改写。
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

  function setStatus(text, isError) {
    const box = el("kgm-config-status");
    if (!box) return;
    box.textContent = text || "";
    box.classList.toggle("is-warn", Boolean(isError));
  }

  function val(id) {
    const node = el(id);
    return node ? String(node.value ?? "").trim() : "";
  }

  function num(id, fallback) {
    const raw = val(id);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function setInput(id, value) {
    const node = el(id);
    if (!node) return;
    if (node.type === "checkbox") {
      node.checked = Boolean(value);
      return;
    }
    node.value = value == null ? "" : String(value);
  }

  function embeddedSelectValue(v) {
    if (v === true) return "true";
    if (v === false) return "false";
    return "env";
  }

  function parseEmbeddedSelect(id) {
    const v = val(id);
    if (v === "true") return true;
    if (v === "false") return false;
    return undefined;
  }

  function fillForm(cfg) {
    const llm = cfg.llm || {};
    setInput("cfg-llm-provider", llm.provider || "openai");
    setInput("cfg-llm-base-url", llm.baseUrl || "");
    setInput("cfg-llm-model", llm.model || "");
    setInput("cfg-llm-path", llm.path || "");
    setInput("cfg-llm-mode", llm.mode || "completions");
    setInput("cfg-llm-temperature", llm.temperature ?? 0.2);
    setInput("cfg-llm-max-tokens", llm.maxTokens ?? 512);
    setInput("cfg-llm-timeout", llm.timeoutMs ?? 30000);
    setInput("cfg-llm-api-key", "");
    const llmHint = el("cfg-llm-api-key-hint");
    if (llmHint) llmHint.textContent = llm.apiKeyConfigured ? "已设置 · 不回显" : "未设置";

    const emb = cfg.embedding || {};
    setInput("cfg-emb-provider", emb.provider || "openai");
    setInput("cfg-emb-base-url", emb.baseUrl || "");
    setInput("cfg-emb-model", emb.model || "");
    setInput("cfg-emb-path", emb.path || "");
    setInput("cfg-emb-version", emb.version || "");
    setInput("cfg-emb-timeout", emb.timeoutMs ?? 15000);
    setInput("cfg-emb-api-key", "");
    const embHint = el("cfg-emb-api-key-hint");
    if (embHint) embHint.textContent = emb.apiKeyConfigured ? "已设置 · 不回显" : "未设置";

    const db = cfg.database || {};
    setInput("cfg-db-provider", db.provider || "sqlite");
    setInput("cfg-db-file", db.filePath || "");
    setInput("cfg-db-journal", db.journalMode || "WAL");
    setInput("cfg-db-host", db.host || "");
    setInput("cfg-db-port", db.port ?? "");
    setInput("cfg-db-name", db.database || "");
    setInput("cfg-db-user", db.username || "");
    setInput("cfg-db-password", "");
    setInput("cfg-db-ssl", db.ssl ? "true" : "false");
    setInput("cfg-db-max-conn", db.maxConnections ?? "");
    setInput("cfg-db-idle-timeout", db.idleTimeout ?? "");
    setInput("cfg-db-conn-timeout", db.connectionTimeout ?? "");
    const dbHint = el("cfg-db-password-hint");
    if (dbHint) dbHint.textContent = db.passwordConfigured ? "已设置 · 不回显" : "未设置";

    const vector = cfg.vector || {};
    setInput("cfg-vector-backend", vector.backend || "memory");
    setInput("cfg-vector-url", vector.baseUrl || "");
    setInput("cfg-vector-path", vector.apiPath || "");
    setInput("cfg-vector-collection", vector.collection || "");
    setInput("cfg-vector-distance", vector.distance || "cosine");
    setInput("cfg-vector-timeout", vector.timeoutMs ?? 15000);

    const ctx = cfg.context || {};
    setInput("cfg-retrieval-ttl", ctx.retrievalCacheTtlMs ?? 0);

    syncMemoryFormState();

    const llama = cfg.workers?.llamaCpp || {};
    setInput("cfg-llama-enabled", llama.enabled || "auto");
    setInput("cfg-llama-command", llama.command || "");
    setInput("cfg-llama-hint", llama.installHint || "");

    const ds4 = cfg.workers?.ds4 || {};
    setInput("cfg-ds4-enabled", ds4.enabled || "auto");
    setInput("cfg-ds4-command", ds4.command || "");
    setInput("cfg-ds4-chdir", ds4.chdir || "");
    setInput("cfg-ds4-hint", ds4.installHint || "");

    const tokenspeed = cfg.workers?.tokenspeed || {};
    setInput("cfg-tokenspeed-enabled", tokenspeed.enabled || "off");
    setInput("cfg-tokenspeed-base-url", tokenspeed.baseUrl || "");
    setInput("cfg-tokenspeed-command", tokenspeed.command || "");
    setInput("cfg-tokenspeed-port", tokenspeed.port ?? 8095);
    setInput("cfg-tokenspeed-tool-parser", tokenspeed.toolCallParser || "");
    setInput("cfg-tokenspeed-reasoning-parser", tokenspeed.reasoningParser || "");
    setInput(
      "cfg-tokenspeed-prefix-cache",
      tokenspeed.enablePrefixCaching === true ? "true" : tokenspeed.enablePrefixCaching === false ? "false" : "",
    );
    setInput("cfg-tokenspeed-hint", tokenspeed.installHint || "");

    for (const kind of ["computer", "browser", "mobile"]) {
      const a = cfg.sandboxAdapters?.[kind] || {};
      setInput(`cfg-sbx-${kind}-embedded`, embeddedSelectValue(a.useEmbedded));
      setInput(`cfg-sbx-${kind}-start`, a.startCommand || "");
      setInput(`cfg-sbx-${kind}-stop`, a.stopCommand || "");
      setInput(`cfg-sbx-${kind}-status`, a.statusCommand || "");
      setInput(`cfg-sbx-${kind}-endpoint`, a.endpoint || "");
    }
  }

  async function api(path, options) {
    const res = await fetch(path, options);
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

  async function loadConfig() {
    setStatus("加载中…");
    try {
      const cfg = await api("/v1/kgm/config");
      fillForm(cfg);
      await refreshAdapterStatus();
      setStatus(`已加载 · ${new Date().toLocaleTimeString()}`);
      return cfg;
    } catch (err) {
      setStatus(`加载失败：${err.message}`, true);
      throw err;
    }
  }

  function syncMemoryFormState() {
    const vectorBackend = val("cfg-vector-backend") || "memory";
    const dbProvider = val("cfg-db-provider") || "sqlite";
    const dbInactive = vectorBackend !== "chroma";
    const note = el("cfg-memory-backend-note");
    if (note) {
      note.hidden = !dbInactive;
      note.textContent = dbInactive
        ? "当前 vector.backend=memory：进程使用 InMemoryStore，下方 Database 配置会被忽略。仅 chroma 时才会按 database+vector 创建 Hybrid Memory。"
        : "";
    }
    const dbFieldset = el("cfg-db-fieldset");
    if (dbFieldset) {
      dbFieldset.classList.toggle("is-inactive", dbInactive);
    }
    const sqliteFields = el("cfg-db-sqlite-fields");
    const pgFields = el("cfg-db-pg-fields");
    const pgAdvanced = el("cfg-db-pg-advanced");
    if (sqliteFields) sqliteFields.hidden = dbProvider !== "sqlite";
    if (pgFields) pgFields.hidden = dbProvider !== "postgresql";
    if (pgAdvanced) pgAdvanced.hidden = dbProvider !== "postgresql";
  }

  async function refreshAdapterStatus() {
    const box = el("cfg-sandbox-status");
    if (!box) return;
    try {
      const data = await api("/v1/kgm/sandboxes/adapters");
      const adapters = data.adapters || [];
      if (!adapters.length) {
        box.innerHTML = '<p class="helper-text">无 adapter 状态</p>';
        return;
      }
      box.innerHTML = adapters
        .map((a) => {
          const tone = a.configured ? "ok" : "warn";
          return `<div class="memory-obs-row">
            <strong>${escapeHtml(a.kind)}</strong>
            <span class="cfg-adapter-pill cfg-adapter-pill--${tone}">${
              a.configured ? "configured" : "unconfigured"
            }</span>
            <div class="helper-text">${escapeHtml(a.label)} · ${escapeHtml(a.hint)}</div>
          </div>`;
        })
        .join("");
    } catch (err) {
      box.innerHTML = `<p class="helper-text is-warn">${escapeHtml(err.message)}</p>`;
    }
  }

  function buildSandboxKindPatch(kind) {
    const patch = {
      startCommand: val(`cfg-sbx-${kind}-start`),
      stopCommand: val(`cfg-sbx-${kind}-stop`),
      statusCommand: val(`cfg-sbx-${kind}-status`),
      endpoint: val(`cfg-sbx-${kind}-endpoint`),
      useEmbedded: null,
    };
    const emb = parseEmbeddedSelect(`cfg-sbx-${kind}-embedded`);
    if (typeof emb === "boolean") {
      patch.useEmbedded = emb;
    }
    return patch;
  }

  function buildPatch() {
    const patch = {
      llm: {
        provider: val("cfg-llm-provider") || "openai",
        baseUrl: val("cfg-llm-base-url"),
        model: val("cfg-llm-model"),
        path: val("cfg-llm-path") || "/completions",
        mode: val("cfg-llm-mode") || "completions",
        temperature: num("cfg-llm-temperature", 0.2),
        maxTokens: num("cfg-llm-max-tokens", 512),
        timeoutMs: num("cfg-llm-timeout", 30000),
      },
      embedding: {
        provider: val("cfg-emb-provider") || "openai",
        baseUrl: val("cfg-emb-base-url"),
        model: val("cfg-emb-model"),
        path: val("cfg-emb-path") || "/embeddings",
        version: val("cfg-emb-version"),
        timeoutMs: num("cfg-emb-timeout", 15000),
      },
      database: {
        provider: val("cfg-db-provider") || "sqlite",
        filePath: val("cfg-db-file") || undefined,
        journalMode: val("cfg-db-journal") || undefined,
        host: val("cfg-db-host") || undefined,
        port: val("cfg-db-port") ? num("cfg-db-port") : undefined,
        database: val("cfg-db-name") || undefined,
        username: val("cfg-db-user") || undefined,
        ssl: val("cfg-db-ssl") === "true",
        maxConnections: val("cfg-db-max-conn") ? num("cfg-db-max-conn") : undefined,
        idleTimeout: val("cfg-db-idle-timeout") ? num("cfg-db-idle-timeout") : undefined,
        connectionTimeout: val("cfg-db-conn-timeout") ? num("cfg-db-conn-timeout") : undefined,
      },
      vector: {
        backend: val("cfg-vector-backend") || "memory",
        baseUrl: val("cfg-vector-url") || undefined,
        apiPath: val("cfg-vector-path") || undefined,
        collection: val("cfg-vector-collection") || undefined,
        distance: val("cfg-vector-distance") || undefined,
        timeoutMs: num("cfg-vector-timeout", 15000),
      },
      context: {
        retrievalCacheTtlMs: num("cfg-retrieval-ttl", 0),
      },
      workers: {
        llamaCpp: {
          enabled: val("cfg-llama-enabled") || "auto",
          command: val("cfg-llama-command") || "llama-server",
          installHint: val("cfg-llama-hint") || undefined,
        },
        ds4: {
          enabled: val("cfg-ds4-enabled") || "auto",
          command: val("cfg-ds4-command") || "ds4-server",
          chdir: val("cfg-ds4-chdir") || undefined,
          installHint: val("cfg-ds4-hint") || undefined,
        },
        tokenspeed: {
          enabled: val("cfg-tokenspeed-enabled") || "off",
          command: val("cfg-tokenspeed-command") || "tokenspeed",
          baseUrl: val("cfg-tokenspeed-base-url") || undefined,
          port: Number(val("cfg-tokenspeed-port")) || 8095,
          toolCallParser: val("cfg-tokenspeed-tool-parser") || undefined,
          reasoningParser: val("cfg-tokenspeed-reasoning-parser") || undefined,
          enablePrefixCaching: (() => {
            const raw = val("cfg-tokenspeed-prefix-cache");
            if (raw === "true") return true;
            if (raw === "false") return false;
            return undefined;
          })(),
          installHint: val("cfg-tokenspeed-hint") || undefined,
        },
      },
      sandboxAdapters: {
        computer: buildSandboxKindPatch("computer"),
        browser: buildSandboxKindPatch("browser"),
        mobile: buildSandboxKindPatch("mobile"),
      },
    };

    const llmKey = val("cfg-llm-api-key");
    if (llmKey) patch.llm.apiKey = llmKey;
    const embKey = val("cfg-emb-api-key");
    if (embKey) patch.embedding.apiKey = embKey;
    const dbPass = val("cfg-db-password");
    if (dbPass) patch.database.password = dbPass;

    return patch;
  }

  async function saveConfig() {
    setStatus("保存中…");
    try {
      const patch = buildPatch();
      const updated = await api("/v1/kgm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      fillForm(updated);
      await refreshAdapterStatus();
      if (window.KGM_CONTROL_PLANE?.refresh) {
        await window.KGM_CONTROL_PLANE.refresh().catch(() => {});
      }
      const vectorBackend = updated?.vector?.backend || patch.vector?.backend;
      const memoryNote =
        vectorBackend === "memory"
          ? "（当前 memory 向量后端：Database 配置不参与建库）"
          : "；数据库/向量后端需重启进程才重建 MemoryStore";
      setStatus(
        `已保存 · LLM/Embedding/TTL/Worker 即时生效${memoryNote} · ${new Date().toLocaleTimeString()}`,
      );
    } catch (err) {
      setStatus(`保存失败：${err.message}`, true);
    }
  }

  function bind() {
    el("kgm-config-reload-btn")?.addEventListener("click", () => {
      loadConfig().catch(() => {});
    });
    el("kgm-config-save-btn")?.addEventListener("click", () => {
      saveConfig().catch(() => {});
    });
    el("kgm-config-refresh-adapters-btn")?.addEventListener("click", () => {
      refreshAdapterStatus().catch(() => {});
    });
    el("cfg-vector-backend")?.addEventListener("change", syncMemoryFormState);
    el("cfg-db-provider")?.addEventListener("change", syncMemoryFormState);
  }

  window.KGM_CONFIG_PANEL = {
    refresh: loadConfig,
    refreshAdapters: refreshAdapterStatus,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
