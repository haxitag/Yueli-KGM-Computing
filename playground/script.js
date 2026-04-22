// KGM-Computing Playground 前端脚本 - 信任委托与代理API

class KGMTrustProxyPlayground {
    constructor() {
        this.initializeElements();
        this.setupEventListeners();
        this.mediaFiles = {
            images: [],
            audio: null,
            video: null,
            recordedAudio: null
        };
        this.recognition = null;
        this.isRecording = false;
        this.modelArtifacts = [];
        this.modelRuntimes = [];
        this.modelSummaries = [];
        this.autoRoutingConfig = null;
        this.autoRoutingSummary = null;
        this.nativeDefaults = null;
        this.currentConfig = {
            provider: '',
            modelName: '',
            nativeModelPath: '',
            nativeRuntimeId: '',
            temperature: 0.7,
            maxTokens: 1024,
            apiKeys: {},
            protocol: 'chat.completions',
            stream: true,
            includeBuiltinTools: true,
            executeToolCalls: true,
            routingProfile: 'quality_first',
            taskType: '',
            targetProvider: '',
            targetModel: '',
            maxCostPerRequest: ''
        };
        this.loadConfigFromLocalStorage();
        this.renderStatusBar();
        this.loadManagedModels();
        this.loadAutoRoutingOverview();
        this.playgroundConfig = null;
        this.loadPlaygroundFromServer();
        window.setInterval(() => this.loadManagedModels(), 20000);
        window.setInterval(() => this.loadAutoRoutingOverview(), 25000);
    }

    initializeElements() {
        // 顶部菜单元素
        this.modelSelectBtn = document.getElementById('model-select-btn');
        this.modelConfigBtn = document.getElementById('model-config-btn');
        this.autoRoutingBtn = document.getElementById('auto-routing-btn');
        this.apiKeysBtn = document.getElementById('api-keys-btn');
        this.infoBtn = document.getElementById('info-btn');
        this.modalOverlay = document.getElementById('modal-overlay');
        this.modal = document.querySelector('.modal');
        this.modalTitle = document.getElementById('modal-title');
        this.modalBody = document.getElementById('modal-body');
        this.closeModalBtn = document.getElementById('close-modal');
        this.statusService = document.getElementById('status-service');
        this.statusProvider = document.getElementById('status-provider');
        this.statusModel = document.getElementById('status-model');
        this.statusProtocol = document.getElementById('status-protocol');
        this.statusStream = document.getElementById('status-stream');
        this.statusModelPath = document.getElementById('status-model-path');

        // 配置元素
        this.modelSelect = document.getElementById('model-select');
        this.temperatureSlider = document.getElementById('temperature');
        this.tempValue = document.getElementById('temp-value');
        this.maxTokensInput = document.getElementById('max-tokens');

        // 输入元素
        this.promptText = document.getElementById('prompt-text');
        this.imageUpload = document.getElementById('image-upload');
        this.imagePreview = document.getElementById('image-preview');
        this.audioUpload = document.getElementById('audio-upload');
        this.recordAudioBtn = document.getElementById('record-audio');
        this.audioControls = document.getElementById('audio-controls');
        this.startRecordingBtn = document.getElementById('start-recording');
        this.stopRecordingBtn = document.getElementById('stop-recording');
        this.recordedAudio = document.getElementById('recorded-audio');
        this.videoUpload = document.getElementById('video-upload');
        this.videoPreview = document.getElementById('video-preview');
        this.voiceInputBtn = document.getElementById('voice-input-btn');
        this.voiceTranscript = document.getElementById('voice-transcript');
        
        // 语音转文本弹窗元素
        this.voiceModalOverlay = document.getElementById('voice-modal-overlay');
        this.closeVoiceModalBtn = document.getElementById('close-voice-modal');
        this.startVoiceRecognitionBtn = document.getElementById('start-voice-recognition');
        this.stopVoiceRecognitionBtn = document.getElementById('stop-voice-recognition');
        this.confirmVoiceResultBtn = document.getElementById('confirm-voice-result');
        this.voiceStatusText = document.getElementById('voice-status-text');
        this.voiceStatus = document.getElementById('voice-status');
        this.voiceTranscriptEdit = document.getElementById('voice-transcript-edit');
        
        // 文档上传元素
        this.documentUploadHidden = document.getElementById('document-upload-hidden');
        this.documentUploadBtn = document.getElementById('document-upload-btn');
        this.documentPreview = document.getElementById('document-preview');
        this.protocolSelect = document.getElementById('protocol-select');
        this.streamMode = document.getElementById('stream-mode');
        this.builtinToolsToggle = document.getElementById('builtin-tools-toggle');
        this.serverExecToggle = document.getElementById('server-exec-toggle');

        // 输出元素
        this.submitBtn = document.getElementById('submit-btn');
        this.clearBtn = document.getElementById('clear-btn');
        this.loading = document.getElementById('loading');
        this.textOutput = document.getElementById('text-output');
        this.streamOutput = document.getElementById('stream-output');
        this.traceOutput = document.getElementById('trace-output');
        this.imageOutput = document.getElementById('image-output');
        this.videoOutput = document.getElementById('video-output');
        this.generatedVideo = document.getElementById('generated-video');
        this.audioOutput = document.getElementById('audio-output');
        this.generatedAudio = document.getElementById('generated-audio');
        this.modelSourceType = document.getElementById('model-source-type');
        this.modelSourceUrl = document.getElementById('model-source-url');
        this.modelFilePath = document.getElementById('model-file-path');
        this.modelRevision = document.getElementById('model-revision');
        this.modelNameInput = document.getElementById('model-name');
        this.pullModelBtn = document.getElementById('pull-model-btn');
        this.refreshModelsBtn = document.getElementById('refresh-models-btn');
        this.modelArtifactList = document.getElementById('model-artifact-list');
        this.refreshRoutingBtn = document.getElementById('refresh-routing-btn');
        this.saveRoutingBtn = document.getElementById('save-routing-btn');
        this.routingEnabled = document.getElementById('routing-enabled');
        this.routingProfileSelect = document.getElementById('routing-profile-select');
        this.routingDynamic = document.getElementById('routing-dynamic');
        this.routingVerifiable = document.getElementById('routing-verifiable');
        this.routingMaxCost = document.getElementById('routing-max-cost');
        this.routingTargetLatency = document.getElementById('routing-target-latency');
        this.routingEvalEnabled = document.getElementById('routing-eval-enabled');
        this.routingEvalFallback = document.getElementById('routing-eval-fallback');
        this.routingJudgeEnabled = document.getElementById('routing-judge-enabled');
        this.routingJudgeProvider = document.getElementById('routing-judge-provider');
        this.routingJudgeModel = document.getElementById('routing-judge-model');
        this.routingVerifierEnabled = document.getElementById('routing-verifier-enabled');
        this.routingVerifierProvider = document.getElementById('routing-verifier-provider');
        this.routingVerifierModel = document.getElementById('routing-verifier-model');
        this.requestRoutingProfile = document.getElementById('request-routing-profile');
        this.requestTaskType = document.getElementById('request-task-type');
        this.requestTargetProvider = document.getElementById('request-target-provider');
        this.requestTargetModel = document.getElementById('request-target-model');
        this.taskRouteList = document.getElementById('task-route-list');
        this.routeRuleName = document.getElementById('route-rule-name');
        this.routeRuleTaskType = document.getElementById('route-rule-task-type');
        this.routeRuleKeywords = document.getElementById('route-rule-keywords');
        this.routeRuleProvider = document.getElementById('route-rule-provider');
        this.routeRuleModel = document.getElementById('route-rule-model');
        this.routeRulePriority = document.getElementById('route-rule-priority');
        this.addRouteRuleBtn = document.getElementById('add-route-rule-btn');
        this.routingSummaryCards = document.getElementById('routing-summary-cards');
        this.routingModelStats = document.getElementById('routing-model-stats');
        this.routingRecentAudit = document.getElementById('routing-recent-audit');

        this.integrationTabs = document.querySelectorAll('.nav-item[data-int-tab]');
        this.integrationPanels = {
            skills: document.getElementById('int-panel-skills'),
            mcp: document.getElementById('int-panel-mcp'),
            output: document.getElementById('int-panel-output'),
        };
        this.playgroundConfigJson = document.getElementById('playground-config-json');
        this.playgroundSaveBtn = document.getElementById('playground-save-btn');
        this.playgroundReloadBtn = document.getElementById('playground-reload-btn');
        this.skillMdImport = document.getElementById('skill-md-import');
        this.playgroundExtraPrompt = document.getElementById('playground-extra-prompt');
    }

    setupEventListeners() {
        // 顶部菜单事件监听
        this.modelSelectBtn.addEventListener('click', () => this.showModelSelectionModal());
        this.modelConfigBtn.addEventListener('click', () => this.showModelConfigModal());
        this.autoRoutingBtn.addEventListener('click', () => this.showAutoRoutingModal());
        this.apiKeysBtn.addEventListener('click', () => this.showApiKeysModal());
        this.infoBtn.addEventListener('click', () => this.showInfoModal());
        this.closeModalBtn.addEventListener('click', () => this.hideModal());
        this.modalOverlay.addEventListener('click', (e) => {
            if (e.target === this.modalOverlay) {
                this.hideModal();
            }
        });

        // 配置事件监听
        if (this.temperatureSlider) {
            this.temperatureSlider.addEventListener('input', () => {
                if (this.tempValue) {
                    this.tempValue.textContent = this.temperatureSlider.value;
                }
            });
        }

        // 文件上传事件监听
        if (this.imageUpload) {
            this.imageUpload.addEventListener('change', (e) => this.handleImageUpload(e));
        }
        if (this.audioUpload) {
            this.audioUpload.addEventListener('change', (e) => this.handleAudioUpload(e));
        }
        if (this.videoUpload) {
            this.videoUpload.addEventListener('change', (e) => this.handleVideoUpload(e));
        }

        // 录音功能
        if (this.recordAudioBtn) {
            this.recordAudioBtn.addEventListener('click', () => this.toggleAudioControls());
        }
        if (this.startRecordingBtn) {
            this.startRecordingBtn.addEventListener('click', () => this.startRecording());
        }
        if (this.stopRecordingBtn) {
            this.stopRecordingBtn.addEventListener('click', () => this.stopRecording());
        }

        // 语音输入
        if (this.voiceInputBtn) {
            this.voiceInputBtn.addEventListener('click', () => this.openVoiceModal());
        }
        
        // 语音转文本弹窗事件
        if (this.closeVoiceModalBtn) {
            this.closeVoiceModalBtn.addEventListener('click', () => this.closeVoiceModal());
        }
        if (this.voiceModalOverlay) {
            this.voiceModalOverlay.addEventListener('click', (e) => {
                if (e.target === this.voiceModalOverlay) {
                    this.closeVoiceModal();
                }
            });
        }
        if (this.startVoiceRecognitionBtn) {
            this.startVoiceRecognitionBtn.addEventListener('click', () => this.startVoiceRecognition());
        }
        if (this.stopVoiceRecognitionBtn) {
            this.stopVoiceRecognitionBtn.addEventListener('click', () => this.stopVoiceRecognition());
        }
        if (this.confirmVoiceResultBtn) {
            this.confirmVoiceResultBtn.addEventListener('click', () => this.confirmVoiceResult());
        }

        if (this.integrationTabs?.length) {
            this.integrationTabs.forEach((tab) => {
                tab.addEventListener('click', () => this.switchIntegrationTab(tab.dataset.intTab));
                tab.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.switchIntegrationTab(tab.dataset.intTab);
                    }
                });
            });
        }
        if (this.playgroundSaveBtn) {
            this.playgroundSaveBtn.addEventListener('click', () => this.savePlaygroundToServer());
        }
        if (this.playgroundReloadBtn) {
            this.playgroundReloadBtn.addEventListener('click', () => this.loadPlaygroundFromServer());
        }
        if (this.skillMdImport) {
            this.skillMdImport.addEventListener('change', (e) => this.handleSkillMdImport(e));
        }
        
        // 文档上传事件
        if (this.documentUploadBtn && this.documentUploadHidden) {
            this.documentUploadBtn.addEventListener('click', () => {
                this.documentUploadHidden.click();
            });
            this.documentUploadHidden.addEventListener('change', (e) => this.handleDocumentUpload(e));
        }
        
        // 按钮事件监听
        if (this.submitBtn) {
            this.submitBtn.addEventListener('click', () => this.handleSubmit());
        }
        if (this.clearBtn) {
            this.clearBtn.addEventListener('click', () => this.handleClear());
        }
        if (this.protocolSelect) {
            this.protocolSelect.addEventListener('change', () => {
                this.currentConfig.protocol = this.protocolSelect.value;
                this.saveConfigToLocalStorage();
            });
        }
        if (this.streamMode) {
            this.streamMode.addEventListener('change', () => {
                this.currentConfig.stream = this.streamMode.checked;
                this.saveConfigToLocalStorage();
            });
        }
        if (this.builtinToolsToggle) {
            this.builtinToolsToggle.addEventListener('change', () => {
                this.currentConfig.includeBuiltinTools = this.builtinToolsToggle.checked;
                this.saveConfigToLocalStorage();
            });
        }
        if (this.serverExecToggle) {
            this.serverExecToggle.addEventListener('change', () => {
                this.currentConfig.executeToolCalls = this.serverExecToggle.checked;
                this.saveConfigToLocalStorage();
            });
        }
        if (this.pullModelBtn) {
            this.pullModelBtn.addEventListener('click', () => this.pullManagedModel().catch(error => this.showError(error.message)));
        }
        if (this.modelSourceType) {
            this.modelSourceType.addEventListener('change', () => this.updateManagedModelSourcePlaceholder());
        }
        if (this.refreshModelsBtn) {
            this.refreshModelsBtn.addEventListener('click', () => this.loadManagedModels());
        }
        if (this.refreshRoutingBtn) {
            this.refreshRoutingBtn.addEventListener('click', () => this.loadAutoRoutingOverview());
        }
        if (this.saveRoutingBtn) {
            this.saveRoutingBtn.addEventListener('click', () => this.saveAutoRoutingConfig().catch(error => this.showError(error.message)));
        }
        if (this.addRouteRuleBtn) {
            this.addRouteRuleBtn.addEventListener('click', () => this.addTaskRouteRule());
        }
        this.updateManagedModelSourcePlaceholder();
    }

    showModelSelectionModal() {
        this.renderModelModal({ title: '选择服务与模型', includeGenerationControls: false });
    }

    showModelConfigModal() {
        this.renderModelModal({ title: '模型配置', includeGenerationControls: true });
    }

    renderModelModal({ title, includeGenerationControls }) {
        const isNative = this.currentConfig.provider === 'yueli-native';
        this.modalTitle.textContent = title;
        this.modalBody.innerHTML = `
            <div class="config-form">
                ${includeGenerationControls ? `
                <div class="form-group">
                    <label for="modal-temperature">温度:</label>
                    <input type="range" id="modal-temperature" min="0" max="1" step="0.1" value="${this.currentConfig.temperature}">
                    <span id="modal-temp-value">${this.currentConfig.temperature}</span>
                </div>
                <div class="form-group">
                    <label for="modal-max-tokens">最大令牌数:</label>
                    <input type="number" id="modal-max-tokens" min="1" max="4096" value="${this.currentConfig.maxTokens}">
                </div>` : ''}
                <div class="form-group">
                    <label for="modal-provider-select">服务模式:</label>
                    <select id="modal-provider-select">
                        <option value="">自动选择 Provider</option>
                        <option value="yueli-native" ${isNative ? 'selected' : ''}>Yueli-KGM 本地推理</option>
                        <option value="openai" ${this.currentConfig.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                        <option value="zhipu" ${this.currentConfig.provider === 'zhipu' ? 'selected' : ''}>智谱AI</option>
                        <option value="minimax" ${this.currentConfig.provider === 'minimax' ? 'selected' : ''}>Minimax</option>
                        <option value="openrouter" ${this.currentConfig.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="nvidia" ${this.currentConfig.provider === 'nvidia' ? 'selected' : ''}>NVIDIA</option>
                        <option value="deepseek" ${this.currentConfig.provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
                        <option value="ollama" ${this.currentConfig.provider === 'ollama' ? 'selected' : ''}>Ollama</option>
                        <option value="vllm" ${this.currentConfig.provider === 'vllm' ? 'selected' : ''}>vLLM</option>
                        <option value="sglang" ${this.currentConfig.provider === 'sglang' ? 'selected' : ''}>SGLang</option>
                        <option value="custom" ${this.currentConfig.provider === 'custom' ? 'selected' : ''}>自定义（OpenAI 兼容）</option>
                    </select>
                </div>
                <div class="form-group" id="modal-provider-help" ${isNative ? 'style="display:none;"' : ''}>
                    <span class="helper-text">第三方 Provider 模式下，请填写要透传给 <code>/v1/*</code> 的模型名。</span>
                </div>
                <div class="form-group">
                    <label for="modal-model-name">模型名 / Runtime 名称:</label>
                    <input type="text" id="modal-model-name" placeholder="${isNative ? '例如 qwen-native-local' : '例如 gpt-4o-mini / qwen2.5:7b-instruct'}" value="${this.escapeHtml(this.currentConfig.modelName || '')}">
                    <span class="helper-text">${isNative ? 'Yueli-KGM 本地推理模式下，这个值会作为 managed native runtime 的模型名。' : '留空则由后端或 Provider 默认值决定。'}</span>
                    <div class="helper-text" id="modal-ollama-model-hints" style="display:none;"></div>
                </div>
                <div class="form-group" id="modal-native-config" ${isNative ? '' : 'style="display:none;"'}>
                    <label for="modal-native-model-path">本地模型绝对路径:</label>
                    <div class="path-field-row">
                        <input type="text" id="modal-native-model-path" placeholder="/absolute/path/to/model.gguf 或 /absolute/path/to/model-dir" value="${this.escapeHtml(this.currentConfig.nativeModelPath || '')}">
                        <button type="button" class="secondary-config-btn" id="browse-native-model-path">浏览</button>
                    </div>
                    <div class="path-field-row">
                        <button type="button" class="secondary-config-btn" id="use-default-native-model-path">使用 KGM_MODEL_PATH 默认值</button>
                    </div>
                    <span class="helper-text">支持文件或目录路径。当前本地 loader 支持 <code>.kgm.json</code>、<code>.gguf</code>、<code>.safetensors</code>、<code>.onnx</code>、Transformers/Hugging Face 模型目录、PyTorch <code>.bin/.pt/.pth</code>、TensorFlow <code>SavedModel/.h5/.ckpt</code>。也支持直接填写 Ollama store 根目录；这种情况下“模型名 / Runtime 名称”必须填写实际 Ollama 模型引用，例如 <code>qwen3.5:latest</code>。</span>
                    <div class="path-browser" id="native-model-browser" style="display:none;"></div>
                </div>
                <button class="save-config-btn" id="save-model-config">保存配置</button>
            </div>
        `;

        const serviceSelect = document.getElementById('modal-provider-select');
        const modelNameInput = document.getElementById('modal-model-name');
        const nativeConfig = document.getElementById('modal-native-config');
        const providerHelp = document.getElementById('modal-provider-help');
        const nativePathInput = document.getElementById('modal-native-model-path');
        const browseBtn = document.getElementById('browse-native-model-path');
        const useDefaultBtn = document.getElementById('use-default-native-model-path');
        const browser = document.getElementById('native-model-browser');
        const ollamaModelHints = document.getElementById('modal-ollama-model-hints');
        const saveBtn = document.getElementById('save-model-config');

        const refreshForm = () => {
            const nativeSelected = serviceSelect.value === 'yueli-native';
            nativeConfig.style.display = nativeSelected ? '' : 'none';
            providerHelp.style.display = nativeSelected ? 'none' : '';
            modelNameInput.placeholder = nativeSelected ? '例如 qwen-native-local' : '例如 gpt-4o-mini / qwen2.5:7b-instruct';
        };

        serviceSelect.addEventListener('change', refreshForm);
        refreshForm();

        if (includeGenerationControls) {
            const tempSlider = document.getElementById('modal-temperature');
            const tempValue = document.getElementById('modal-temp-value');
            tempSlider.addEventListener('input', () => {
                tempValue.textContent = tempSlider.value;
            });
        }

        browseBtn?.addEventListener('click', async () => {
            try {
                await this.togglePathBrowser(browser, nativePathInput);
            } catch (error) {
                this.showError(error.message);
            }
        });

        useDefaultBtn?.addEventListener('click', async () => {
            try {
                const defaults = await this.getNativeDefaults();
                nativePathInput.value = defaults.defaultModelPath || defaults.ollamaModelDirs?.[0] || defaults.cwd || defaults.homeDir || '';
                if (!modelNameInput.value.trim() && defaults.ollamaModelRefs?.length === 1) {
                    modelNameInput.value = defaults.ollamaModelRefs[0];
                }
            } catch (error) {
                this.showError(error.message);
            }
        });

        this.getNativeDefaults()
            .then((defaults) => {
                if (!ollamaModelHints || !defaults.ollamaModelRefs?.length) {
                    return;
                }
                ollamaModelHints.style.display = '';
                ollamaModelHints.textContent = `已检测到本机 Ollama 模型: ${defaults.ollamaModelRefs.slice(0, 6).join(', ')}${defaults.ollamaModelRefs.length > 6 ? ' ...' : ''}`;
            })
            .catch(() => {});

        saveBtn.addEventListener('click', async () => {
            try {
                if (includeGenerationControls) {
                    this.currentConfig.temperature = parseFloat(document.getElementById('modal-temperature').value);
                    this.currentConfig.maxTokens = parseInt(document.getElementById('modal-max-tokens').value, 10);
                }

                const selectedService = serviceSelect.value.trim();
                const requestedModelName = modelNameInput.value.trim();

                if (selectedService === 'yueli-native') {
                    this.currentConfig.provider = 'yueli-native';
                    this.currentConfig.nativeModelPath = nativePathInput.value.trim();
                    if (this.isLikelyOllamaStorePath(this.currentConfig.nativeModelPath) && !requestedModelName) {
                        throw new Error('使用 Ollama store 根目录时，请在“模型名 / Runtime 名称”里填写实际 Ollama 模型引用，例如 qwen3.5:latest');
                    }
                    const applied = await this.ensureNativeRuntimeConfigured({
                        modelPath: this.currentConfig.nativeModelPath,
                        modelName: requestedModelName,
                    });
                    this.currentConfig.modelName = applied.modelName;
                    this.currentConfig.nativeRuntimeId = applied.runtimeId;
                } else {
                    this.currentConfig.provider = selectedService;
                    this.currentConfig.modelName = requestedModelName;
                    this.currentConfig.nativeRuntimeId = '';
                }

                this.saveConfigToLocalStorage();
                this.hideModal();
            } catch (error) {
                this.showError(error.message);
            }
        });

        this.showModal();
    }

    showAutoRoutingModal() {
        this.modalTitle.textContent = '自动调度偏好';
        this.modalBody.innerHTML = `
            <div class="config-form">
                <div class="form-group">
                    <label for="modal-routing-profile">请求模式:</label>
                    <select id="modal-routing-profile">
                        <option value="quality_first" ${this.currentConfig.routingProfile === 'quality_first' ? 'selected' : ''}>效果优先</option>
                        <option value="cost_first" ${this.currentConfig.routingProfile === 'cost_first' ? 'selected' : ''}>成本优先</option>
                        <option value="manual" ${this.currentConfig.routingProfile === 'manual' ? 'selected' : ''}>手动指定</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="modal-task-type">任务类型:</label>
                    <select id="modal-task-type">
                        <option value="" ${!this.currentConfig.taskType ? 'selected' : ''}>自动识别</option>
                        <option value="general" ${this.currentConfig.taskType === 'general' ? 'selected' : ''}>general</option>
                        <option value="reasoning" ${this.currentConfig.taskType === 'reasoning' ? 'selected' : ''}>reasoning</option>
                        <option value="code_generation" ${this.currentConfig.taskType === 'code_generation' ? 'selected' : ''}>code_generation</option>
                        <option value="structured_output" ${this.currentConfig.taskType === 'structured_output' ? 'selected' : ''}>structured_output</option>
                        <option value="math_reasoning" ${this.currentConfig.taskType === 'math_reasoning' ? 'selected' : ''}>math_reasoning</option>
                        <option value="translation" ${this.currentConfig.taskType === 'translation' ? 'selected' : ''}>translation</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="modal-target-provider">目标 Provider:</label>
                    <input type="text" id="modal-target-provider" placeholder="留空表示自动" value="${this.escapeHtml(this.currentConfig.targetProvider || '')}">
                </div>
                <div class="form-group">
                    <label for="modal-target-model">目标模型:</label>
                    <input type="text" id="modal-target-model" placeholder="留空表示自动" value="${this.escapeHtml(this.currentConfig.targetModel || '')}">
                </div>
                <div class="form-group">
                    <label for="modal-max-cost-routing">成本上限(USD):</label>
                    <input type="number" id="modal-max-cost-routing" min="0" step="0.001" value="${this.escapeHtml(this.currentConfig.maxCostPerRequest || '')}">
                </div>
                <button class="save-config-btn" id="save-auto-routing-preference">保存偏好</button>
            </div>
        `;

        document.getElementById('save-auto-routing-preference').addEventListener('click', () => {
            this.currentConfig.routingProfile = document.getElementById('modal-routing-profile').value;
            this.currentConfig.taskType = document.getElementById('modal-task-type').value;
            this.currentConfig.targetProvider = document.getElementById('modal-target-provider').value.trim();
            this.currentConfig.targetModel = document.getElementById('modal-target-model').value.trim();
            this.currentConfig.maxCostPerRequest = document.getElementById('modal-max-cost-routing').value;
            this.saveConfigToLocalStorage();
            this.renderRequestRoutingPreferences();
            this.hideModal();
        });

        this.showModal();
    }

    showApiKeysModal() {
        this.modalTitle.textContent = 'API Keys 与凭证';
        if (this.modal) {
            this.modal.classList.add('modal--wide', 'modal--api-keys');
        }

        const k = this.currentConfig.apiKeys || {};
        const val = (key) => this.escapeHtml(k[key] || '');

        const sections = [
            {
                title: '云端 API 服务商',
                desc: '对接 OpenAI 兼容商业 API 时使用。保存于本机浏览器 localStorage。',
                fields: [
                    { key: 'openai', label: 'OpenAI', placeholder: 'sk-...', hint: 'platform.openai.com' },
                    { key: 'zhipu', label: '智谱 AI', placeholder: 'API Key', hint: 'open.bigmodel.cn' },
                    { key: 'minimax', label: 'Minimax', placeholder: 'API Key', hint: 'api.minimax' },
                    { key: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...', hint: 'openrouter.ai' },
                    { key: 'nvidia', label: 'NVIDIA NIM / Integrate', placeholder: 'nvapi-...', hint: 'integrate.api.nvidia.com' },
                    { key: 'deepseek', label: 'DeepSeek', placeholder: 'API Key', hint: 'api.deepseek.com' },
                ],
            },
            {
                title: '本地与自托管推理引擎',
                desc: 'Ollama / vLLM / SGLang 等通常无需 Key；若前面挂了鉴权网关或托管实例启用了 Bearer，请填写。',
                fields: [
                    { key: 'ollama', label: 'Ollama', placeholder: '通常留空', hint: 'localhost:11434' },
                    { key: 'vllm', label: 'vLLM', placeholder: '可选 Bearer', hint: 'localhost:8000/v1' },
                    { key: 'slang', label: 'SGLang', placeholder: '可选 Bearer', hint: 'OpenAI 兼容端口，如 7860/v1' },
                ],
            },
            {
                title: '其它',
                desc: 'Minimax 需与 Group ID 同配；自定义上游用于 OpenAI 兼容但非上述厂商的 Token。',
                fields: [
                    { key: 'custom', label: '自定义 OpenAI 兼容', placeholder: 'Bearer Token', hint: '服务模式选「自定义」时使用' },
                    {
                        key: 'minimaxGroupId',
                        label: 'Minimax Group ID',
                        placeholder: '与 Minimax API Key 配对',
                        hint: 'Minimax 官方要求',
                        inputType: 'text',
                    },
                ],
            },
        ];

        let bodyHtml = `
            <div class="config-form api-keys-modal">
                <p class="api-keys-intro">
                    凭证仅保存在本机浏览器。在下方选择「服务模式」并发起推理时，若已填写对应 Key，请求将附带
                    <code>Authorization: Bearer …</code>（便于覆盖服务端默认上游鉴权；本地引擎无鉴权可留空）。
                </p>
        `;

        sections.forEach((sec, secIdx) => {
            bodyHtml += `
                <section class="api-keys-section" aria-labelledby="api-keys-sec-${secIdx}">
                    <h4 class="api-keys-section-title" id="api-keys-sec-${secIdx}">${this.escapeHtml(sec.title)}</h4>
                    ${sec.desc ? `<p class="api-keys-section-desc">${this.escapeHtml(sec.desc)}</p>` : ''}
                    <div class="api-keys-grid">
            `;
            for (const f of sec.fields) {
                const inputType = f.inputType || 'password';
                bodyHtml += `
                    <div class="api-keys-field">
                        <label for="api-key-${f.key}">${this.escapeHtml(f.label)}</label>
                        <input
                            type="${inputType}"
                            id="api-key-${f.key}"
                            name="api-key-${f.key}"
                            autocomplete="${inputType === 'password' ? 'new-password' : 'off'}"
                            placeholder="${this.escapeHtml(f.placeholder || '')}"
                            value="${val(f.key)}"
                        >
                        ${f.hint ? `<span class="field-hint">${this.escapeHtml(f.hint)}</span>` : ''}
                    </div>
                `;
            }
            bodyHtml += `
                    </div>
                </section>
            `;
        });

        bodyHtml += `
                <div class="api-keys-actions">
                    <button type="button" class="btn btn-primary" id="save-api-keys">保存凭证</button>
                </div>
            </div>
        `;

        this.modalBody.innerHTML = bodyHtml;

        const saveBtn = document.getElementById('save-api-keys');
        const keyIds = [
            'openai', 'zhipu', 'minimax', 'openrouter', 'nvidia', 'deepseek',
            'ollama', 'vllm', 'slang', 'custom', 'minimaxGroupId',
        ];
        saveBtn.addEventListener('click', () => {
            this.currentConfig.apiKeys = this.currentConfig.apiKeys || {};
            for (const id of keyIds) {
                const el = document.getElementById(`api-key-${id}`);
                if (el) {
                    this.currentConfig.apiKeys[id] = el.value;
                }
            }
            this.saveConfigToLocalStorage();
            this.hideModal();
        });

        this.showModal();
    }

    /** 当前服务模式对应的 Bearer；与 LlmProviderFactory / 路由 provider 名称对齐 */
    getApiKeyForProvider(provider) {
        const keys = this.currentConfig.apiKeys || {};
        if (!provider || provider === 'yueli-native') {
            return '';
        }
        const map = {
            openai: keys.openai,
            zhipu: keys.zhipu,
            minimax: keys.minimax,
            openrouter: keys.openrouter,
            nvidia: keys.nvidia,
            deepseek: keys.deepseek,
            ollama: keys.ollama,
            vllm: keys.vllm,
            sglang: keys.slang || keys.sglang,
            custom: keys.custom,
        };
        const raw = map[provider];
        return typeof raw === 'string' ? raw.trim() : '';
    }

    buildPlaygroundAuthHeaders() {
        const token = this.getApiKeyForProvider(this.currentConfig.provider);
        if (!token) {
            return {};
        }
        return { Authorization: `Bearer ${token}` };
    }

    showInfoModal() {
        this.modalTitle.textContent = '信任委托与代理功能';
        this.modalBody.innerHTML = `
            <div class="features-section info-modal-overview">
                <p class="lead">
                    <strong>KGM（Yueli-KGM-Computing）</strong>在 Playground 中作为<strong>自托管推理编排与兼容网关</strong>：既可把请求路由到外接引擎，也可在受支持路径上使用进程内 Native 推理；以下概述与
                    <code>docs/capabilities.md</code>、本地 Ollama 验证记录（<code>docs/local-ollama-serving-validation.md</code>）口径一致。
                </p>

                <h4>能力与定位</h4>
                <ul>
                    <li><strong>双协议出口</strong>：OpenAI 兼容（<code>chat.completions</code> / <code>responses</code>）与 Anthropic（Claude）兼容（<code>messages</code>），便于统一客户端与网关接入。</li>
                    <li><strong><code>kgm</code> 扩展</strong>：工具注入与执行、图谱与实体/三元组、检索与会话等元数据；启用时流式走桥接，未启用时可对上游 SSE 透传以降低开销。</li>
                    <li><strong>受管 runtime 与制品</strong>：模型制品拉取、runtime 生命周期、队列/熔断与 <code>/metrics</code> 等指标，便于运维观测。</li>
                    <li><strong>Native 推理（可选）</strong>：在已支持的权重布局与后端范围内，可由 <code>native</code> runtime 在本进程完成前向与解码；复杂布局与生产吞吐需按文档分层评估，不宜默认等同专用 serving 集群。</li>
                </ul>

                <h4>优势概述</h4>
                <ul>
                    <li><strong>一套 API，多种算力</strong>：同一套兼容面可对接 vLLM、SGLang、Ollama、MLX、OpenAI-compatible 服务或受管 Native，减少业务侧适配成本。</li>
                    <li><strong>编排与治理</strong>：自动调度、路由偏好、审计与轨迹；适合作为企业内「推理中台 + 业务网关」的一层。</li>
                    <li><strong>流式策略清晰</strong>：无 KGM 增强时尽量透传上游；需要图谱/工具/检索时由服务端桥接 SSE，行为与 <code>deployment-and-api.md</code> 描述一致。</li>
                </ul>

                <h4>本地推理集成（对比）</h4>
                <p class="lead">与本地 Ollama 联调时，典型存在两条路径（验证文档中的归纳）：</p>
                <div class="info-modal-compare">
                    <p><strong>模式 A：经 Ollama daemon</strong></p>
                    <p>KGM 将 LLM / Embedding 请求转发至本机 <code>11434</code>（如 <code>/api/chat</code>、<code>/api/embed</code>）。路径成熟、适合日常开发与稳定联调。</p>
                </div>
                <div class="info-modal-compare">
                    <p><strong>模式 B：Native 挂载本地模型目录</strong></p>
                    <p>使用 <code>native</code> runtime 直接挂载如 <code>~/.ollama/models</code> 等本地路径，不依赖 11434 作为 token 生成服务。接入与元数据识别可先行，具体模型能否执行取决于 GGUF 布局是否在 Native 支持范围内；混合架构模型可能需要专门执行器。</p>
                </div>

                <p class="info-modal-doc-hint">详细边界、分层（Canonical / safetensors / GGUF / MLX）与 GPU 工程阶段，请以仓库内 <strong>capabilities.md</strong> 为准。</p>

                <div class="info-modal-legacy">
                    <div class="legacy-title">信任委托维度（原有说明）</div>
                    <ul>
                        <li>(1) 丰富的上下文 API 接口 — 多模态输入构建信息基础</li>
                        <li>(2) 语言模型后端改写 — 信息标准化与结构化</li>
                        <li>(3) 知识图谱补全 — 实体关系与完备性</li>
                        <li>(4) 信任委托机制 — 情景与效用适配</li>
                        <li>(5) 可审计的计算过程 — 透明度与可追溯</li>
                        <li>(6) 信任代理服务 — API 侧自动化决策</li>
                        <li>(7) 上下文丰富性 — 多源融合</li>
                    </ul>
                </div>
            </div>
        `;

        this.showModal();
    }

    showModal() {
        this.modalOverlay.style.display = 'flex';
    }

    hideModal() {
        this.modalOverlay.style.display = 'none';
        if (this.modal) {
            this.modal.classList.remove('modal--wide', 'modal--api-keys');
        }
    }

    loadConfigFromLocalStorage() {
        try {
            const savedConfig = localStorage.getItem('kgmPlaygroundConfig');
            if (savedConfig) {
                this.currentConfig = this.normalizeConfig(JSON.parse(savedConfig));
            }
            if (this.protocolSelect) this.protocolSelect.value = this.currentConfig.protocol || 'chat.completions';
            if (this.streamMode) this.streamMode.checked = this.currentConfig.stream !== false;
            if (this.builtinToolsToggle) this.builtinToolsToggle.checked = this.currentConfig.includeBuiltinTools !== false;
            if (this.serverExecToggle) this.serverExecToggle.checked = this.currentConfig.executeToolCalls !== false;
            this.renderStatusBar();
            this.renderRequestRoutingPreferences();
        } catch (e) {
            console.warn('Failed to load config from localStorage:', e);
        }
    }

    saveConfigToLocalStorage() {
        try {
            localStorage.setItem('kgmPlaygroundConfig', JSON.stringify(this.currentConfig));
            this.renderStatusBar();
            this.renderRequestRoutingPreferences();
        } catch (e) {
            console.error('Failed to save config to localStorage:', e);
        }
    }

    renderStatusBar() {
        if (this.statusService) {
            this.statusService.textContent = this.currentConfig.provider === 'yueli-native' ? 'yueli-native' : 'provider-routed';
        }
        if (this.statusProvider) {
            this.statusProvider.textContent = this.currentConfig.provider === 'yueli-native'
                ? 'Yueli-KGM'
                : (this.currentConfig.provider || this.currentConfig.targetProvider || '自动');
        }
        if (this.statusModel) this.statusModel.textContent = this.currentConfig.modelName || this.currentConfig.targetModel || '自动';
        if (this.statusProtocol) this.statusProtocol.textContent = this.currentConfig.protocol || 'chat.completions';
        if (this.statusStream) this.statusStream.textContent = this.currentConfig.stream !== false ? 'on' : 'off';
        if (this.statusModelPath) this.statusModelPath.textContent = this.currentConfig.nativeModelPath || '未设置';
    }

    renderRequestRoutingPreferences() {
        if (this.requestRoutingProfile) this.requestRoutingProfile.textContent = this.currentConfig.routingProfile || 'quality_first';
        if (this.requestTaskType) this.requestTaskType.textContent = this.currentConfig.taskType || '自动识别';
        if (this.requestTargetProvider) this.requestTargetProvider.textContent = this.currentConfig.targetProvider || this.currentConfig.provider || '自动';
        if (this.requestTargetModel) this.requestTargetModel.textContent = this.currentConfig.targetModel || this.currentConfig.modelName || '自动';
    }

    handleImageUpload(event) {
        const files = Array.from(event.target.files);
        this.mediaFiles.images = files;

        // 清除之前的预览
        this.imagePreview.innerHTML = '';

        files.forEach(file => {
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = document.createElement('img');
                    img.src = e.target.result;
                    img.alt = file.name;
                    img.title = file.name;
                    this.imagePreview.appendChild(img);
                };
                reader.readAsDataURL(file);
            }
        });
    }

    handleAudioUpload(event) {
        const file = event.target.files[0];
        if (file && file.type.startsWith('audio/')) {
            this.mediaFiles.audio = file;
            // 显示文件名
            const fileName = document.createElement('div');
            fileName.textContent = `音频文件: ${file.name}`;
            fileName.style.marginTop = '10px';
            fileName.style.fontSize = '12px';
            fileName.style.color = '#4a5568';
            this.audioUpload.parentNode.appendChild(fileName);
        }
    }

    handleVideoUpload(event) {
        const file = event.target.files[0];
        if (file && file.type.startsWith('video/')) {
            this.mediaFiles.video = file;

            // 创建预览
            this.videoPreview.innerHTML = '';
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            video.controls = true;
            video.style.maxWidth = '200px';
            video.style.maxHeight = '200px';
            this.videoPreview.appendChild(video);
        }
    }

    toggleAudioControls() {
        this.audioControls.style.display = this.audioControls.style.display === 'none' ? 'block' : 'none';
    }

    startRecording() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    this.mediaRecorder = new MediaRecorder(stream);
                    this.audioChunks = [];

                    this.mediaRecorder.ondataavailable = (event) => {
                        this.audioChunks.push(event.data);
                    };

                    this.mediaRecorder.onstop = () => {
                        const audioBlob = new Blob(this.audioChunks, { type: 'audio/wav' });
                        this.mediaFiles.recordedAudio = audioBlob;

                        // 创建音频播放元素
                        const audioUrl = URL.createObjectURL(audioBlob);
                        this.recordedAudio.src = audioUrl;
                        this.recordedAudio.style.display = 'block';
                        
                        // 停止所有音轨
                        stream.getTracks().forEach(track => track.stop());
                    };

                    this.mediaRecorder.start();
                    this.isRecording = true;
                    this.startRecordingBtn.disabled = true;
                    this.stopRecordingBtn.disabled = false;
                })
                .catch(err => {
                    console.error('录音错误:', err);
                    alert('无法访问麦克风，请检查权限设置');
                });
        } else {
            alert('浏览器不支持录音功能');
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.startRecordingBtn.disabled = false;
            this.stopRecordingBtn.disabled = true;
        }
    }

    async handleSubmit() {
        this.setLoadingState(true);

        try {
            this.resetOutputs();
            const endpoint = this.currentConfig.protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
            const requestData = this.buildProtocolRequest();
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.buildPlaygroundAuthHeaders(),
                },
                body: JSON.stringify(requestData)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (this.currentConfig.stream) {
                await this.consumeSseResponse(response, this.currentConfig.protocol);
            } else {
                const result = await response.json();
                this.displayResults(result, this.currentConfig.protocol);
            }
        } catch (error) {
            console.error('提交错误:', error);
            this.showError(error.message);
        } finally {
            this.setLoadingState(false);
        }
    }

    displayResults(result, protocol = this.currentConfig.protocol) {
        if (protocol === 'responses') {
            const text = result.output_text || this.extractResponseMessage(result);
            this.formatAndShowOutput(text || '');
            this.traceOutput.textContent = JSON.stringify({
                id: result.id,
                status: result.status,
                output_count: Array.isArray(result.output) ? result.output.length : 0,
                tool_trace: result.kgm?.tool_trace || [],
                routing: result.kgm?.routing || null
            }, null, 2);
            return;
        }

        const message = result.choices?.[0]?.message || {};
        this.formatAndShowOutput(message.content || '');
        this.traceOutput.textContent = JSON.stringify({
            finish_reason: result.choices?.[0]?.finish_reason,
            tool_calls: message.tool_calls || [],
            tool_trace: result.kgm?.tool_trace || [],
            routing: result.kgm?.routing || null
        }, null, 2);
    }

    switchIntegrationTab(name) {
        if (!name || !this.integrationTabs?.length) {
            return;
        }
        this.integrationTabs.forEach((tab) => {
            const on = tab.dataset.intTab === name;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Object.entries(this.integrationPanels || {}).forEach(([key, el]) => {
            if (!el) {
                return;
            }
            const on = key === name;
            el.hidden = !on;
            el.classList.toggle('active', on);
        });
        const section = document.getElementById('integration-section');
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    async loadPlaygroundFromServer() {
        if (!this.playgroundConfigJson) {
            return;
        }
        try {
            const response = await fetch('/v1/kgm/config');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            this.playgroundConfig = data.playground || {};
            this.playgroundConfigJson.value = JSON.stringify(this.playgroundConfig, null, 2);
        } catch (error) {
            this.playgroundConfigJson.value = `// 加载失败: ${error.message}\n{}`;
        }
    }

    async savePlaygroundToServer() {
        if (!this.playgroundConfigJson) {
            return;
        }
        try {
            const playground = JSON.parse(this.playgroundConfigJson.value || '{}');
            const response = await fetch('/v1/kgm/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playground }),
            });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const data = await response.json();
            this.playgroundConfig = data.playground;
            this.playgroundConfigJson.value = JSON.stringify(this.playgroundConfig, null, 2);
            window.alert('Playground 配置已保存并生效');
        } catch (error) {
            window.alert(`保存失败: ${error.message}`);
        }
    }

    async handleSkillMdImport(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        try {
            const text = await file.text();
            const response = await fetch('/api/kgm/parse-skill-md', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text }),
            });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const parsed = await response.json();
            let pg;
            try {
                pg = JSON.parse(this.playgroundConfigJson.value || '{}');
            } catch {
                pg = {};
            }
            pg.skills = pg.skills || [];
            const id = `skill-${Date.now()}`;
            const name = parsed.name || 'imported_skill';
            pg.skills.push({
                id,
                name,
                description: parsed.description || '',
                steps: [],
                systemPromptAddon: parsed.systemPromptAddon || '',
            });
            pg.activeSkillIds = pg.activeSkillIds || [];
            if (!pg.activeSkillIds.includes(id)) {
                pg.activeSkillIds.push(id);
            }
            this.playgroundConfigJson.value = JSON.stringify(pg, null, 2);
        } catch (error) {
            window.alert(`导入失败: ${error.message}`);
        }
        input.value = '';
    }

    formatAndShowOutput(rawText) {
        if (!this.textOutput) {
            return;
        }
        let pg;
        try {
            pg = JSON.parse(this.playgroundConfigJson?.value || '{}');
        } catch {
            this.textOutput.textContent = rawText ?? '';
            return;
        }
        const templates = pg.outputTemplates || [];
        const tpl = templates.find((t) => t.id === pg.activeOutputTemplateId);
        if (!tpl) {
            this.textOutput.textContent = rawText ?? '';
            return;
        }
        const vars = {
            content: rawText ?? '',
            body: rawText ?? '',
            title: 'KGM Output',
            meta: new Date().toLocaleString('zh-CN'),
        };
        let out = tpl.template;
        out = out.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
            const k = String(key).trim();
            return vars[k] ?? '';
        });
        if (tpl.kind === 'html') {
            this.textOutput.innerHTML = out;
        } else {
            this.textOutput.textContent = out;
        }
    }

    showError(message) {
        this.textOutput.textContent = `错误: ${message}`;
        this.textOutput.style.color = '#e53e3e';
    }

    setLoadingState(loading) {
        this.submitBtn.disabled = loading;
        this.loading.style.display = loading ? 'block' : 'none';
    }

    openVoiceModal() {
        this.voiceTranscriptEdit.value = '';
        this.voiceStatusText.textContent = '点击开始录音';
        this.voiceStatus.classList.remove('recording');
        this.startVoiceRecognitionBtn.style.display = 'flex';
        this.stopVoiceRecognitionBtn.style.display = 'none';
        this.voiceModalOverlay.style.display = 'flex';
        
        if (this.recognition) {
            this.recognition.abort();
            this.recognition = null;
        }
    }

    closeVoiceModal() {
        this.stopVoiceRecognition();
        this.voiceModalOverlay.style.display = 'none';
    }

    startVoiceRecognition() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            alert('浏览器不支持语音识别功能');
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'zh-CN';

        this.recognition.onstart = () => {
            this.voiceStatusText.textContent = '正在聆听...';
            this.voiceStatus.classList.add('recording');
            this.startVoiceRecognitionBtn.style.display = 'none';
            this.stopVoiceRecognitionBtn.style.display = 'flex';
            this.voiceInputBtn.classList.add('recording');
        };

        this.recognition.onresult = (event) => {
            let finalTranscript = '';
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            this.voiceTranscriptEdit.value = finalTranscript + interimTranscript;
        };

        this.recognition.onerror = (event) => {
            console.error('语音识别错误:', event.error);
            this.voiceStatusText.textContent = '语音识别失败: ' + event.error;
            this.voiceStatus.classList.remove('recording');
        };

        this.recognition.onend = () => {
            if (this.voiceStatus.classList.contains('recording')) {
                this.recognition.start();
            }
        };

        this.recognition.start();
    }

    stopVoiceRecognition() {
        if (this.recognition) {
            this.recognition.stop();
            this.recognition = null;
        }
        this.voiceStatusText.textContent = '录音已停止';
        this.voiceStatus.classList.remove('recording');
        this.startVoiceRecognitionBtn.style.display = 'flex';
        this.stopVoiceRecognitionBtn.style.display = 'none';
        this.voiceInputBtn.classList.remove('recording');
    }

    confirmVoiceResult() {
        const transcript = this.voiceTranscriptEdit.value.trim();
        if (transcript) {
            if (this.promptText.value) {
                this.promptText.value += ' ' + transcript;
            } else {
                this.promptText.value = transcript;
            }
        }
        this.closeVoiceModal();
    }

    handleDocumentUpload(event) {
        const files = event.target.files;
        if (files.length > 0) {
            this.handleDocumentFiles(files);
            event.target.value = '';
        }
    }

    handleDocumentFiles(files) {
        const allowedExtensions = ['.pdf', '.doc', '.docx', '.md', '.txt'];

        Array.from(files).forEach(file => {
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            
            if (allowedExtensions.includes(ext)) {
                this.displayDocumentPreview(file);
            } else {
                alert(`不支持的文件格式: ${file.name}。仅支持 PDF/DOC/DOCX/MD/TXT`);
            }
        });
    }

    displayDocumentPreview(file) {
        const docItem = document.createElement('div');
        docItem.className = 'document-item';
        
        const fileIcon = this.getFileIcon(file.name);
        
        docItem.innerHTML = `
            ${fileIcon}
            <span>${file.name}</span>
            <button type="button" class="remove-doc" data-name="${file.name}">×</button>
        `;

        docItem.querySelector('.remove-doc').addEventListener('click', (e) => {
            const name = e.target.dataset.name;
            e.target.closest('.document-item').remove();
        });

        this.documentPreview.appendChild(docItem);
    }

    getFileIcon(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        let color = '#4299e1';
        
        switch(ext) {
            case 'pdf':
                color = '#e53e3e';
                break;
            case 'doc':
            case 'docx':
                color = '#3182ce';
                break;
            case 'md':
                color = '#48bb78';
                break;
            case 'txt':
                color = '#718096';
                break;
        }

        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
        </svg>`;
    }

    handleClear() {
        // 清空所有输入
        this.promptText.value = '';
        if (this.imageUpload) this.imageUpload.value = '';
        if (this.audioUpload) this.audioUpload.value = '';
        if (this.videoUpload) this.videoUpload.value = '';
        
        // 清空预览
        if (this.imagePreview) this.imagePreview.innerHTML = '';
        if (this.videoPreview) this.videoPreview.innerHTML = '';
        if (this.voiceTranscript) this.voiceTranscript.textContent = '';
        
        // 清空文档预览
        if (this.documentPreview) this.documentPreview.innerHTML = '';
        
        // 清空输出
        this.resetOutputs();
        
        // 重置文件引用
        this.mediaFiles = {
            images: [],
            audio: null,
            video: null,
            recordedAudio: null
        };
    }

    buildProtocolRequest() {
        const prompt = this.promptText.value.trim();
        const mediaSummary = this.buildMediaSummary();
        const graphTriples = this.buildGraphTriples(prompt);
        const providerPreference = this.resolveProvider();
        const routing = this.buildRoutingPreference(prompt);
        const metadata = {
            session_id: 'playground-session',
            ...(providerPreference ? { provider_preference: providerPreference } : {}),
            ...(routing.profile ? { routing_profile: routing.profile } : {}),
            ...(routing.taskType ? { task_type: routing.taskType } : {}),
            ...(routing.target?.model ? { target_model: routing.target.model } : {}),
            ...(routing.maxCostPerRequest ? { max_cost_per_request: routing.maxCostPerRequest } : {}),
            ...(routing.verificationExpected ? { verification_expected: true } : {})
        };
        const kgm = {
            capabilities: {
                includeBuiltinTools: this.currentConfig.includeBuiltinTools !== false,
                executeToolCalls: this.currentConfig.executeToolCalls !== false
            },
            graph: {
                enabled: graphTriples.length > 0,
                entities: this.extractEntities(prompt),
                triples: graphTriples
            },
            ...(this.playgroundExtraPrompt?.value?.trim()
                ? { playground: { extraSystemPrompt: this.playgroundExtraPrompt.value.trim() } }
                : {})
        };

        if (this.currentConfig.protocol === 'responses') {
            return {
                model: this.resolveModel(),
                input: prompt + mediaSummary,
                temperature: this.currentConfig.temperature,
                max_output_tokens: this.currentConfig.maxTokens,
                stream: this.currentConfig.stream !== false,
                metadata,
                kgm,
                routing
            };
        }

        return {
            model: this.resolveModel(),
            messages: [
                { role: 'system', content: 'You are the KGM compatibility playground assistant.' },
                { role: 'user', content: prompt + mediaSummary }
            ],
            temperature: this.currentConfig.temperature,
            max_completion_tokens: this.currentConfig.maxTokens,
            stream: this.currentConfig.stream !== false,
            metadata,
            kgm,
            routing
        };
    }

    buildMediaSummary() {
        const parts = [];
        if (this.mediaFiles.images.length > 0) {
            parts.push(`\n[images:${this.mediaFiles.images.map(file => file.name).join(', ')}]`);
        }
        if (this.mediaFiles.audio) {
            parts.push(`\n[audio:${this.mediaFiles.audio.name}]`);
        }
        if (this.mediaFiles.video) {
            parts.push(`\n[video:${this.mediaFiles.video.name}]`);
        }
        if (this.mediaFiles.recordedAudio) {
            parts.push(`\n[recorded_audio]`);
        }
        return parts.join('');
    }

    resolveModel() {
        return this.currentConfig.modelName || undefined;
    }

    resolveProvider() {
        return this.isProviderAlias(this.currentConfig.provider) ? this.currentConfig.provider : undefined;
    }

    buildRoutingPreference(prompt) {
        const profile = this.currentConfig.routingProfile || 'quality_first';
        const targetProvider = this.currentConfig.targetProvider || this.currentConfig.provider || undefined;
        const targetModel = this.currentConfig.targetModel || this.currentConfig.modelName || undefined;
        const maxCost = this.currentConfig.maxCostPerRequest === '' ? undefined : Number(this.currentConfig.maxCostPerRequest);
        return {
            enabled: true,
            profile,
            taskType: this.currentConfig.taskType || undefined,
            verificationExpected: this.shouldExpectVerification(prompt),
            maxCostPerRequest: Number.isFinite(maxCost) ? maxCost : undefined,
            target: {
                ...(targetProvider ? { provider: targetProvider } : {}),
                ...(targetModel ? { model: targetModel } : {})
            }
        };
    }

    shouldExpectVerification(prompt) {
        return /(json|schema|代码|test|assert|结构化|验证|校验|math|equation)/i.test(prompt || this.promptText.value || '');
    }

    normalizeConfig(savedConfig) {
        const normalized = {
            ...this.currentConfig,
            ...savedConfig
        };

        if (!normalized.provider && typeof savedConfig?.model === 'string' && this.isProviderAlias(savedConfig.model)) {
            normalized.provider = savedConfig.model;
        }
        if (!normalized.modelName && typeof savedConfig?.model === 'string' && !this.isProviderAlias(savedConfig.model)) {
            normalized.modelName = savedConfig.model;
        }

        delete normalized.model;
        if (!normalized.apiKeys || typeof normalized.apiKeys !== 'object') {
            normalized.apiKeys = {};
        }
        return normalized;
    }

    isProviderAlias(value) {
        return PROVIDER_ALIASES.includes(value);
    }

    escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    extractEntities(prompt) {
        return Array.from(new Set(
            prompt
                .split(/[^a-zA-Z0-9_\u4e00-\u9fa5]+/)
                .map(token => token.trim())
                .filter(token => token.length >= 2)
                .slice(0, 6)
        ));
    }

    buildGraphTriples(prompt) {
        const entities = this.extractEntities(prompt);
        if (entities.length < 2) {
            return [];
        }
        return entities.slice(0, entities.length - 1).map((entity, index) => ({
            subject: entity,
            predicate: 'related_to',
            object: entities[index + 1]
        }));
    }

    async consumeSseResponse(response, protocol) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Streaming body is unavailable');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        const streamedResult = {
            text: '',
            toolCalls: [],
            completed: null
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            for (const event of events) {
                const line = event.split('\n').find(item => item.startsWith('data: '));
                if (!line) {
                    continue;
                }
                const payload = line.slice(6);
                if (payload === '[DONE]') {
                    continue;
                }
                this.appendStreamEvent(payload);
                const parsed = JSON.parse(payload);
                this.applyStreamEvent(parsed, protocol, streamedResult);
            }
        }

        if (streamedResult.completed) {
            this.displayResults(streamedResult.completed, protocol);
        } else {
            this.formatAndShowOutput(streamedResult.text);
            this.traceOutput.textContent = JSON.stringify({
                tool_calls: streamedResult.toolCalls
            }, null, 2);
        }
    }

    appendStreamEvent(payload) {
        this.streamOutput.textContent += payload + '\n';
        this.streamOutput.scrollTop = this.streamOutput.scrollHeight;
    }

    applyStreamEvent(event, protocol, streamedResult) {
        if (protocol === 'responses') {
            if (event.type === 'response.output_text.delta') {
                streamedResult.text += event.delta || '';
                this.textOutput.textContent = streamedResult.text;
            }
            if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
                streamedResult.toolCalls.push(event.item);
                this.traceOutput.textContent = JSON.stringify({ tool_calls: streamedResult.toolCalls }, null, 2);
            }
            if (event.type === 'response.completed') {
                streamedResult.completed = event.response;
            }
            return;
        }

        const choice = event.choices?.[0];
        if (!choice) {
            return;
        }
        if (choice.delta?.content) {
            streamedResult.text += choice.delta.content;
            this.textOutput.textContent = streamedResult.text;
        }
        if (choice.delta?.tool_calls?.length) {
            streamedResult.toolCalls.push(...choice.delta.tool_calls);
            this.traceOutput.textContent = JSON.stringify({ tool_calls: streamedResult.toolCalls }, null, 2);
        }
        if (choice.finish_reason) {
            streamedResult.completed = {
                id: event.id,
                choices: [{
                    finish_reason: choice.finish_reason,
                    message: {
                        content: streamedResult.text,
                        tool_calls: streamedResult.toolCalls
                    }
                }],
                kgm: event.kgm || {}
            };
        }
    }

    extractResponseMessage(result) {
        const assistantMessage = Array.isArray(result.output)
            ? result.output.find(item => item.type === 'message' && item.role === 'assistant')
            : null;
        const contentPart = assistantMessage?.content?.find(item => item.type === 'output_text');
        return contentPart?.text || '';
    }

    resetOutputs() {
        if (this.textOutput) {
            this.textOutput.textContent = '';
            this.textOutput.style.color = '#334155';
        }
        if (this.streamOutput) this.streamOutput.textContent = '';
        if (this.traceOutput) this.traceOutput.textContent = '';
        if (this.imageOutput) this.imageOutput.innerHTML = '';
        if (this.generatedVideo) {
            this.generatedVideo.style.display = 'none';
            this.generatedVideo.src = '';
        }
        if (this.generatedAudio) {
            this.generatedAudio.style.display = 'none';
            this.generatedAudio.src = '';
        }
    }

    async loadAutoRoutingOverview() {
        try {
            const [configResponse, summaryResponse] = await Promise.all([
                fetch('/v1/kgm/auto-routing'),
                fetch('/v1/kgm/auto-routing/summary?limit=8')
            ]);
            if (!configResponse.ok) {
                throw new Error(`auto routing config status ${configResponse.status}`);
            }
            const config = await configResponse.json();
            const summary = summaryResponse.ok ? await summaryResponse.json() : null;
            this.autoRoutingConfig = config;
            this.autoRoutingSummary = summary;
            this.renderAutoRoutingPanel();
        } catch (error) {
            if (this.routingSummaryCards) {
                this.routingSummaryCards.innerHTML = `<div class="managed-empty">自动调度信息加载失败: ${error.message}</div>`;
            }
        }
    }

    renderAutoRoutingPanel() {
        if (!this.autoRoutingConfig) {
            return;
        }
        this.populateAutoRoutingForm(this.autoRoutingConfig);
        this.renderTaskRoutes(this.autoRoutingConfig.taskRoutes || []);
        this.renderRoutingSummary(this.autoRoutingSummary);
        this.renderRequestRoutingPreferences();
    }

    populateAutoRoutingForm(config) {
        if (this.routingEnabled) this.routingEnabled.checked = config.enabled !== false;
        if (this.routingProfileSelect) this.routingProfileSelect.value = config.defaultProfile || 'quality_first';
        if (this.routingDynamic) this.routingDynamic.checked = config.allowDynamicSelection !== false;
        if (this.routingVerifiable) this.routingVerifiable.checked = config.preferVerifiableTasks !== false;
        if (this.routingMaxCost) this.routingMaxCost.value = String(config.thresholds?.maxCostPerRequest ?? 0.15);
        if (this.routingTargetLatency) this.routingTargetLatency.value = String(config.thresholds?.targetLatencyMs ?? 3500);
        if (this.routingEvalEnabled) this.routingEvalEnabled.checked = config.evaluation?.enabled !== false;
        if (this.routingEvalFallback) this.routingEvalFallback.checked = config.evaluation?.fallbackToHeuristics !== false;
        if (this.routingJudgeEnabled) this.routingJudgeEnabled.checked = config.evaluation?.judge?.enabled !== false;
        if (this.routingJudgeProvider) this.routingJudgeProvider.value = config.evaluation?.judge?.target?.provider || '';
        if (this.routingJudgeModel) this.routingJudgeModel.value = config.evaluation?.judge?.target?.model || '';
        if (this.routingVerifierEnabled) this.routingVerifierEnabled.checked = config.evaluation?.verifier?.enabled !== false;
        if (this.routingVerifierProvider) this.routingVerifierProvider.value = config.evaluation?.verifier?.target?.provider || '';
        if (this.routingVerifierModel) this.routingVerifierModel.value = config.evaluation?.verifier?.target?.model || '';
    }

    renderTaskRoutes(routes) {
        if (!this.taskRouteList) {
            return;
        }
        if (!routes.length) {
            this.taskRouteList.innerHTML = '<div class="managed-empty">暂无任务指定规则。</div>';
            return;
        }
        this.taskRouteList.innerHTML = routes.map((route) => `
            <div class="task-route-item">
                <div class="task-route-header">
                    <strong>${this.escapeHtml(route.name)}</strong>
                    <button data-route-id="${route.id}">删除</button>
                </div>
                <span>taskType: ${this.escapeHtml(route.taskType || 'general')} · priority: ${route.priority}</span>
                <span>target: ${(route.target?.provider || 'default')} / ${(route.target?.model || 'auto')}</span>
                <div class="task-route-tags">
                    ${(route.keywords || []).map((keyword) => `<code>${this.escapeHtml(keyword)}</code>`).join('')}
                </div>
            </div>
        `).join('');
        this.taskRouteList.querySelectorAll('button[data-route-id]').forEach((button) => {
            button.addEventListener('click', () => this.removeTaskRouteRule(button.dataset.routeId));
        });
    }

    renderRoutingSummary(summary) {
        if (!this.routingSummaryCards || !this.routingModelStats || !this.routingRecentAudit) {
            return;
        }
        if (!summary) {
            this.routingSummaryCards.innerHTML = '<div class="managed-empty">暂无审计数据。</div>';
            this.routingModelStats.innerHTML = '';
            this.routingRecentAudit.innerHTML = '';
            return;
        }
        this.routingSummaryCards.innerHTML = `
            <div class="routing-summary-card">
                <span>总请求数</span>
                <strong>${summary.totals?.requests ?? 0}</strong>
            </div>
            <div class="routing-summary-card">
                <span>成功率</span>
                <strong>${this.formatPercent(summary.totals?.successRate ?? 0)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>平均延迟</span>
                <strong>${Math.round(summary.totals?.avgLatencyMs ?? 0)} ms</strong>
            </div>
            <div class="routing-summary-card">
                <span>平均质量</span>
                <strong>${this.formatPercent(summary.totals?.avgQuality ?? 0)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>平均置信度</span>
                <strong>${this.formatPercent(summary.totals?.avgConfidence ?? 0)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>生成成本</span>
                <strong>$${(summary.totals?.actualCost ?? 0).toFixed(4)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>评估成本</span>
                <strong>$${(summary.totals?.evaluationCost ?? 0).toFixed(4)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>总成本</span>
                <strong>$${(summary.totals?.totalCost ?? 0).toFixed(4)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>总 Tokens</span>
                <strong>${summary.totals?.totalTokens ?? 0}</strong>
            </div>
            <div class="routing-summary-card">
                <span>Judge / Verifier</span>
                <strong>${summary.totals?.judgeRuns ?? 0} / ${summary.totals?.verifierRuns ?? 0}</strong>
            </div>
        `;
        const byModel = summary.byModel || [];
        this.routingModelStats.innerHTML = byModel.length
            ? byModel.map((item) => `
                <div class="routing-table-row">
                    <div class="routing-table-header">
                        <strong>${this.escapeHtml(item.label || item.model)}</strong>
                        <span>${this.escapeHtml(item.source || 'default')}</span>
                    </div>
                    <span>requests: ${item.requestCount} · success: ${this.formatPercent(item.successRate)}</span>
                    <span>latency: ${Math.round(item.avgLatencyMs || 0)} ms · gen cost: $${(item.avgCost || 0).toFixed(4)} · eval cost: $${(item.avgEvaluationCost || 0).toFixed(4)}</span>
                    <span>quality: ${this.formatPercent(item.avgQuality || 0)} · confidence: ${this.formatPercent(item.avgConfidence || 0)} · judge: ${this.formatPercent(item.avgJudgeScore || 0)}</span>
                    <span>judge run: ${this.formatPercent(item.judgeRunRate || 0)} · verifier run: ${this.formatPercent(item.verifierRunRate || 0)} · verifier pass: ${this.formatPercent(item.verificationPassRate || 0)}</span>
                </div>
            `).join('')
            : '<div class="managed-empty">暂无模型层统计。</div>';

        const recent = summary.recent || [];
        this.routingRecentAudit.innerHTML = recent.length
            ? recent.map((item) => `
                <div class="routing-audit-item">
                    <div class="routing-audit-header">
                        <strong>${this.escapeHtml(item.taskType)}</strong>
                        <span>${this.escapeHtml(item.profile)}</span>
                    </div>
                    <span>${this.escapeHtml(item.selected?.label || item.selected?.model || 'unknown')}</span>
                    <span>success: ${item.success ? 'yes' : 'no'} · latency: ${Math.round(item.latencyMs || 0)} ms · gen: $${(item.actualCost || 0).toFixed(4)} · eval: $${(item.evaluationCost || 0).toFixed(4)} · total: $${(item.totalCost || 0).toFixed(4)}</span>
                    <span>quality: ${this.formatPercent(item.qualityScore || 0)} · confidence: ${this.formatPercent(item.confidence || 0)} · source: ${this.escapeHtml(item.evaluation?.qualitySource || 'heuristic')}</span>
                    <span>judge: ${this.formatPercent(item.evaluation?.judge?.score || 0)} · verifier: ${item.evaluation?.verifier?.attempted ? (item.evaluation?.verifier?.passed ? 'pass' : 'fail') : 'n/a'} · eval tokens: ${item.evaluationTotalTokens || 0}</span>
                    <span>${this.escapeHtml(item.inputPreview || '')}</span>
                </div>
            `).join('')
            : '<div class="managed-empty">暂无最近审计。</div>';
    }

    async saveAutoRoutingConfig() {
        const judgeTarget = {
            ...(this.autoRoutingConfig?.evaluation?.judge?.target || {}),
            provider: this.routingJudgeProvider?.value.trim() || undefined,
            model: this.routingJudgeModel?.value.trim() || undefined
        };
        const verifierTarget = {
            ...(this.autoRoutingConfig?.evaluation?.verifier?.target || {}),
            provider: this.routingVerifierProvider?.value.trim() || undefined,
            model: this.routingVerifierModel?.value.trim() || undefined
        };
        const next = {
            ...(this.autoRoutingConfig || {}),
            enabled: this.routingEnabled?.checked !== false,
            defaultProfile: this.routingProfileSelect?.value || 'quality_first',
            allowDynamicSelection: this.routingDynamic?.checked !== false,
            preferVerifiableTasks: this.routingVerifiable?.checked !== false,
            thresholds: {
                ...(this.autoRoutingConfig?.thresholds || {}),
                maxCostPerRequest: Number(this.routingMaxCost?.value || this.autoRoutingConfig?.thresholds?.maxCostPerRequest || 0.15),
                targetLatencyMs: Number(this.routingTargetLatency?.value || this.autoRoutingConfig?.thresholds?.targetLatencyMs || 3500)
            },
            evaluation: {
                ...(this.autoRoutingConfig?.evaluation || {}),
                enabled: this.routingEvalEnabled?.checked !== false,
                fallbackToHeuristics: this.routingEvalFallback?.checked !== false,
                judge: {
                    ...(this.autoRoutingConfig?.evaluation?.judge || {}),
                    enabled: this.routingJudgeEnabled?.checked !== false,
                    target: judgeTarget
                },
                verifier: {
                    ...(this.autoRoutingConfig?.evaluation?.verifier || {}),
                    enabled: this.routingVerifierEnabled?.checked !== false,
                    target: verifierTarget
                }
            },
            taskRoutes: this.autoRoutingConfig?.taskRoutes || []
        };
        const response = await fetch('/v1/kgm/auto-routing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next)
        });
        if (!response.ok) {
            throw new Error(`save auto routing failed: ${response.status}`);
        }
        this.autoRoutingConfig = await response.json();
        await this.loadAutoRoutingOverview();
    }

    addTaskRouteRule() {
        if (!this.autoRoutingConfig) {
            return;
        }
        const name = this.routeRuleName?.value.trim();
        const model = this.routeRuleModel?.value.trim();
        if (!name || !model) {
            alert('规则名和模型名不能为空');
            return;
        }
        const keywords = (this.routeRuleKeywords?.value || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        const route = {
            id: `route_${Date.now()}`,
            name,
            enabled: true,
            priority: Number(this.routeRulePriority?.value || 50),
            taskType: this.routeRuleTaskType?.value || 'general',
            keywords,
            target: {
                provider: this.routeRuleProvider?.value.trim() || undefined,
                model
            }
        };
        this.autoRoutingConfig.taskRoutes = [...(this.autoRoutingConfig.taskRoutes || []), route]
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));
        this.renderTaskRoutes(this.autoRoutingConfig.taskRoutes);
        this.routeRuleName.value = '';
        this.routeRuleKeywords.value = '';
        this.routeRuleProvider.value = '';
        this.routeRuleModel.value = '';
        this.routeRulePriority.value = '50';
    }

    removeTaskRouteRule(id) {
        if (!this.autoRoutingConfig) {
            return;
        }
        this.autoRoutingConfig.taskRoutes = (this.autoRoutingConfig.taskRoutes || []).filter((item) => item.id !== id);
        this.renderTaskRoutes(this.autoRoutingConfig.taskRoutes);
    }

    formatPercent(value) {
        return `${Math.round((Number(value) || 0) * 100)}%`;
    }

    async loadManagedModels() {
        try {
            const [artifactResponse, runtimeResponse, summaryResponse] = await Promise.all([
                fetch('/v1/kgm/models/artifacts'),
                fetch('/v1/kgm/models/runtimes'),
                fetch('/v1/kgm/models')
            ]);
            if (!artifactResponse.ok) {
                throw new Error(`artifact status ${artifactResponse.status}`);
            }
            if (!runtimeResponse.ok) {
                throw new Error(`runtime status ${runtimeResponse.status}`);
            }
            if (!summaryResponse.ok) {
                throw new Error(`model summary status ${summaryResponse.status}`);
            }
            const artifactPayload = await artifactResponse.json();
            const runtimePayload = await runtimeResponse.json();
            const summaryPayload = await summaryResponse.json();
            this.modelArtifacts = artifactPayload.artifacts || [];
            this.modelRuntimes = runtimePayload.runtimes || [];
            this.modelSummaries = summaryPayload.models || [];
            this.maybeBackfillNativeRuntimeSelection();
            this.renderManagedModels();
        } catch (error) {
            if (this.modelArtifactList) {
                this.modelArtifactList.innerHTML = `<div class="managed-empty">模型列表加载失败: ${error.message}</div>`;
            }
        }
    }

    renderManagedModels() {
        this.renderArtifactOptions();
        this.renderArtifacts();
    }

    renderArtifactOptions() {
        if (!this.runtimeArtifactSelect) {
            return;
        }
        const selected = this.runtimeArtifactSelect.value;
        this.runtimeArtifactSelect.innerHTML = ['<option value="">选择已拉取模型</option>']
            .concat(this.modelArtifacts.map((artifact) => `<option value="${artifact.id}">${artifact.name} · ${artifact.sourceType} · ${(artifact.runtimeHints || []).join('/') || 'n/a'} · ${artifact.status}</option>`))
            .join('');
        if (selected && this.modelArtifacts.some(item => item.id === selected)) {
            this.runtimeArtifactSelect.value = selected;
        }
    }

    renderArtifacts() {
        if (!this.modelArtifactList) {
            return;
        }
        if (!this.modelArtifacts.length) {
            this.modelArtifactList.innerHTML = '<div class="managed-empty">暂无已管理模型。</div>';
            return;
        }
        this.modelArtifactList.innerHTML = this.modelArtifacts.map((artifact) => `
            <article class="managed-card">
                <header>
                    <div>
                        <h3>${artifact.name}</h3>
                        <div class="managed-meta">${artifact.modelName} · ${artifact.sourceType}</div>
                    </div>
                    <span class="managed-status ${artifact.status}">${artifact.status}</span>
                </header>
                <div class="managed-meta">${artifact.sourceRef}</div>
                <div class="managed-meta">${artifact.localPath || artifact.downloadUrl || 'repo reference only'}</div>
                <div class="managed-meta">Runtime hints: ${(artifact.runtimeHints || []).join(', ') || 'n/a'}</div>
                <div class="managed-notes">${(artifact.notes || []).join('\n')}</div>
            </article>
        `).join('');
    }

    async pullManagedModel() {
        const payload = {
            sourceType: this.modelSourceType?.value || 'huggingface',
            sourceUrl: this.modelSourceUrl?.value?.trim(),
            filePath: this.modelFilePath?.value?.trim() || undefined,
            revision: this.modelRevision?.value?.trim() || undefined,
            modelName: this.modelNameInput?.value?.trim() || undefined
        };
        if (!payload.sourceUrl) {
            throw new Error(payload.sourceType === 'local' ? '请先填写本地模型绝对路径' : '请先填写源 URL / 引用');
        }
        if (payload.sourceType === 'local' && !this.isAbsolutePath(payload.sourceUrl)) {
            throw new Error('本地模型路径必须是绝对路径或 file:// URL');
        }
        if (payload.sourceType === 'local' && this.isLikelyOllamaStorePath(payload.sourceUrl) && !payload.modelName) {
            throw new Error('使用 Ollama store 根目录时，请填写模型名，值应为实际 Ollama 模型引用，例如 qwen3.5:latest');
        }
        const response = await fetch('/v1/kgm/models/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`pull model failed: ${response.status} ${text}`);
        }
        await this.loadManagedModels();
    }

    updateManagedModelSourcePlaceholder() {
        if (!this.modelSourceType || !this.modelSourceUrl || !this.modelFilePath) {
            return;
        }
        if (this.modelSourceType.value === 'local') {
            this.modelSourceUrl.placeholder = '/absolute/path/to/model.gguf 或 /absolute/path/to/model-dir';
            this.modelFilePath.placeholder = '可留空，默认使用路径中的文件名';
            return;
        }
        this.modelSourceUrl.placeholder = '例如 https://huggingface.co/Qwen/Qwen2.5-7B-Instruct 或 ollama://qwen2.5:7b';
        this.modelFilePath.placeholder = '例如 model.gguf 或 model.safetensors';
    }

    maybeBackfillNativeRuntimeSelection() {
        if (this.currentConfig.provider !== 'yueli-native') {
            return;
        }
        const matchingRuntime = this.modelRuntimes.find((runtime) =>
            runtime.runtime === 'native' &&
            runtime.modelName === this.currentConfig.modelName
        );
        if (matchingRuntime) {
            this.currentConfig.nativeRuntimeId = matchingRuntime.id;
        }
    }

    async ensureNativeRuntimeConfigured({ modelPath, modelName }) {
        const resolvedPath = (modelPath || '').trim();
        if (!resolvedPath) {
            throw new Error('请选择或填写本地模型绝对路径');
        }
        if (!this.isAbsolutePath(resolvedPath)) {
            throw new Error('本地模型路径必须是绝对路径或 file:// URL');
        }

        await this.loadManagedModels();

        let artifact = this.modelArtifacts.find((item) =>
            item.sourceType === 'local' && item.localPath === resolvedPath
        );
        if (!artifact) {
            const pullPayload = await this.fetchJson('/v1/kgm/models/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sourceType: 'local',
                    sourceUrl: resolvedPath,
                    modelName: modelName || undefined,
                })
            });
            artifact = pullPayload.artifact;
            await this.loadManagedModels();
        }

        const runtimeModelName = (modelName || artifact.modelName || artifact.name || 'native-local-model').trim();
        let runtime = this.modelRuntimes.find((item) =>
            item.runtime === 'native' &&
            item.artifactId === artifact.id &&
            item.modelName === runtimeModelName
        );

        if (!runtime) {
            const runtimePayload = await this.fetchJson('/v1/kgm/models/runtimes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    artifactId: artifact.id,
                    runtime: 'native',
                    modelName: runtimeModelName,
                })
            });
            runtime = runtimePayload.runtime;
            await this.loadManagedModels();
        }

        if (runtime.status !== 'running') {
            await this.fetchJson(`/v1/kgm/models/runtimes/${runtime.id}/start`, {
                method: 'POST'
            });
            await this.loadManagedModels();
            runtime = this.modelRuntimes.find((item) => item.id === runtime.id) || runtime;
        }

        return {
            runtimeId: runtime.id,
            modelName: runtime.modelName,
            artifactId: artifact.id,
        };
    }

    async getNativeDefaults() {
        if (this.nativeDefaults) {
            return this.nativeDefaults;
        }
        this.nativeDefaults = await this.fetchJson('/api/kgm/native-runtime/defaults');
        return this.nativeDefaults;
    }

    async togglePathBrowser(browserEl, inputEl) {
        if (!browserEl || !inputEl) {
            return;
        }
        const defaults = await this.getNativeDefaults();
        const targetPath = inputEl.value.trim() || defaults.defaultModelPath || defaults.ollamaModelDirs?.[0] || defaults.cwd || defaults.homeDir;
        await this.renderPathBrowser(browserEl, inputEl, targetPath);
    }

    async renderPathBrowser(browserEl, inputEl, targetPath) {
        const payload = await this.fetchJson(`/api/kgm/filesystem/list?path=${encodeURIComponent(targetPath)}`);
        browserEl.style.display = 'flex';
        browserEl.innerHTML = `
            <div class="path-browser-header">
                <div class="path-browser-current">${this.escapeHtml(payload.currentPath)}</div>
                <div class="path-field-row">
                    ${payload.parentPath ? '<button type="button" class="secondary-config-btn" data-path-action="up">上一级</button>' : ''}
                    <button type="button" class="secondary-config-btn" data-path-action="select-dir">选择当前目录</button>
                </div>
            </div>
            <div class="path-browser-list">
                ${payload.items.map((item) => `
                    <div class="path-browser-item">
                        <div>
                            <strong>${this.escapeHtml(item.name)}</strong>
                            <span>${item.type === 'directory' ? '目录' : this.escapeHtml(item.path)}</span>
                        </div>
                        <button type="button" data-item-path="${this.escapeHtml(item.path)}" data-item-type="${item.type}">
                            ${item.type === 'directory' ? '打开' : '选择'}
                        </button>
                    </div>
                `).join('')}
            </div>
        `;

        browserEl.querySelector('[data-path-action="up"]')?.addEventListener('click', () => {
            this.renderPathBrowser(browserEl, inputEl, payload.parentPath).catch((error) => this.showError(error.message));
        });
        browserEl.querySelector('[data-path-action="select-dir"]')?.addEventListener('click', () => {
            inputEl.value = payload.currentPath;
        });
        browserEl.querySelectorAll('button[data-item-path]').forEach((button) => {
            button.addEventListener('click', () => {
                const itemPath = button.dataset.itemPath;
                if (button.dataset.itemType === 'directory') {
                    this.renderPathBrowser(browserEl, inputEl, itemPath).catch((error) => this.showError(error.message));
                    return;
                }
                inputEl.value = itemPath;
            });
        });
    }

    async fetchJson(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
        }
        return response.json();
    }

    isAbsolutePath(value) {
        return typeof value === 'string' && (
            value.startsWith('/') ||
            value.startsWith('file://') ||
            /^[A-Za-z]:[\\/]/.test(value)
        );
    }

    isLikelyOllamaStorePath(value) {
        return typeof value === 'string' && (
            value.includes('/.ollama/models') ||
            value.endsWith('/ollama/models') ||
            value.endsWith('\\ollama\\models')
        );
    }
}

const PROVIDER_ALIASES = ['openai', 'zhipu', 'minimax', 'openrouter', 'nvidia', 'deepseek', 'ollama', 'vllm', 'sglang', 'custom'];

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new KGMTrustProxyPlayground();
    
    // 支持拖拽上传图片
    const dropArea = document.querySelector('.media-item:first-child'); // 图片上传区域
    
    if (dropArea) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropArea.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        ['dragenter', 'dragover'].forEach(eventName => {
            dropArea.addEventListener(eventName, highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropArea.addEventListener(eventName, unhighlight, false);
        });

        function highlight(e) {
            dropArea.style.borderColor = '#4299e1';
            dropArea.style.backgroundColor = '#ebf8ff';
        }

        function unhighlight(e) {
            dropArea.style.borderColor = '#e2e8f0';
            dropArea.style.backgroundColor = '#f8fafc';
        }

        dropArea.addEventListener('drop', handleDrop, false);

        function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            
            // 创建一个临时的input元素来触发文件处理
            const tempInput = document.createElement('input');
            tempInput.type = 'file';
            tempInput.style.display = 'none';
            tempInput.files = files;
            tempInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
});
