/**
 * Sandbox Control 独立页：与主 Playground 首页解耦。
 */
(function () {
    const listEl = document.getElementById('sandbox-list');
    const kindSelect = document.getElementById('sandbox-kind-select');
    const createBtn = document.getElementById('create-sandbox-btn');
    const refreshBtn = document.getElementById('refresh-sandbox-btn');

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

    async function loadSandboxes() {
        try {
            const response = await fetch('/v1/kgm/sandboxes');
            if (!response.ok) {
                throw new Error(`sandbox status ${response.status}`);
            }
            const payload = await response.json();
            renderSandboxes(payload.sandboxes || []);
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
            throw new Error(`create sandbox failed: ${response.status}`);
        }
        await loadSandboxes();
    }

    async function controlSandbox(id, action) {
        const response = await fetch(`/v1/kgm/sandboxes/${id}/${action}`, {
            method: 'POST',
        });
        if (!response.ok) {
            throw new Error(`${action} sandbox failed: ${response.status}`);
        }
        await loadSandboxes();
    }

    createBtn?.addEventListener('click', () => {
        createSandbox().catch((err) => showError(String(err.message || err)));
    });
    refreshBtn?.addEventListener('click', () => {
        loadSandboxes().catch((err) => showError(String(err.message || err)));
    });

    loadSandboxes();
    window.setInterval(() => {
        loadSandboxes().catch(() => {});
    }, 15000);
})();
