/**
 * Playground tab: provider-scoped model id mappings.
 */
(function () {
  function el(id) {
    return document.getElementById(id);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || res.statusText;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  function parseAliases(raw) {
    return String(raw || "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function optionalNumber(id) {
    const raw = el(id)?.value?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  async function loadProviders() {
    const select = el("map-provider");
    if (!select) return;
    const current = select.value;
    let providers = [];
    try {
      const data = await api("/v1/admin/model-providers");
      providers = (data.providers || []).map((p) => p.type).filter(Boolean);
    } catch {
      providers = [];
    }
    const options = [...new Set(providers)];
    select.innerHTML = options.map((p) => `<option value="${p}">${p}</option>`).join("");
    if (current && options.includes(current)) select.value = current;
  }

  function render(items) {
    const list = el("map-list");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<p class=\"section-desc\">还没有映射。</p>";
      return;
    }
    list.innerHTML = items
      .map((item) => {
        const aliases = (item.aliases || []).join(", ") || "（无额外 ID）";
        const price = [item.inputUsdPerMillion, item.outputUsdPerMillion].some((n) => n != null)
          ? `报价 ${item.inputUsdPerMillion ?? "-"} / ${item.outputUsdPerMillion ?? "-"}`
          : "";
        const perf = [
          item.contextTokens != null ? `上下文 ${item.contextTokens}` : "",
          item.latencyMsP50 != null ? `P50 ${item.latencyMsP50}ms` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<div class="managed-row">
          <div><strong>${item.provider}</strong> · ${item.canonicalModelId}</div>
          <div>${aliases}</div>
          <div>${[price, perf].filter(Boolean).join(" · ")}</div>
          <div class="managed-actions"><button type="button" data-delete-mapping="${item.id}">删除</button></div>
        </div>`;
      })
      .join("");
  }

  async function refresh() {
    await loadProviders();
    const data = await api("/v1/admin/model-mappings");
    render(data.items || []);
  }

  async function save() {
    const provider = el("map-provider")?.value?.trim();
    const canonicalModelId = el("map-canonical")?.value?.trim();
    await api("/v1/admin/model-mappings", {
      method: "POST",
      body: JSON.stringify({
        provider,
        canonicalModelId,
        aliases: parseAliases(el("map-aliases")?.value),
        inputUsdPerMillion: optionalNumber("map-input-price"),
        outputUsdPerMillion: optionalNumber("map-output-price"),
        contextTokens: optionalNumber("map-context"),
        latencyMsP50: optionalNumber("map-latency"),
      }),
    });
    if (el("map-canonical")) el("map-canonical").value = "";
    if (el("map-aliases")) el("map-aliases").value = "";
    await refresh();
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "map-save-btn") {
      try {
        await save();
      } catch (error) {
        alert(error.message || String(error));
      }
    }
    const id = target.dataset.deleteMapping;
    if (id) {
      try {
        await api(`/v1/admin/model-mappings/${encodeURIComponent(id)}`, { method: "DELETE" });
        await refresh();
      } catch (error) {
        alert(error.message || String(error));
      }
    }
  });

  window.KgmModelMapping = { refresh };
})();
