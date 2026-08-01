/**
 * 推理实例独立页：仅展示 status=running 的实例，减轻主配置页负担。
 */
(function () {
    const listEl = document.getElementById('model-runtime-list');
    const refreshBtn = document.getElementById('runtime-page-refresh');
    const artifactSelect = document.getElementById('runtime-artifact-select');
    const kindSelect = document.getElementById('runtime-kind-select');
    const modelNameInput = document.getElementById('runtime-model-name');
    const portInput = document.getElementById('runtime-port');
    const createBtn = document.getElementById('create-runtime-btn');
    const workerPolicyEl = document.getElementById('runtime-worker-policy');

    let modelArtifacts = [];
    let modelRuntimes = [];
    let modelSummaries = [];
    let nativeRuntimeId = '';

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    function policyRow(label, value, note) {
        const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—');
        return `<div class="control-plane-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(rendered)}</strong>${
            note ? `<small>${escapeHtml(note)}</small>` : ''
        }</div>`;
    }

    async function loadWorkerPolicy() {
        if (!workerPolicyEl) return;
        const response = await fetch('/v1/kgm/ops/config-status');
        if (!response.ok) throw new Error(`worker policy ${response.status}`);
        const data = await response.json();
        const workers = data.workers || {};
        const gates = workers.gates?.value || {};
        const restart = workers.autoRestart?.value || {};
        const ds4 = workers.ds4?.value || {};
        const tokenspeed = workers.tokenspeed?.value || {};
        const connection = ds4.connection || {};
        workerPolicyEl.innerHTML = [
            policyRow('llama.cpp / ds4 / tokenspeed 门闩', {
                llamaCpp: gates.llamaCpp?.enabled,
                ds4: gates.ds4?.enabled,
                tokenspeed: gates.tokenspeed?.enabled ?? 'off',
            }, 'ConfigStore · TokenSpeed 默认 off'),
            policyRow('自动重启', restart, `${workers.autoRestart?.source || 'default'} · 重启进程`),
            policyRow('ds4 连接', {
                enabled: connection.enabled ?? gates.ds4?.enabled,
                command: connection.command || gates.ds4?.command,
                chdir: connection.chdir || null,
                port: connection.port ?? 8090,
                baseUrl: connection.baseUrl || null,
            }, 'PORT/BASE_URL 为 env · 门闩/command 可热更新（新建 runtime）'),
            policyRow('ds4 serving', {
                ssdStreaming: ds4.ssdStreaming,
                batchedSession: ds4.batchedSession,
                ctxTokens: ds4.ctxTokens,
                diskKv: ds4.sessionKv?.enabled,
                diskDir: ds4.sessionKv?.diskDir || null,
                diskSpaceMb: ds4.sessionKv?.diskSpaceMb ?? null,
                ssdCacheExperts: ds4.ssdStreamingCacheExperts || null,
            }, `${workers.ds4?.source || 'default'} · token 交错由 ds4-server 负责`),
            policyRow('TokenSpeed', {
                selectable: tokenspeed.selectable,
                reason: tokenspeed.reason,
                baseUrl: tokenspeed.config?.baseUrl || null,
                command: tokenspeed.config?.command || null,
            }, `${workers.tokenspeed?.source || 'env+configStore'} · 可选推理后端，非意图层`),
        ].join('');
    }

    function readNativeRuntimeId() {
        try {
            const raw = localStorage.getItem('kgmPlaygroundConfig');
            if (!raw) {
                return '';
            }
            const cfg = JSON.parse(raw);
            return typeof cfg.nativeRuntimeId === 'string' ? cfg.nativeRuntimeId : '';
        } catch {
            return '';
        }
    }

    function renderArtifactOptions() {
        if (!artifactSelect) {
            return;
        }
        const selected = artifactSelect.value;
        artifactSelect.innerHTML = ['<option value="">选择已拉取模型</option>']
            .concat(
                modelArtifacts.map(
                    (artifact) =>
                        `<option value="${artifact.id}">${artifact.name} · ${artifact.sourceType} · ${(artifact.runtimeHints || []).join('/') || 'n/a'} · ${artifact.status}</option>`,
                ),
            )
            .join('');
        if (selected && modelArtifacts.some((item) => item.id === selected)) {
            artifactSelect.value = selected;
        }
    }

    function renderRuntimesOnly() {
        if (!listEl) {
            return;
        }
        nativeRuntimeId = readNativeRuntimeId();
        const running = modelRuntimes.filter((r) => r.status === 'running');
        if (!running.length) {
            listEl.innerHTML =
                '<div class="managed-empty">当前没有运行中的推理实例。<span class="muted">（已停止的实例不会在此列出；创建后需启动直至状态为 running。）</span></div>';
            return;
        }
        listEl.innerHTML = running
            .map((runtime) => {
                const summary = modelSummaries.find((item) => item.runtimeId === runtime.id || item.id === runtime.id) || {};
                const metrics = summary.metrics || {};
                const pill =
                    nativeRuntimeId === runtime.id ? ' <span class="runtime-pill">当前选用</span>' : '';
                return `
            <article class="managed-card">
                <header>
                    <div>
                        <h3>${runtime.name}${pill}</h3>
                        <div class="managed-meta">${runtime.modelName} · ${runtime.runtime} · health=${runtime.healthStatus || 'unknown'}</div>
                    </div>
                    <span class="managed-status ${runtime.status}">${runtime.status}</span>
                </header>
                <div class="managed-meta">${runtime.baseUrl}${runtime.apiPath}</div>
                <div class="managed-meta">upstream: ${runtime.upstreamModel}</div>
                <div class="managed-meta">pid: ${runtime.pid || 'n/a'}</div>
                <div class="sandbox-metrics">
                    <div class="sandbox-metric"><span>Avg Latency</span><strong>${Math.round(metrics.avgLatencyMs || 0)} ms</strong></div>
                    <div class="sandbox-metric"><span>Queue</span><strong>${metrics.queuedRequests || 0}</strong></div>
                    <div class="sandbox-metric"><span>Inflight</span><strong>${metrics.inflightRequests || 0}</strong></div>
                    <div class="sandbox-metric"><span>Circuit</span><strong>${metrics.circuitState || 'closed'}</strong></div>
                </div>
                <div class="managed-notes">${(runtime.notes || []).join('\n')}</div>
                <div class="managed-controls">
                    <button type="button" data-runtime-action="stop" data-id="${runtime.id}">停止</button>
                </div>
            </article>`;
            })
            .join('');

        listEl.querySelectorAll('button[data-runtime-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.dataset.id;
                const action = button.dataset.runtimeAction;
                controlRuntime(id, action).catch((err) => alert(String(err.message || err)));
            });
        });
    }

    async function loadData() {
        const [artifactResponse, runtimeResponse, summaryResponse] = await Promise.all([
            fetch('/v1/kgm/models/artifacts'),
            fetch('/v1/kgm/models/runtimes'),
            fetch('/v1/kgm/models'),
            loadWorkerPolicy(),
        ]);
        if (!artifactResponse.ok) {
            throw new Error(`artifacts ${artifactResponse.status}`);
        }
        if (!runtimeResponse.ok) {
            throw new Error(`runtimes ${runtimeResponse.status}`);
        }
        if (!summaryResponse.ok) {
            throw new Error(`models ${summaryResponse.status}`);
        }
        const artifactPayload = await artifactResponse.json();
        const runtimePayload = await runtimeResponse.json();
        const summaryPayload = await summaryResponse.json();
        modelArtifacts = artifactPayload.artifacts || [];
        modelRuntimes = runtimePayload.runtimes || [];
        modelSummaries = summaryPayload.models || [];
        renderArtifactOptions();
        renderRuntimesOnly();
    }

    async function controlRuntime(id, action) {
        const response = await fetch(`/v1/kgm/models/runtimes/${id}/${action}`, { method: 'POST' });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`${action} failed: ${response.status} ${text}`);
        }
        await loadData();
    }

    async function createRuntime() {
        const payload = {
            artifactId: artifactSelect?.value || undefined,
            runtime: kindSelect?.value || 'native',
            modelName: modelNameInput?.value?.trim() || undefined,
            port: portInput?.value ? Number(portInput.value) : undefined,
        };
        if (!payload.runtime) {
            throw new Error('请选择 runtime');
        }
        const response = await fetch('/v1/kgm/models/runtimes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`create failed: ${response.status} ${text}`);
        }
        await loadData();
    }

    if (artifactSelect && kindSelect) {
        artifactSelect.addEventListener('change', () => {
            const artifact = modelArtifacts.find((item) => item.id === artifactSelect.value);
            if (artifact && modelNameInput && !modelNameInput.value) {
                modelNameInput.value = artifact.modelName || artifact.name || '';
            }
            if (artifact && artifact.sourceType === 'local' && kindSelect) {
                kindSelect.value = 'native';
            }
        });
    }

    if (createBtn) {
        createBtn.addEventListener('click', () => {
            createRuntime().catch((err) => alert(String(err.message || err)));
        });
    }
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadData().catch((err) => {
                if (listEl) {
                    listEl.innerHTML = `<div class="managed-empty">加载失败: ${err.message}</div>`;
                }
            });
        });
    }

    loadData().catch((err) => {
        if (listEl) {
            listEl.innerHTML = `<div class="managed-empty">加载失败: ${err.message}</div>`;
        }
    });

    window.setInterval(() => {
        loadData().catch(() => {});
    }, 15000);
})();
