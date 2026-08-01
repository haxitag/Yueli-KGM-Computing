/**
 * Sandbox Control 独立页：与主 Playground 首页解耦。
 */
(function () {
    const listEl = document.getElementById('sandbox-list');
    const kindSelect = document.getElementById('sandbox-kind-select');
    const createBtn = document.getElementById('create-sandbox-btn');
    const refreshBtn = document.getElementById('refresh-sandbox-btn');
    const adapterStatusEl = document.getElementById('sandbox-adapter-status');
    const refreshAdaptersBtn = document.getElementById('refresh-adapters-btn');

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    function showError(message) {
        window.alert(message);
    }

    function renderAdapters(adapters) {
        if (!adapterStatusEl) {
            return;
        }
        if (!adapters?.length) {
            adapterStatusEl.innerHTML = '<p class="helper-text">无 adapter 状态</p>';
            return;
        }
        adapterStatusEl.innerHTML = adapters
            .map((a) => {
                const tone = a.configured ? 'ok' : 'warn';
                return `<div class="memory-obs-row">
                    <strong>${escapeHtml(a.kind)}</strong>
                    <span class="cfg-adapter-pill cfg-adapter-pill--${tone}">${
                      a.configured ? 'configured' : 'unconfigured'
                    }</span>
                    <div class="helper-text">${escapeHtml(a.label)} · ${escapeHtml(a.hint)}</div>
                </div>`;
            })
            .join('');
    }

    async function loadAdapters() {
        if (!adapterStatusEl) {
            return;
        }
        try {
            const response = await fetch('/v1/kgm/sandboxes/adapters');
            if (!response.ok) {
                throw new Error(`adapter status ${response.status}`);
            }
            const payload = await response.json();
            renderAdapters(payload.adapters || []);
        } catch (error) {
            adapterStatusEl.innerHTML = `<p class="helper-text is-warn">${escapeHtml(error.message)}</p>`;
        }
    }

    async function loadSandboxes() {
        try {
            const response = await fetch('/v1/kgm/sandboxes');
            if (!response.ok) {
                throw new Error(`sandbox status ${response.status}`);
            }
            const payload = await response.json();
            renderSandboxes(payload.sandboxes || []);
            if (payload.adapters?.length) {
                renderAdapters(payload.adapters);
            } else {
                await loadAdapters();
            }
        } catch (error) {
            if (listEl) {
                listEl.innerHTML = `<div class="sandbox-empty">Sandbox 状态加载失败: ${escapeHtml(error.message)}</div>`;
            }
        }
    }

    function renderSandboxes(sandboxes) {
        if (!listEl) {
            return;
        }
        if (!sandboxes.length) {
            listEl.innerHTML = '<div class="sandbox-empty">暂无 sandbox 实例。</div>';
            return;
        }

        listEl.innerHTML = sandboxes
            .map((sandbox) => {
                const preview = sandbox.preview || {};
                const notes = (sandbox.notes || []).map((n) => escapeHtml(n)).join('<br>');
                return `
            <article class="sandbox-card">
                <header>
                    <div>
                        <h3>${escapeHtml(sandbox.name)}</h3>
                        <div class="sandbox-meta">${escapeHtml(sandbox.kind)} · ${escapeHtml(sandbox.runtimeMode)}</div>
                    </div>
                    <span class="sandbox-status ${escapeHtml(sandbox.status)}">${escapeHtml(sandbox.status)}</span>
                </header>
                <div class="sandbox-meta">${escapeHtml(preview.title)}</div>
                <div class="sandbox-metrics">
                    <div class="sandbox-metric"><span>CPU</span><strong>${escapeHtml(String(preview.cpuPercent ?? ''))}%</strong></div>
                    <div class="sandbox-metric"><span>Memory</span><strong>${escapeHtml(String(preview.memoryMb ?? ''))} MB</strong></div>
                    <div class="sandbox-metric"><span>Network</span><strong>${escapeHtml(String(preview.networkKbps ?? ''))} kbps</strong></div>
                    <div class="sandbox-metric"><span>Uptime</span><strong>${escapeHtml(String(preview.uptimeSec ?? ''))}s</strong></div>
                </div>
                <div class="sandbox-meta">${escapeHtml(sandbox.adapterHint)}</div>
                <div class="sandbox-notes">${notes}</div>
                <div class="sandbox-controls">
                    <button type="button" data-action="start" data-id="${escapeHtml(sandbox.id)}">启动</button>
                    <button type="button" data-action="stop" data-id="${escapeHtml(sandbox.id)}">停止</button>
                </div>
            </article>`;
            })
            .join('');

        listEl.querySelectorAll('button[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                controlSandbox(button.dataset.id, button.dataset.action).catch((err) => showError(String(err.message || err)));
            });
        });
    }

    async function createSandbox() {
        const kind = kindSelect?.value || 'computer';
        const response = await fetch('/v1/kgm/sandboxes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response, `create sandbox failed: ${response.status}`));
        }
        await loadSandboxes();
    }

    async function readErrorMessage(response, fallback) {
        try {
            const body = await response.json();
            const err = body?.error;
            if (typeof err === 'string') return err;
            if (err && typeof err.message === 'string') {
                return `${err.code ? `${err.code}: ` : ''}${err.message}`;
            }
            if (typeof body?.message === 'string') return body.message;
        } catch {
            // ignore parse errors
        }
        return fallback;
    }

    async function controlSandbox(id, action) {
        const response = await fetch(`/v1/kgm/sandboxes/${id}/${action}`, {
            method: 'POST',
        });
        if (!response.ok) {
            const detail = await readErrorMessage(
                response,
                `${action} sandbox failed: ${response.status}`,
            );
            throw new Error(detail);
        }
        await loadSandboxes();
    }

    createBtn?.addEventListener('click', () => {
        createSandbox().catch((err) => showError(String(err.message || err)));
    });
    refreshBtn?.addEventListener('click', () => {
        loadSandboxes().catch((err) => showError(String(err.message || err)));
    });
    refreshAdaptersBtn?.addEventListener('click', () => {
        loadAdapters().catch((err) => showError(String(err.message || err)));
    });

    loadSandboxes();
    window.setInterval(() => {
        loadSandboxes().catch(() => {});
    }, 15000);
})();
