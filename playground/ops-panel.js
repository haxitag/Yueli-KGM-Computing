/**
 * KGM Playground Ops panel — usage / virtual keys / budgets / aliases.
 * Depends on playground page DOM; uses same-origin /v1/kgm/* APIs.
 */
(function () {
  function requestHeaders(extra = {}) {
    // Master key is injected by auth-fetch.js (sessionStorage). Do not re-read
    // long-lived localStorage copies that previously duplicated Keys 管理钥.
    return { "content-type": "application/json", ...extra };
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: requestHeaders(options.headers || {}),
    });
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

  function el(id) {
    return document.getElementById(id);
  }

  function money(n) {
    return `$${Number(n || 0).toFixed(4)}`;
  }

  function renderSummary(summary) {
    const box = el("ops-usage-summary");
    if (!box || !summary) return;
    box.innerHTML = `
      <div class="routing-summary-card"><span>请求</span><strong>${summary.totalRequests || 0}</strong></div>
      <div class="routing-summary-card"><span>成功率</span><strong>${((summary.successRate || 0) * 100).toFixed(1)}%</strong></div>
      <div class="routing-summary-card"><span>Tokens</span><strong>${summary.totalTokens || 0}</strong></div>
      <div class="routing-summary-card"><span>成本</span><strong>${money(summary.totalCostUsd)}</strong></div>
      <div class="routing-summary-card"><span>均延迟</span><strong>${Math.round(summary.avgLatencyMs || 0)} ms</strong></div>
    `;
    const byModel = el("ops-usage-by-model");
    if (byModel) {
      const rows = (summary.byModel || []).slice(0, 12);
      byModel.innerHTML = rows.length
        ? `<table class="ops-table"><thead><tr><th>模型</th><th>请求</th><th>Tokens</th><th>成本</th></tr></thead><tbody>${rows
            .map(
              (r) =>
                `<tr><td>${escapeHtml(r.model)}</td><td>${r.requests}</td><td>${r.tokens}</td><td>${money(r.costUsd)}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : '<div class="managed-empty">暂无用量。</div>';
    }
    const byDay = el("ops-usage-by-day");
    if (byDay) {
      const days = summary.byDay || [];
      const max = Math.max(1, ...days.map((d) => d.costUsd || 0));
      byDay.innerHTML = days.length
        ? days
            .map((d) => {
              const pct = Math.round(((d.costUsd || 0) / max) * 100);
              return `<div class="ops-bar-row"><span>${escapeHtml(d.day)}</span><div class="ops-bar"><i style="width:${pct}%"></i></div><span>${money(d.costUsd)}</span></div>`;
            })
            .join("")
        : "";
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function loadUsage() {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [summary, list] = await Promise.all([
      api(`/v1/kgm/usage/summary?since=${encodeURIComponent(since)}`),
      api(`/v1/kgm/usage?limit=50&since=${encodeURIComponent(since)}`),
    ]);
    renderSummary(summary);
    const listEl = el("ops-usage-list");
    if (listEl) {
      const items = list.items || [];
      listEl.innerHTML = items.length
        ? items
            .map(
              (item) => `<div class="routing-audit-item">
            <div class="routing-audit-header"><strong>${escapeHtml(item.model)}</strong><span>${escapeHtml(item.timestamp)}</span></div>
            <span>key: ${escapeHtml(item.keyName || item.keyId)} · ${item.success ? "ok" : "fail"} · ${Math.round(item.latencyMs || 0)} ms</span>
            <span>tokens ${item.totalTokens || 0} · cost ${money(item.costUsd)} · ${escapeHtml(item.profile || "")} / ${escapeHtml(item.taskType || "")}</span>
          </div>`,
            )
            .join("")
        : '<div class="managed-empty">暂无请求记录。完成推理后会出现在此。</div>';
    }
  }

  async function loadKeys() {
    const data = await api("/v1/kgm/keys");
    const list = el("ops-key-list");
    if (!list) return;
    const items = data.items || [];
    list.innerHTML = items.length
      ? items
          .map(
            (k) => `<div class="managed-item">
          <div><strong>${escapeHtml(k.name)}</strong> · …${escapeHtml(k.keySuffix)} · ${k.enabled ? "active" : "revoked"}</div>
          <div class="managed-meta">${escapeHtml(k.id)} · models: ${(k.allowedModels || []).join(", ") || "*"}</div>
          <div class="managed-actions">
            <button type="button" data-revoke-key="${escapeHtml(k.id)}" ${k.enabled ? "" : "disabled"}>吊销</button>
            <button type="button" data-delete-key="${escapeHtml(k.id)}">删除</button>
          </div>
        </div>`,
          )
          .join("")
      : '<div class="managed-empty">尚无调用钥。</div>';
  }

  async function loadBudgets() {
    const data = await api("/v1/kgm/budgets");
    const list = el("ops-budget-list");
    if (!list) return;
    const items = data.items || [];
    list.innerHTML = items.length
      ? items
          .map((b) => {
            const st = b.status;
            return `<div class="managed-item">
            <div><strong>${escapeHtml(b.name)}</strong> · ${escapeHtml(b.period)} · ${escapeHtml(b.mode)} · cap ${money(b.limitUsd)}</div>
            <div class="managed-meta">key ${escapeHtml(b.keyId)} · spent ${money(st?.spentUsd)} · left ${money(st?.remainingUsd)} ${st?.exceeded ? "· EXCEEDED" : ""}</div>
            <div class="managed-actions"><button type="button" data-delete-budget="${escapeHtml(b.id)}">删除</button></div>
          </div>`;
          })
          .join("")
      : '<div class="managed-empty">尚无预算。</div>';
  }

  async function loadAliases() {
    const data = await api("/v1/kgm/aliases");
    const list = el("ops-alias-list");
    if (!list) return;
    const items = data.items || [];
    list.innerHTML = items.length
      ? items
          .map(
            (a) => `<div class="managed-item">
          <div><strong>${escapeHtml(a.alias)}</strong> → ${escapeHtml(a.model)}${a.provider ? ` @ ${escapeHtml(a.provider)}` : ""}</div>
          <div class="managed-meta">${escapeHtml(a.id)}${a.runtimeId ? ` · runtime ${escapeHtml(a.runtimeId)}` : ""}</div>
          <div class="managed-actions"><button type="button" data-delete-alias="${escapeHtml(a.id)}">删除</button></div>
        </div>`,
          )
          .join("")
      : '<div class="managed-empty">尚无别名。</div>';
  }

  async function refreshAll() {
    const tab = document.querySelector(".nav-ops.active")?.dataset?.opsTab || "usage";
    if (tab === "usage") await loadUsage();
    else if (tab === "keys") await loadKeys();
    else if (tab === "budgets") await loadBudgets();
    else if (tab === "aliases") await loadAliases();
  }

  function switchOpsTab(name) {
    document.querySelectorAll(".nav-ops").forEach((btn) => {
      const on = btn.dataset.opsTab === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["usage", "keys", "budgets", "aliases"].forEach((id) => {
      const panel = el(`ops-panel-${id}`);
      if (panel) panel.hidden = id !== name;
    });
    refreshAll().catch((err) => console.warn(err));
  }

  function bind() {
    const subnav = el("ops-subnav");
    subnav?.querySelectorAll(".nav-ops").forEach((btn) => {
      btn.addEventListener("click", () => switchOpsTab(btn.dataset.opsTab));
    });
    el("ops-refresh-btn")?.addEventListener("click", () => {
      refreshAll().catch((err) => alert(err.message));
    });
    el("ops-key-create-btn")?.addEventListener("click", async () => {
      try {
        const name = el("ops-key-name")?.value?.trim();
        if (!name) throw new Error("请填写名称");
        const modelsRaw = el("ops-key-models")?.value?.trim() || "";
        const allowedModels = modelsRaw
          ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const created = await api("/v1/kgm/keys", {
          method: "POST",
          body: JSON.stringify({
            name,
            allowedModels,
            notes: el("ops-key-notes")?.value?.trim() || undefined,
          }),
        });
        const once = el("ops-key-once");
        if (once) {
          once.hidden = false;
          once.textContent = `调用钥（仅此一次）:\n${created.apiKey}`;
        }
        await loadKeys();
      } catch (err) {
        alert(err.message);
      }
    });
    el("ops-budget-save-btn")?.addEventListener("click", async () => {
      try {
        await api("/v1/kgm/budgets", {
          method: "POST",
          body: JSON.stringify({
            keyId: el("ops-budget-key")?.value?.trim(),
            name: el("ops-budget-name")?.value?.trim(),
            period: el("ops-budget-period")?.value,
            limitUsd: Number(el("ops-budget-limit")?.value || 0),
            mode: el("ops-budget-mode")?.value,
          }),
        });
        await loadBudgets();
      } catch (err) {
        alert(err.message);
      }
    });
    el("ops-alias-save-btn")?.addEventListener("click", async () => {
      try {
        await api("/v1/kgm/aliases", {
          method: "POST",
          body: JSON.stringify({
            alias: el("ops-alias-name")?.value?.trim(),
            model: el("ops-alias-model")?.value?.trim(),
            provider: el("ops-alias-provider")?.value?.trim() || undefined,
            runtimeId: el("ops-alias-runtime")?.value?.trim() || undefined,
          }),
        });
        await loadAliases();
      } catch (err) {
        alert(err.message);
      }
    });
    document.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      try {
        if (t.dataset.revokeKey) {
          await api(`/v1/kgm/keys/${t.dataset.revokeKey}/revoke`, { method: "POST", body: "{}" });
          await loadKeys();
        }
        if (t.dataset.deleteKey) {
          await api(`/v1/kgm/keys/${t.dataset.deleteKey}`, { method: "DELETE" });
          await loadKeys();
        }
        if (t.dataset.deleteBudget) {
          await api(`/v1/kgm/budgets/${t.dataset.deleteBudget}`, { method: "DELETE" });
          await loadBudgets();
        }
        if (t.dataset.deleteAlias) {
          await api(`/v1/kgm/aliases/${t.dataset.deleteAlias}`, { method: "DELETE" });
          await loadAliases();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    el("goto-ops-usage-btn")?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("kgm-switch-workspace", { detail: { workspace: "ops", opsTab: "usage" } }));
    });
    window.addEventListener("kgm-ops-activate", (ev) => {
      const tab = ev.detail?.opsTab || "usage";
      switchOpsTab(tab);
    });
  }

  window.KgmOpsPanel = { refreshAll, switchOpsTab, bind };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
