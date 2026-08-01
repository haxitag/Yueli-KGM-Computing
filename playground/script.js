// KGM-Computing Playground 前端脚本 - 信任委托与代理API

/**
 * 本机推理：浏览器凭证统一主键为 `apiKeys.localhost`（及 localhost_2/3）。
 * 服务模式为这些类型时，Bearer 优先读 localhost，再回退到各引擎独立旧键（兼容老配置）。
 */
const LOCALHOST_BEARER_PROVIDERS = new Set([
    'ollama',
    'vllm',
    'sglang',
    'koboldcpp',
    'text_generation_webui',
    'lmstudio',
    'vmlx',
    'ds4',
    'llama_cpp',
]);

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
            maxCostPerRequest: '',
            exchangeRate: 6.82, // 默认汇率: 1 USD = 6.82 CNY
            yueliGateway: {
                host: 'https://www.yueli.com',
                upstreamPrefix: '/api',
                enabled: true,
            },
        };
        this.loadConfigFromLocalStorage();
        this.renderStatusBar();
        this.loadManagedModels();
        this.refreshSandboxHowtoStatus();
        this.playgroundConfig = null;
        this.activeWorkspace = 'chat';
        this.activeIntegrationTab = null;
        this.activeOutputTab = 'text';
        this.loadServerConfigBundle();
        this.switchWorkspace('chat');

        // 初始化 KCE 任务管理器
        this.taskManager = new KCETaskManager(this);

        window.setInterval(() => this.loadManagedModels(), 20000);
        window.setInterval(() => {
            if (this.activeWorkspace === 'routing') {
                this.loadAutoRoutingOverview();
            }
        }, 25000);
    }

    initializeElements() {
        // 顶部菜单元素
        this.modelSelectBtn = document.getElementById('model-select-btn');
        this.modelConfigBtn = document.getElementById('model-config-btn');
        this.routingPrefsBtn = document.getElementById('routing-prefs-btn');
        this.pricingConfigBtn = document.getElementById('pricing-config-btn');
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
        this.statusRouting = document.getElementById('status-routing');
        this.statusGateway = document.getElementById('status-gateway');
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
        this.routingDynamic = document.getElementById('routing-allow-dynamic');
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
        this.integrationSubnav = document.getElementById('integration-subnav');
        this.integrationPanels = {
            tasks: document.getElementById('int-panel-tasks'),
            skills: document.getElementById('int-panel-skills'),
            mcp: document.getElementById('int-panel-mcp'),
            output: document.getElementById('int-panel-output'),
        };
        this.workspaceTabs = document.querySelectorAll('.nav-item[data-workspace]');
        this.workspaceViews = {
            chat: document.getElementById('workspace-chat'),
            routing: document.getElementById('workspace-routing'),
            models: document.getElementById('workspace-models'),
            config: document.getElementById('workspace-config'),
            memory: document.getElementById('workspace-memory'),
            ops: document.getElementById('workspace-ops'),
            integration: document.getElementById('workspace-integration'),
        };
        this.opsSubnav = document.getElementById('ops-subnav');
        this.routingMaxCandidates = document.getElementById('routing-max-candidates');
        this.routingAuditEnabled = document.getElementById('routing-audit-enabled');
        this.routingHealthPanel = document.getElementById('routing-health-panel');
        this.routingWeightInputs = {
            successRate: document.getElementById('routing-weight-success'),
            quality: document.getElementById('routing-weight-quality'),
            latency: document.getElementById('routing-weight-latency'),
            cost: document.getElementById('routing-weight-cost'),
            trust: document.getElementById('routing-weight-trust'),
            verification: document.getElementById('routing-weight-verification'),
        };
        this.outputTabs = document.querySelectorAll('.output-tab[data-output-tab]');
        this.outputPanels = document.querySelectorAll('.output-tab-panel[data-output-panel]');
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
        if (this.routingPrefsBtn) {
            this.routingPrefsBtn.addEventListener('click', () => this.showAutoRoutingModal());
        }
        this.pricingConfigBtn.addEventListener('click', () => this.showPricingConfigModal());
        this.apiKeysBtn.addEventListener('click', () => this.showApiKeysModal());
        this.infoBtn.addEventListener('click', () => this.showInfoModal());
        this.closeModalBtn.addEventListener('click', () => this.hideModal());
        this.modalOverlay.addEventListener('click', (e) => {
            if (e.target === this.modalOverlay) {
                this.hideModal();
            }
        });
        
        // 键盘快捷键支持
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter 提交
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.submitBtn && !this.submitBtn.disabled) {
                    this.submitBtn.click();
                }
            }
            // Ctrl/Cmd + K 清空输入
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                if (this.clearBtn) {
                    this.clearBtn.click();
                }
            }
            // Ctrl/Cmd + 1-7 切换工作区
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key >= '1' && e.key <= '7') {
                e.preventDefault();
                const workspaces = ['chat', 'routing', 'models', 'integration', 'ops', 'memory', 'config'];
                const index = parseInt(e.key, 10) - 1;
                if (workspaces[index]) {
                    this.switchWorkspace(workspaces[index]);
                }
            }
            // Ctrl/Cmd + Shift + 1-4 切换集成子 Tab（需在集成工作区）
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key >= '1' && e.key <= '4') {
                e.preventDefault();
                const tabs = ['tasks', 'skills', 'mcp', 'output'];
                const index = parseInt(e.key, 10) - 1;
                if (tabs[index]) {
                    this.switchWorkspace('integration');
                    this.switchIntegrationTab(tabs[index]);
                }
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
                tab.addEventListener('click', () => {
                    this.switchWorkspace('integration');
                    this.switchIntegrationTab(tab.dataset.intTab);
                });
                tab.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.switchWorkspace('integration');
                        this.switchIntegrationTab(tab.dataset.intTab);
                    }
                });
            });
        }
        if (this.workspaceTabs?.length) {
            this.workspaceTabs.forEach((tab) => {
                tab.addEventListener('click', () => this.switchWorkspace(tab.dataset.workspace));
                tab.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.switchWorkspace(tab.dataset.workspace);
                    }
                });
            });
        }
        if (this.outputTabs?.length) {
            this.outputTabs.forEach((tab) => {
                tab.addEventListener('click', () => this.switchOutputTab(tab.dataset.outputTab));
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
        const sel = (v) => (this.currentConfig.provider === v ? 'selected' : '');
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
                        <optgroup label="阅粒 · 云端聚合">
                            <option value="yueli-cloud" ${sel('yueli-cloud')}>阅粒云端推理聚合 (YueliAI v1)</option>
                        </optgroup>
                        <optgroup label="云端 · 专用适配">
                            <option value="openai" ${sel('openai')}>OpenAI</option>
                            <option value="zhipu" ${sel('zhipu')}>智谱 AI</option>
                            <option value="minimax" ${sel('minimax')}>Minimax</option>
                            <option value="openrouter" ${sel('openrouter')}>OpenRouter</option>
                            <option value="nvidia" ${sel('nvidia')}>NVIDIA NIM</option>
                            <option value="deepseek" ${sel('deepseek')}>DeepSeek</option>
                            <option value="xiaomi" ${sel('xiaomi')}>小米 MiMo</option>
                            <option value="gemini" ${sel('gemini')}>Google Gemini</option>
                            <option value="anthropic" ${sel('anthropic')}>Anthropic Claude</option>
                            <option value="aliyun" ${sel('aliyun')}>阿里云（专用适配）</option>
                            <option value="modelscope" ${sel('modelscope')}>ModelScope</option>
                            <option value="moonshot" ${sel('moonshot')}>Moonshot 月之暗面</option>
                        </optgroup>
                        <optgroup label="国内 · OpenAI 兼容">
                            <option value="aliyun_bailian" ${sel('aliyun_bailian')}>阿里百炼（兼容模式）</option>
                            <option value="baidu_qianfan" ${sel('baidu_qianfan')}>百度千帆</option>
                            <option value="volcengine_ark" ${sel('volcengine_ark')}>火山方舟</option>
                        </optgroup>
                        <optgroup label="国际 · OpenAI 兼容">
                            <option value="groq" ${sel('groq')}>Groq</option>
                            <option value="together" ${sel('together')}>Together AI</option>
                            <option value="fireworks" ${sel('fireworks')}>Fireworks</option>
                            <option value="perplexity" ${sel('perplexity')}>Perplexity</option>
                            <option value="mistral" ${sel('mistral')}>Mistral</option>
                            <option value="huggingface" ${sel('huggingface')}>Hugging Face（OpenAI 兼容入口）</option>
                            <option value="azure_openai" ${sel('azure_openai')}>Azure OpenAI</option>
                            <option value="aws_bedrock" ${sel('aws_bedrock')}>AWS Bedrock（经 OpenAI 网关）</option>
                        </optgroup>
                        <optgroup label="本地 (localhost) · 本机推理">
                            <option value="yueli-native" ${isNative ? 'selected' : ''}>Yueli-KGM 本地</option>
                            <option value="ds4" ${sel('ds4')}>ds4（DeepSeek V4 / GLM）</option>
                            <option value="llama_cpp" ${sel('llama_cpp')}>llama.cpp</option>
                            <option value="ollama" ${sel('ollama')}>Ollama</option>
                            <option value="vllm" ${sel('vllm')}>vLLM</option>
                            <option value="sglang" ${sel('sglang')}>SGLang</option>
                            <option value="lmstudio" ${sel('lmstudio')}>LM Studio</option>
                            <option value="vmlx" ${sel('vmlx')}>vMLX / MLX 本地服务</option>
                            <option value="koboldcpp" ${sel('koboldcpp')}>KoboldCpp</option>
                            <option value="text_generation_webui" ${sel('text_generation_webui')}>Text Gen WebUI (oobabooga)</option>
                        </optgroup>
                        <option value="custom" ${sel('custom')}>自定义（OpenAI 兼容）</option>
                    </select>
                </div>
                <div class="form-group" id="modal-provider-help" ${isNative ? 'style="display:none;"' : ''}>
                    <span class="helper-text">第三方模式下请填写要透传给 <code>/v1/*</code> 的模型名。<code>aws_bedrock</code> / <code>azure_openai</code> / <code>huggingface</code> 需在服务端配置 OpenAI 兼容根 URL（见 <code>docs/deployment-and-api.md</code>）。</span>
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
                    
                    <!-- vMLX (Apple MLX) 配置 -->
                    <div class="vmlx-config-section" style="margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 8px;">
                        <label style="font-weight: 600; color: #333;">🍎 Apple Silicon (MLX) 优化配置</label>
                        <div class="helper-text" style="margin-bottom: 8px;">针对 Mac M1/M2/M3/M4 系列芯片的 MLX 推理优化</div>
                        
                        <div class="form-row" style="display: flex; gap: 12px; margin-top: 8px;">
                            <label class="option-field" style="flex: 1;">
                                <span>量化格式</span>
                                <select id="modal-mlx-quantization">
                                    <option value="f16" selected>FP16 (推荐)</option>
                                    <option value="bf16">BF16 (M2+ 推荐)</option>
                                    <option value="q8_0">Q8_0 (8-bit)</option>
                                    <option value="q4_0">Q4_0 (4-bit 最小)</option>
                                    <option value="q4_1">Q4_1 (4-bit 高精度)</option>
                                    <option value="f32">FP32 (全精度)</option>
                                </select>
                            </label>
                            <label class="option-field" style="flex: 1;">
                                <span>最大序列长度</span>
                                <input type="number" id="modal-mlx-max-seq-len" value="4096" min="512" max="131072" step="512">
                            </label>
                        </div>
                        
                        <div class="form-row" style="display: flex; gap: 12px; margin-top: 8px;">
                            <label class="option-field checkbox-field" style="flex: 1;">
                                <input type="checkbox" id="modal-mlx-prefix-cache" checked>
                                <span>启用前缀缓存</span>
                            </label>
                            <label class="option-field checkbox-field" style="flex: 1;">
                                <input type="checkbox" id="modal-mlx-kv-quant">
                                <span>KV缓存量化</span>
                            </label>
                        </div>
                        
                        <div class="mlx-model-hints" id="modal-mlx-model-hints" style="margin-top: 8px; font-size: 12px; color: #666;">
                            💡 推荐从 <a href="https://huggingface.co/mlx-community" target="_blank">mlx-community</a> 下载预量化模型
                        </div>
                    </div>
                    
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
                    
                    // 保存 vMLX 配置
                    const mlxQuantization = document.getElementById('modal-mlx-quantization')?.value || 'f16';
                    const mlxMaxSeqLen = parseInt(document.getElementById('modal-mlx-max-seq-len')?.value || '4096', 10);
                    const mlxPrefixCache = document.getElementById('modal-mlx-prefix-cache')?.checked ?? true;
                    const mlxKvQuant = document.getElementById('modal-mlx-kv-quant')?.checked ?? false;
                    
                    this.currentConfig.mlxConfig = {
                        quantization: mlxQuantization,
                        maxSeqLen: mlxMaxSeqLen,
                        enablePrefixCache: mlxPrefixCache,
                        enableKvCacheQuant: mlxKvQuant,
                    };
                    
                    if (this.isLikelyOllamaStorePath(this.currentConfig.nativeModelPath) && !requestedModelName) {
                        throw new Error('使用 Ollama store 根目录时，请在“模型名 / Runtime 名称”里填写实际 Ollama 模型引用，例如 qwen3.5:latest');
                    }
                    const applied = await this.ensureNativeRuntimeConfigured({
                        modelPath: this.currentConfig.nativeModelPath,
                        modelName: requestedModelName,
                        mlxConfig: this.currentConfig.mlxConfig,
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
                    <label for="modal-max-cost-routing">成本上限 (USD/CNY):</label>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <div style="flex: 1;">
                            <input type="number" id="modal-max-cost-routing" min="0" step="0.00000001" value="${this.escapeHtml(this.currentConfig.maxCostPerRequest || '')}" placeholder="USD">
                            <small style="color: #2563eb;">USD</small>
                        </div>
                        <span style="color: #666;">≈</span>
                        <div style="flex: 1;">
                            <input type="text" id="modal-max-cost-routing-cny" readonly style="background: #f5f5f5; color: #dc2626;" 
                                value="${this.currentConfig.maxCostPerRequest ? (parseFloat(this.currentConfig.maxCostPerRequest) * (this.currentConfig.exchangeRate || 6.82)).toFixed(8) : ''}">
                            <small style="color: #dc2626;">CNY</small>
                        </div>
                    </div>
                    <span class="helper-text">汇率: 1 USD = ${this.currentConfig.exchangeRate || 6.82} CNY</span>
                </div>
                <button class="save-config-btn" id="save-auto-routing-preference">保存偏好</button>
            </div>
        `;

        // USD 输入实时计算 CNY
        const usdInput = document.getElementById('modal-max-cost-routing');
        const cnyInput = document.getElementById('modal-max-cost-routing-cny');
        const rate = this.currentConfig.exchangeRate || 6.82;
        
        usdInput.addEventListener('input', (e) => {
            const usdVal = parseFloat(e.target.value) || 0;
            cnyInput.value = (usdVal * rate).toFixed(8);
        });

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

    showPricingConfigModal() {
        this.modalTitle.textContent = '云端模型价格配置';
        if (this.modal) {
            this.modal.classList.add('modal--wide');
        }

        // 云端模型列表（与后端 DEFAULT_CLOUD_PRICING 对齐）
        const cloudModels = [
            { id: 'gpt-5.4', provider: 'OpenAI', defaults: { input: 0.005, output: 0.015 } },
            { id: 'gpt-5.5', provider: 'OpenAI', defaults: { input: 0.01, output: 0.03 } },
            { id: 'gpt-oss', provider: 'OpenAI', defaults: { input: 0.002, output: 0.006 } },
            // GLM 系列
            { id: 'glm-4-9b', provider: '智谱', defaults: { input: 0.0003, output: 0.0003 } },
            { id: 'glm-4-32b', provider: '智谱', defaults: { input: 0.0005, output: 0.0005 } },
            { id: 'glm-5.0', provider: '智谱', defaults: { input: 0.0005, output: 0.0005 } },
            { id: 'glm-5.1', provider: '智谱', defaults: { input: 0.001, output: 0.001 } },
            // GLM-4V (多模态)
            { id: 'glm-4v-9b', provider: '智谱', defaults: { input: 0.0005, output: 0.0005 } },
            // MiMo 系列 (小米云端 OpenAPI V2.5 — https://mimo.mi.com)
            { id: 'mimo-v2.5-pro', provider: '小米', defaults: { input: 0.000435, output: 0.00087 } },
            { id: 'mimo-v2.5', provider: '小米', defaults: { input: 0.00014, output: 0.00028 } },
            { id: 'mimo-v2.5-pro-ultraspeed', provider: '小米', defaults: { input: 0.001305, output: 0.00261 } },
            { id: 'mimo-2.5', provider: '小米', defaults: { input: 0.0008, output: 0.0008 } },
            // MiMo 本地权重型号（native）
            { id: 'mimo-2.5-1.5b', provider: '小米', defaults: { input: 0.0002, output: 0.0002 } },
            { id: 'mimo-2.5-7b', provider: '小米', defaults: { input: 0.0005, output: 0.0005 } },
            { id: 'mimo-2.5-13b', provider: '小米', defaults: { input: 0.0007, output: 0.0007 } },
            { id: 'mimo-2.5-30b', provider: '小米', defaults: { input: 0.001, output: 0.001 } },
            // Google Gemini
            // Google Gemma 4 (本地/云端)
            { id: 'gemma-4-2b-it', provider: 'Google', defaults: { input: 0.00005, output: 0.0001 } },
            { id: 'gemma-4-4b', provider: 'Google', defaults: { input: 0.00008, output: 0.00016 } },
            { id: 'gemma-4-9b', provider: 'Google', defaults: { input: 0.00015, output: 0.0003 } },
            { id: 'gemma-4-27b', provider: 'Google', defaults: { input: 0.0004, output: 0.0008 } },
            // Google Gemini
            { id: 'gemini-3.0', provider: 'Google', defaults: { input: 0.0001, output: 0.0004 } },
            { id: 'gemini-3.1', provider: 'Google', defaults: { input: 0.0015, output: 0.006 } },
            // Google Gemma 3
            { id: 'gemma-3-1b-it', provider: 'Google', defaults: { input: 0.00003, output: 0.00006 } },
            { id: 'gemma-3-4b-it', provider: 'Google', defaults: { input: 0.0001, output: 0.0002 } },
            // Anthropic
            { id: 'claude-sonnet-4.6', provider: 'Anthropic', defaults: { input: 0.003, output: 0.015 } },
            { id: 'claude-opus-4.7', provider: 'Anthropic', defaults: { input: 0.015, output: 0.075 } },
            // 阿里云 Qwen 系列
            { id: 'qwen-max', provider: '阿里云', defaults: { input: 0.0005, output: 0.001 } },
            { id: 'qwen-plus', provider: '阿里云', defaults: { input: 0.0003, output: 0.0006 } },
            { id: 'qwen-turbo', provider: '阿里云', defaults: { input: 0.0001, output: 0.0002 } },
            // Qwen 本地模型
            { id: 'qwen2-7b', provider: '本地', defaults: { input: 0, output: 0 } },
            { id: 'qwen2-14b', provider: '本地', defaults: { input: 0, output: 0 } },
            { id: 'qwen3.5-7b', provider: '本地', defaults: { input: 0, output: 0 } },
            { id: 'qwen3.5-14b', provider: '本地', defaults: { input: 0, output: 0 } },
            { id: 'qwen3.5-32b', provider: '本地', defaults: { input: 0, output: 0 } },
            { id: 'qwen3.6-72b', provider: '本地', defaults: { input: 0, output: 0 } },
            // ModelScope
            // ModelScope 模型
            { id: 'deepseek-r1', provider: 'ModelScope', defaults: { input: 0.0002, output: 0.0008 } },
            { id: 'llama3-70b', provider: 'ModelScope', defaults: { input: 0.0004, output: 0.0008 } },
            { id: 'qwen3-8b', provider: 'ModelScope', defaults: { input: 0.0001, output: 0.0002 } },
            { id: 'claude-opus-4.7', provider: 'Anthropic', defaults: { input: 0.015, output: 0.075 } },
            { id: 'kimi-2.5', provider: 'Moonshot', defaults: { input: 0.0005, output: 0.0005 } },
            { id: 'kimi-2.6', provider: 'Moonshot', defaults: { input: 0.001, output: 0.001 } },
            // MiniMax 系列
            { id: 'minimax-text-01-4b', provider: 'Minimax', defaults: { input: 0.0003, output: 0.0003 } },
            { id: 'minimax-text-01-8b', provider: 'Minimax', defaults: { input: 0.0005, output: 0.0005 } },
            { id: 'minimax-text-01-32b', provider: 'Minimax', defaults: { input: 0.0008, output: 0.0008 } },
            { id: 'minimax-text-01-456b', provider: 'Minimax', defaults: { input: 0.001, output: 0.001 } },
            { id: 'minimax-2.5', provider: 'Minimax', defaults: { input: 0.0008, output: 0.0008 } },
            { id: 'minimax-2.7', provider: 'Minimax', defaults: { input: 0.0012, output: 0.0012 } },
            // MiniMax Voice
            { id: 'minimax-voice-01', provider: 'Minimax', defaults: { input: 0.001, output: 0.002 } },
            { id: 'deepseek-3.2', provider: 'DeepSeek', defaults: { input: 0.00014, output: 0.00028 } },
            { id: 'deepseek-v4', provider: 'DeepSeek', defaults: { input: 0.0003, output: 0.0006 } },
            { id: 'qwen-3.5', provider: 'Qwen', defaults: { input: 0.0003, output: 0.0006 } },
            { id: 'qwen-3.6', provider: 'Qwen', defaults: { input: 0.0005, output: 0.001 } },
        ];

        // 计价模式: per1k (每1K tokens) 或 per1m (每百万 tokens)
        const pricingMode = this.currentConfig.pricingMode || 'per1k';
        const multiplier = pricingMode === 'per1m' ? 1000 : 1;
        const unitLabelUsd = pricingMode === 'per1m' ? 'USD/百万 tokens' : 'USD/1K tokens';
        const unitLabelCny = pricingMode === 'per1m' ? 'CNY/百万 tokens' : 'CNY/1K tokens';
        
        // 汇率设置
        const exchangeRate = this.currentConfig.exchangeRate || 6.82;

        // 从 localStorage 读取用户自定义价格
        const userPricing = this.currentConfig.pricingOverrides || {};

        let bodyHtml = `
            <div class="config-form pricing-config-modal">
                <div class="form-row" style="display: flex; gap: 12px;">
                    <div class="form-group" style="flex: 1;">
                        <label for="pricing-mode-select">计价模式:</label>
                        <select id="pricing-mode-select">
                            <option value="per1k" ${pricingMode === 'per1k' ? 'selected' : ''}>每 1K tokens</option>
                            <option value="per1m" ${pricingMode === 'per1m' ? 'selected' : ''}>每 百万 tokens</option>
                        </select>
                    </div>
                    <div class="form-group" style="flex: 1;">
                        <label for="exchange-rate-input">汇率 (1 USD = ? CNY):</label>
                        <input type="number" id="exchange-rate-input" value="${exchangeRate}" min="0.01" step="0.01" placeholder="6.82">
                        <span class="helper-text">默认 1 USD = 6.82 CNY</span>
                    </div>
                </div>
                <div class="pricing-note">
                    <span class="pricing-note-badge">云端推理</span>
                    <span class="pricing-note-text">以下价格为各模型官方云端推理价格。本地推理使用本地算力，不单独计价。</span>
                </div>
                <div class="pricing-models-table-wrapper">
                    <table class="pricing-models-table">
                        <thead>
                            <tr>
                                <th>模型</th>
                                <th>服务商</th>
                                <th>输入价格<br><small style="color:#666;font-weight:normal;">${unitLabelUsd} / ${unitLabelCny}</small></th>
                                <th>输出价格<br><small style="color:#666;font-weight:normal;">${unitLabelUsd} / ${unitLabelCny}</small></th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        for (const m of cloudModels) {
            const override = userPricing[m.id];
            const inputVal = ((override ? override.input : m.defaults.input) * multiplier);
            const outputVal = ((override ? override.output : m.defaults.output) * multiplier);
            const inputValCny = (inputVal * exchangeRate).toFixed(8);
            const outputValCny = (outputVal * exchangeRate).toFixed(8);
            const inputValStr = inputVal.toFixed(8).replace(/\.?0+$/, '');
            const outputValStr = outputVal.toFixed(8).replace(/\.?0+$/, '');
            const isCustom = !!override;
            bodyHtml += `
                <tr data-model="${this.escapeHtml(m.id)}" class="${isCustom ? 'pricing-row-custom' : ''}">
                    <td><code>${this.escapeHtml(m.id)}</code></td>
                    <td>${this.escapeHtml(m.provider)}</td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="color: #2563eb; font-weight: 500; min-width: 60px;">$${inputValStr}</span>
                            <span style="color: #dc2626; font-size: 12px;">¥${inputValCny}</span>
                        </div>
                        <input type="number" step="any" class="pricing-input pricing-input-in" value="${inputValStr}" data-default="${m.defaults.input * multiplier}" style="margin-top: 4px;">
                    </td>
                    <td>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="color: #2563eb; font-weight: 500; min-width: 60px;">$${outputValStr}</span>
                            <span style="color: #dc2626; font-size: 12px;">¥${outputValCny}</span>
                        </div>
                        <input type="number" step="any" class="pricing-input pricing-input-out" value="${outputValStr}" data-default="${m.defaults.output * multiplier}" style="margin-top: 4px;">
                    </td>
                    <td>
                        <button type="button" class="pricing-reset-btn secondary-config-btn" ${!isCustom ? 'disabled' : ''}>重置</button>
                    </td>
                </tr>
            `;
        }

        bodyHtml += `
                        </tbody>
                    </table>
                </div>
                <div class="pricing-note" style="margin-top:12px">
                    <span class="pricing-note-badge" style="background:#dbeafe;color:#1e40af">本地推理</span>
                    <span class="pricing-note-text">Yueli-KGM 本地推理、Ollama、vLLM 等本地运行时，使用本地 GPU/CPU 算力，成本为电费与硬件折旧，不计入 Token 价格。</span>
                </div>
                <div class="form-actions" style="margin-top:16px">
                    <button type="button" id="pricing-save-btn" class="primary-config-btn">保存配置</button>
                    <button type="button" id="pricing-fetch-btn" class="secondary-config-btn">从服务端刷新</button>
                </div>
            </div>
        `;

        this.modalBody.innerHTML = bodyHtml;

        // 计价模式切换
        document.getElementById('pricing-mode-select').addEventListener('change', (e) => {
            this.currentConfig.pricingMode = e.target.value;
            this.saveConfigToLocalStorage();
            this.hideModal();
            this.showPricingConfigModal();
        });

        // 汇率变更
        const exchangeRateInput = document.getElementById('exchange-rate-input');
        exchangeRateInput.addEventListener('change', (e) => {
            this.currentConfig.exchangeRate = parseFloat(e.target.value) || 6.82;
            this.saveConfigToLocalStorage();
            this.hideModal();
            this.showPricingConfigModal();
        });

        // 重置按钮
        this.modalBody.querySelectorAll('.pricing-reset-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const row = e.target.closest('tr');
                const modelId = row.dataset.model;
                const inputEl = row.querySelector('.pricing-input-in');
                const outputEl = row.querySelector('.pricing-input-out');
                inputEl.value = inputEl.dataset.default;
                outputEl.value = outputEl.dataset.default;
                row.classList.remove('pricing-row-custom');
                e.target.disabled = true;
                // 从 overrides 中移除
                if (this.currentConfig.pricingOverrides) {
                    delete this.currentConfig.pricingOverrides[modelId];
                }
            });
        });

        // 输入框变更标记自定义
        this.modalBody.querySelectorAll('.pricing-input').forEach((input) => {
            input.addEventListener('input', (e) => {
                const row = e.target.closest('tr');
                const modelId = row.dataset.model;
                const defaultVal = parseFloat(e.target.dataset.default);
                const currentVal = parseFloat(e.target.value);
                const resetBtn = row.querySelector('.pricing-reset-btn');
                if (Math.abs(currentVal - defaultVal) > 1e-9) {
                    row.classList.add('pricing-row-custom');
                    resetBtn.disabled = false;
                }
            });
        });

        // 保存
        document.getElementById('pricing-save-btn').addEventListener('click', async () => {
            try {
                const mode = this.currentConfig.pricingMode || 'per1k';
                const rows = this.modalBody.querySelectorAll('.pricing-models-table tbody tr');
                const overrides = {};
                const updates = [];

                for (const row of rows) {
                    const modelId = row.dataset.model;
                    const inputVal = parseFloat(row.querySelector('.pricing-input-in').value);
                    const outputVal = parseFloat(row.querySelector('.pricing-input-out').value);
                    const defaultIn = parseFloat(row.querySelector('.pricing-input-in').dataset.default);
                    const defaultOut = parseFloat(row.querySelector('.pricing-input-out').dataset.default);

                    if (Math.abs(inputVal - defaultIn) > 1e-9 || Math.abs(outputVal - defaultOut) > 1e-9) {
                        overrides[modelId] = { input: inputVal / (mode === 'per1m' ? 1000 : 1), output: outputVal / (mode === 'per1m' ? 1000 : 1) };
                        updates.push({ model: modelId, inputPrice: inputVal, outputPrice: outputVal, mode });
                    }
                }

                this.currentConfig.pricingOverrides = overrides;
                // 保存汇率设置
                this.currentConfig.exchangeRate = parseFloat(document.getElementById('exchange-rate-input').value) || 6.82;
                this.saveConfigToLocalStorage();

                // 同步到服务端
                for (const update of updates) {
                    try {
                        await fetch('/playground/pricing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(update),
                        });
                    } catch (err) {
                        console.warn('同步定价到服务端失败:', err);
                    }
                }

                this.hideModal();
                this.showToast('价格配置已保存');
            } catch (error) {
                this.showError(error.message);
            }
        });

        // 从服务端刷新
        document.getElementById('pricing-fetch-btn').addEventListener('click', async () => {
            try {
                const mode = this.currentConfig.pricingMode || 'per1k';
                const resp = await fetch(`/playground/pricing?mode=${mode}`);
                const data = await resp.json();
                if (data.models) {
                    for (const [modelId, info] of Object.entries(data.models)) {
                        const row = this.modalBody.querySelector(`tr[data-model="${CSS.escape(modelId)}"]`);
                        if (row) {
                            row.querySelector('.pricing-input-in').value = (info.input || 0).toString();
                            row.querySelector('.pricing-input-out').value = (info.output || 0).toString();
                        }
                    }
                }
                this.showToast('已刷新服务端定价');
            } catch (err) {
                this.showToast('刷新失败: ' + (err.message || err), 'error');
            }
        });

        this.showModal();
    }

    showApiKeysModal() {
        this.modalTitle.textContent = '凭证与调用钥';
        if (this.modal) {
            this.modal.classList.add('modal--wide', 'modal--api-keys');
        }

        const k = this.currentConfig.apiKeys || {};
        const val = (key) => this.escapeHtml(k[key] || '');
        const gateway = this.currentConfig.yueliGateway || {};
        const gatewayHost = this.escapeHtml(gateway.host || 'https://www.yueli.com');
        const gatewayPrefix = this.escapeHtml(gateway.upstreamPrefix ?? '/api');

        const sections = [
            {
                scope: 'server',
                id: 'yueliai',
                title: '阅粒 · 云端推理聚合 (YueliAI v1)',
                desc: '经本地 KGM 代理至云端；凭证同步到服务端 KgmConfig.yueliai。',
                open: true,
                fields: [
                    {
                        key: 'yueliai',
                        label: 'YueliAI API Key',
                        placeholder: 'sk-...',
                        hint: '写入服务端 config + 本地 apiKeys.yueliai',
                        multiKey: true,
                    },
                    {
                        key: 'yueliaiHost',
                        label: '聚合服务 Host',
                        placeholder: 'https://www.yueli.com',
                        hint: '对应 YUELIAI_HOST',
                        inputType: 'text',
                    },
                    {
                        key: 'yueliaiUpstreamPrefix',
                        label: '上游路径前缀',
                        placeholder: '/api',
                        hint: '生产默认 /api → /api/yueliai/v1/*；根路径网关设为空',
                        inputType: 'text',
                    },
                ],
            },
            {
                scope: 'browser',
                id: 'cloud-native',
                title: '云端 · 专用适配',
                desc: '对接各厂商原生或专用 HTTP 客户端。保存于本机浏览器 localStorage。',
                open: true,
                fields: [
                    { key: 'openai', label: 'OpenAI', placeholder: 'sk-...', hint: 'platform.openai.com', multiKey: true },
                    { key: 'zhipu', label: '智谱 AI', placeholder: 'API Key', hint: 'open.bigmodel.cn', multiKey: true },
                    { key: 'minimax', label: 'Minimax', placeholder: 'API Key', hint: 'api.minimax', multiKey: true },
                    { key: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...', hint: 'openrouter.ai', multiKey: true },
                    { key: 'nvidia', label: 'NVIDIA NIM / Integrate', placeholder: 'nvapi-...', hint: 'integrate.api.nvidia.com', multiKey: true },
                    { key: 'deepseek', label: 'DeepSeek', placeholder: 'API Key', hint: 'api.deepseek.com', multiKey: true },
                    { key: 'xiaomi', label: '小米 MiMo', placeholder: 'API Key (sk-… / tp-…)', hint: 'api.xiaomimimo.com/v1 · MIMO_API_KEY', multiKey: true },
                    { key: 'gemini', label: 'Google Gemini', placeholder: 'API Key', hint: 'ai.google.dev', multiKey: true },
                    { key: 'anthropic', label: 'Anthropic Claude', placeholder: 'sk-ant-...', hint: 'console.anthropic.com', multiKey: true },
                    { key: 'aliyun', label: '阿里云（专用适配）', placeholder: 'Bearer Token', hint: '与 aliyun_bailian 区分', multiKey: true },
                    { key: 'modelscope', label: 'ModelScope', placeholder: 'Token', hint: 'modelscope.cn', multiKey: true },
                    { key: 'moonshot', label: 'Moonshot 月之暗面', placeholder: 'sk-...', hint: 'platform.moonshot.cn', multiKey: true },
                ],
            },
            {
                scope: 'browser',
                id: 'cn-compat',
                title: '国内 · OpenAI 兼容',
                desc: 'DashScope / 千帆 / 方舟等 OpenAI 形端点。',
                open: false,
                fields: [
                    { key: 'aliyun_bailian', label: '阿里百炼（兼容）', placeholder: 'DASHSCOPE_API_KEY', hint: 'dashscope.aliyuncs.com/compatible-mode/v1', multiKey: true },
                    { key: 'baidu_qianfan', label: '百度千帆', placeholder: 'API Key', hint: 'qianfan.baidubce.com/v2', multiKey: true },
                    { key: 'volcengine_ark', label: '火山方舟', placeholder: 'ARK API Key', hint: 'ark.cn-beijing.volces.com/api/v3', multiKey: true },
                ],
            },
            {
                scope: 'browser',
                id: 'intl-compat',
                title: '国际 · OpenAI 兼容',
                desc: '多数为云端 API；Bedrock 需经自建 OpenAI 形网关。',
                open: false,
                fields: [
                    { key: 'groq', label: 'Groq', placeholder: 'gsk_...', hint: 'api.groq.com', multiKey: true },
                    { key: 'together', label: 'Together AI', placeholder: 'API Key', hint: 'api.together.xyz', multiKey: true },
                    { key: 'fireworks', label: 'Fireworks', placeholder: 'API Key', hint: 'api.fireworks.ai', multiKey: true },
                    { key: 'perplexity', label: 'Perplexity', placeholder: 'pplx-...', hint: 'api.perplexity.ai', multiKey: true },
                    { key: 'mistral', label: 'Mistral', placeholder: 'API Key', hint: 'api.mistral.ai', multiKey: true },
                    { key: 'huggingface', label: 'Hugging Face（OpenAI 兼容入口）', placeholder: 'HF_TOKEN', hint: '自建或 Router 的 /v1 根 URL', multiKey: true },
                    { key: 'azure_openai', label: 'Azure OpenAI', placeholder: 'API Key', hint: 'resource.openai.azure.com', multiKey: true },
                    { key: 'aws_bedrock', label: 'AWS Bedrock（经网关）', placeholder: '网关 Bearer（可选）', hint: 'BEDROCK_OPENAI_COMPAT_BASE_URL', multiKey: true },
                ],
            },
            {
                scope: 'browser',
                id: 'localhost',
                title: '本地 (localhost)',
                desc: '本机 ds4、llama.cpp、Ollama、vLLM、SGLang 等若前有鉴权，请填「本地统一 Bearer」。',
                open: true,
                fields: [
                    {
                        key: 'localhost',
                        label: '本地统一 Bearer（localhost）',
                        placeholder: '可选；127.0.0.1 前置网关或本地服务鉴权',
                        hint: '适用于：Yueli-KGM 本地、ds4（默认 :8090）、llama.cpp（默认 :8080）、Ollama、vLLM、SGLang、LM Studio、vMLX/MLX、KoboldCpp、Text Gen WebUI',
                        multiKey: true,
                    },
                ],
            },
            {
                scope: 'browser',
                id: 'other',
                title: '其它',
                desc: 'Minimax 需与 Group ID 同配；自定义上游用于非上述厂商的 Token。',
                open: false,
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

        const renderFields = (sec) => {
            let html = '<div class="api-keys-grid">';
            for (const f of sec.fields) {
                if (f.key === 'yueliaiHost') {
                    html += `
                        <div class="api-keys-field">
                            <label for="api-key-yueliaiHost">${this.escapeHtml(f.label)}</label>
                            <input type="text" id="api-key-yueliaiHost" value="${gatewayHost}" placeholder="${this.escapeHtml(f.placeholder || '')}">
                            <span class="field-hint">${this.escapeHtml(f.hint || '')}</span>
                        </div>`;
                    continue;
                }
                if (f.key === 'yueliaiUpstreamPrefix') {
                    html += `
                        <div class="api-keys-field">
                            <label for="api-key-yueliaiUpstreamPrefix">${this.escapeHtml(f.label)}</label>
                            <input type="text" id="api-key-yueliaiUpstreamPrefix" value="${gatewayPrefix}" placeholder="${this.escapeHtml(f.placeholder || '')}">
                            <span class="field-hint">${this.escapeHtml(f.hint || '')}</span>
                        </div>`;
                    continue;
                }
                const inputType = f.inputType || 'password';
                const multiKey = f.multiKey || false;
                const maxKeys = multiKey ? 3 : 1;
                for (let i = 0; i < maxKeys; i++) {
                    const keyId = i === 0 ? f.key : `${f.key}_${i + 1}`;
                    const label = i === 0 ? f.label : `${f.label} (备用${i})`;
                    const value = val(keyId);
                    const configured = Boolean(value) || (f.key === 'yueliai' && Boolean(gateway.apiKeyConfigured));
                    const placeholder =
                        inputType === 'password' && configured
                            ? '已配置；留空保持不变，输入新值替换'
                            : (i === 0 ? f.placeholder : `${f.placeholder} (可选)`);
                    if (i === 0 || value || multiKey) {
                        html += `
                            <div class="api-keys-field${i > 0 ? ' api-key-backup' : ''}">
                                <label for="api-key-${keyId}">${this.escapeHtml(label)}</label>
                                <input
                                    type="${inputType}"
                                    id="api-key-${keyId}"
                                    name="api-key-${keyId}"
                                    autocomplete="${inputType === 'password' ? 'new-password' : 'off'}"
                                    placeholder="${this.escapeHtml(placeholder || '')}"
                                    value="${inputType === 'password' ? '' : value}"
                                    data-configured="${configured ? 'true' : 'false'}"
                                >
                                ${inputType === 'password' ? `
                                    <div class="api-key-field-actions">
                                        <span class="api-key-state ${configured ? 'is-configured' : ''}">${configured ? '已配置' : '未配置'}</span>
                                        <button type="button" class="api-key-clear-btn" data-clear-key="${keyId}" ${configured ? '' : 'disabled'}>清除</button>
                                    </div>
                                ` : ''}
                                ${i === 0 && f.hint ? `<span class="field-hint">${this.escapeHtml(f.hint)}</span>` : ''}
                            </div>`;
                    }
                }
            }
            html += '</div>';
            return html;
        };

        const serverSections = sections.filter((s) => s.scope === 'server');
        const browserSections = sections.filter((s) => s.scope === 'browser');

        this.modalBody.innerHTML = `
            <div class="config-form api-keys-modal">
                <div class="credential-scope-grid" role="tablist" aria-label="凭证作用域">
                    <button type="button" class="credential-scope-card is-active" data-keys-scope="session" role="tab" aria-selected="true">
                        <strong>管理会话</strong><span>Master Key · sessionStorage</span>
                    </button>
                    <button type="button" class="credential-scope-card" data-keys-scope="server" role="tab" aria-selected="false">
                        <strong>服务端网关</strong><span>YueliAI · ConfigStore</span>
                    </button>
                    <button type="button" class="credential-scope-card" data-keys-scope="browser" role="tab" aria-selected="false">
                        <strong>浏览器上游</strong><span>厂商 Key · localStorage</span>
                    </button>
                    <button type="button" class="credential-scope-card" data-keys-scope="callkeys" role="tab" aria-selected="false">
                        <strong>KGM 调用钥</strong><span>运维签发 · 可吊销</span>
                    </button>
                </div>
                <p class="api-keys-intro">
                    密钥输入框不再回填现有值：<strong>留空表示保持不变</strong>，替换时输入新值，删除需显式点击“清除”。
                </p>

                <div class="api-keys-scope-panel" data-keys-panel="session">
                    <section class="api-keys-section api-keys-admin-session">
                        <h4 class="api-keys-section-title">KGM 管理会话（Master）</h4>
                        <p class="api-keys-section-desc">
                            严格模式下访问配置与运维 API。仅保存在当前标签页的 <code>sessionStorage</code>，关闭标签页自动清除。
                        </p>
                        <div class="api-keys-grid">
                            <div class="api-keys-field">
                                <label for="api-key-kgm-master">KGM_HTTP_API_KEY</label>
                                <input type="password" id="api-key-kgm-master" autocomplete="off"
                                    placeholder="${window.KGM_AUTH?.hasMasterKey() ? '当前会话已配置；输入新值替换' : '输入管理钥'}">
                                <div class="api-key-field-actions">
                                    <span class="api-key-state ${window.KGM_AUTH?.hasMasterKey() ? 'is-configured' : ''}">
                                        ${window.KGM_AUTH?.hasMasterKey() ? '当前会话已配置' : '当前会话未配置'}
                                    </span>
                                    <button type="button" class="api-key-clear-btn" id="clear-kgm-master"
                                        ${window.KGM_AUTH?.hasMasterKey() ? '' : 'disabled'}>清除会话</button>
                                </div>
                            </div>
                        </div>
                        <div class="api-keys-actions api-keys-actions--session">
                            <button type="button" class="btn btn-secondary" id="save-kgm-master">保存到当前会话</button>
                        </div>
                    </section>
                </div>

                <div class="api-keys-scope-panel" data-keys-panel="server" hidden>
                    ${serverSections.map((sec) => `
                        <section class="api-keys-section">
                            <h4 class="api-keys-section-title">${this.escapeHtml(sec.title)}</h4>
                            ${sec.desc ? `<p class="api-keys-section-desc">${this.escapeHtml(sec.desc)}</p>` : ''}
                            ${renderFields(sec)}
                        </section>
                    `).join('')}
                    <div class="api-keys-actions">
                        <button type="button" class="btn btn-primary" id="save-api-keys-server">保存服务端 YueliAI</button>
                    </div>
                </div>

                <div class="api-keys-scope-panel" data-keys-panel="browser" hidden>
                    <p class="api-keys-section-desc">按厂商折叠编辑。本机推理优先使用 <code>localhost</code>（及备用 <code>localhost_2/3</code>）。</p>
                    ${browserSections.map((sec) => `
                        <details class="api-keys-fold" ${sec.open ? 'open' : ''} id="api-keys-fold-${sec.id}">
                            <summary class="api-keys-fold-summary">
                                <span>${this.escapeHtml(sec.title)}</span>
                                <span class="api-keys-fold-meta">${sec.fields.length} 项</span>
                            </summary>
                            ${sec.desc ? `<p class="api-keys-section-desc">${this.escapeHtml(sec.desc)}</p>` : ''}
                            ${renderFields(sec)}
                        </details>
                    `).join('')}
                    <div class="api-keys-actions">
                        <button type="button" class="btn btn-primary" id="save-api-keys">保存浏览器凭证</button>
                        <button type="button" class="btn btn-secondary" id="sync-maas-providers">同步浏览器 MaaS 到服务端</button>
                    </div>
                </div>

                <div class="api-keys-scope-panel" data-keys-panel="callkeys" hidden>
                    <section class="api-keys-section">
                        <h4 class="api-keys-section-title">KGM 虚拟调用钥</h4>
                        <p class="api-keys-section-desc">
                            调用钥由运维面签发，明文仅在创建时显示一次，可绑定预算与模型白名单，支持吊销。
                            与浏览器厂商 Key、服务端 YueliAI Key 不是同一套凭证。
                        </p>
                        <div class="api-keys-actions">
                            <button type="button" class="btn btn-primary" id="manage-call-keys">前往运维 → 访问</button>
                        </div>
                    </section>
                </div>
            </div>
        `;

        const switchScope = (scope) => {
            this.modalBody.querySelectorAll('[data-keys-scope]').forEach((btn) => {
                const active = btn.dataset.keysScope === scope;
                btn.classList.toggle('is-active', active);
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            this.modalBody.querySelectorAll('[data-keys-panel]').forEach((panel) => {
                panel.hidden = panel.dataset.keysPanel !== scope;
            });
        };
        this.modalBody.querySelectorAll('[data-keys-scope]').forEach((btn) => {
            btn.addEventListener('click', () => switchScope(btn.dataset.keysScope));
        });

        document.getElementById('save-kgm-master')?.addEventListener('click', () => {
            const input = document.getElementById('api-key-kgm-master');
            const value = input?.value.trim();
            if (!value) {
                this.showToast('请输入 KGM 管理钥；留空不会覆盖当前会话', 'error');
                return;
            }
            window.KGM_AUTH?.setMasterKey(value);
            if (input) input.value = '';
            this.showToast('管理钥已保存到当前标签页会话', 'success');
            this.hideModal();
            window.KGM_CONTROL_PLANE?.refresh?.().catch(() => {});
        });
        document.getElementById('clear-kgm-master')?.addEventListener('click', () => {
            window.KGM_AUTH?.clearMasterKey();
            this.showToast('当前标签页管理钥已清除', 'success');
            this.hideModal();
        });

        this.modalBody.querySelectorAll('[data-clear-key]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.dataset.clearKey;
                if (!window.confirm(`确认清除 ${id}？保存后生效。`)) {
                    return;
                }
                const input = document.getElementById(`api-key-${id}`);
                if (input) {
                    input.value = '';
                    input.dataset.clear = 'true';
                }
                button.textContent = '待清除';
                button.disabled = true;
                button.closest('.api-keys-field')?.classList.add('is-pending-clear');
            });
        });

        const collectLocalKeys = () => {
            this.currentConfig.apiKeys = this.currentConfig.apiKeys || {};
            const root = this.modalBody.querySelector('.api-keys-modal') || this.modalBody;
            root.querySelectorAll('input[id^="api-key-"]').forEach((el) => {
                const id = el.id.slice('api-key-'.length);
                if (id === 'yueliaiHost' || id === 'yueliaiUpstreamPrefix' || id === 'kgm-master') {
                    return;
                }
                const value = el.value.trim();
                if (value) {
                    this.currentConfig.apiKeys[id] = value;
                } else if (el.dataset.clear === 'true') {
                    delete this.currentConfig.apiKeys[id];
                }
            });
        };

        document.getElementById('save-api-keys')?.addEventListener('click', () => {
            collectLocalKeys();
            this.saveConfigToLocalStorage();
            this.showToast('浏览器上游凭证已保存到本机', 'success');
            this.hideModal();
        });

        document.getElementById('save-api-keys-server')?.addEventListener('click', async () => {
            collectLocalKeys();
            const hostEl = document.getElementById('api-key-yueliaiHost');
            const prefixEl = document.getElementById('api-key-yueliaiUpstreamPrefix');
            this.currentConfig.yueliGateway = this.currentConfig.yueliGateway || {};
            if (hostEl) {
                this.currentConfig.yueliGateway.host = hostEl.value.trim() || 'https://www.yueli.com';
            }
            if (prefixEl) {
                this.currentConfig.yueliGateway.upstreamPrefix = prefixEl.value.trim();
            }
            this.saveConfigToLocalStorage();
            try {
                const clearYueliApiKey =
                    document.getElementById('api-key-yueliai')?.dataset.clear === 'true';
                await this.syncGatewayConfigToServer({ clearApiKey: clearYueliApiKey });
                this.showToast('YueliAI 网关已同步到服务端', 'success');
                window.KGM_CONTROL_PLANE?.refresh?.().catch(() => {});
            } catch (err) {
                this.showToast('本地已保存，服务端同步失败: ' + (err.message || err), 'error');
            }
            this.hideModal();
        });

        const syncMaasBtn = document.getElementById('sync-maas-providers');
        if (syncMaasBtn) {
            syncMaasBtn.addEventListener('click', async () => {
                try {
                    const count = await this.syncMaasProvidersToServer();
                    this.showToast(`已同步 ${count} 个 MaaS Provider 到服务端`, 'success');
                } catch (err) {
                    this.showToast('MaaS 同步失败: ' + (err.message || err), 'error');
                }
            });
        }

        document.getElementById('manage-call-keys')?.addEventListener('click', () => {
            this.hideModal();
            this.switchWorkspace('ops');
            window.dispatchEvent(new CustomEvent('kgm-ops-activate', { detail: { opsTab: 'keys' } }));
        });

        this.showModal();
    }

    async loadGatewayConfigFromServer() {
        try {
            const response = await fetch('/v1/kgm/config');
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            this.applyYueliGatewayFromServer(data.yueliai);
            this.saveConfigToLocalStorage();
            this.renderStatusBar();
        } catch {
            // 离线或无权访问时保留 localStorage
        }
    }

    applyYueliGatewayFromServer(y) {
        if (!y || typeof y !== 'object') {
            return;
        }
        this.currentConfig.yueliGateway = {
            host: y.host || 'https://www.yueli.com',
            upstreamPrefix: y.upstreamPrefix ?? '/api',
            enabled: y.enabled !== false,
            apiKeyConfigured: Boolean(y.apiKeyConfigured),
        };
    }

    parsePlaygroundConfigJson(raw) {
        const trimmed = String(raw || '').trim();
        if (!trimmed || trimmed.startsWith('//')) {
            throw new Error('配置为空或含无效注释，请从服务端重新加载');
        }
        return JSON.parse(trimmed);
    }

    async loadServerConfigBundle() {
        try {
            const [configResponse, routingResponse, summaryResponse] = await Promise.all([
                fetch('/v1/kgm/config'),
                fetch('/v1/kgm/auto-routing'),
                fetch('/v1/kgm/auto-routing/summary?limit=8'),
            ]);
            if (configResponse.ok) {
                const data = await configResponse.json();
                this.applyYueliGatewayFromServer(data.yueliai);
                this.playgroundConfig = data.playground || {};
                if (this.playgroundConfigJson) {
                    this.playgroundConfigJson.value = JSON.stringify(this.playgroundConfig, null, 2);
                }
                this.saveConfigToLocalStorage();
            } else if (this.playgroundConfigJson) {
                this.playgroundConfigJson.value = '{}';
            }
            if (routingResponse.ok) {
                this.autoRoutingConfig = await routingResponse.json();
                this.autoRoutingSummary = summaryResponse.ok ? await summaryResponse.json() : null;
                this.renderAutoRoutingPanel();
            }
        } catch (error) {
            if (this.playgroundConfigJson) {
                this.playgroundConfigJson.value = `{\n  "_loadError": ${JSON.stringify(error.message)}\n}`;
            }
        }
    }

    switchWorkspace(name) {
        if (!name) {
            return;
        }
        this.activeWorkspace = name;
        this.workspaceTabs?.forEach((tab) => {
            const on = tab.dataset.workspace === name;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Object.entries(this.workspaceViews || {}).forEach(([key, el]) => {
            if (!el) {
                return;
            }
            const on = key === name;
            el.hidden = !on;
            el.classList.toggle('active', on);
        });
        if (this.integrationSubnav) {
            this.integrationSubnav.classList.toggle('is-hidden', name !== 'integration');
        }
        if (this.opsSubnav) {
            this.opsSubnav.classList.toggle('is-hidden', name !== 'ops');
        }
        if (name === 'routing') {
            this.loadAutoRoutingOverview();
        }
        if (name === 'models') {
            this.loadManagedModels();
        }
        if (name === 'ops') {
            window.dispatchEvent(new CustomEvent('kgm-ops-activate', { detail: { opsTab: 'usage' } }));
            if (window.KgmOpsPanel?.refreshAll) {
                window.KgmOpsPanel.refreshAll().catch(() => {});
            }
        }
        if (name === 'memory' && window.KGM_MEMORY_OBS?.refresh) {
            window.KGM_MEMORY_OBS.refresh().catch(() => {});
        }
        if (name === 'config' && window.KGM_CONFIG_PANEL?.refresh) {
            window.KGM_CONFIG_PANEL.refresh().catch(() => {});
        }
        if (['chat', 'routing', 'memory', 'ops', 'integration'].includes(name) && window.KGM_CONTROL_PLANE?.refresh) {
            window.KGM_CONTROL_PLANE.refresh().catch(() => {});
        }
        if (name === 'integration' && !this.activeIntegrationTab) {
            this.switchIntegrationTab('tasks');
        }
    }

    switchOutputTab(name) {
        if (!name) {
            return;
        }
        this.activeOutputTab = name;
        this.outputTabs?.forEach((tab) => {
            const on = tab.dataset.outputTab === name;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        this.outputPanels?.forEach((panel) => {
            const on = panel.dataset.outputPanel === name;
            panel.hidden = !on;
            panel.classList.toggle('active', on);
        });
    }

    async syncGatewayConfigToServer(options = {}) {
        const keys = this.currentConfig.apiKeys || {};
        const gateway = this.currentConfig.yueliGateway || {};
        const apiKey = keys.yueliai || keys.yueliai_2 || keys.yueliai_3 || '';
        const apiKeyConfigured = Boolean(gateway.apiKeyConfigured);
        const response = await fetch('/v1/kgm/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                yueliai: {
                    enabled: options.clearApiKey ? false : Boolean(apiKey) || apiKeyConfigured,
                    host: gateway.host || 'https://www.yueli.com',
                    upstreamPrefix: gateway.upstreamPrefix ?? '/api',
                    apiKey: options.clearApiKey ? '' : apiKey || undefined,
                    timeoutMs: 120000,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(await response.text());
        }
        const updated = await response.json();
        this.applyYueliGatewayFromServer(updated.yueliai);
    }

    async syncMaasProvidersToServer() {
        const keys = this.currentConfig.apiKeys || {};
        const pick = (base) => {
            for (const id of [base, `${base}_2`, `${base}_3`]) {
                const v = keys[id];
                if (typeof v === 'string' && v.trim()) {
                    return v.trim();
                }
            }
            return '';
        };
        const presets = [
            { presetId: 'openai', model: 'gpt-5.4-mini' },
            { presetId: 'zhipu', model: 'glm-5.1' },
            { presetId: 'anthropic', model: 'claude-sonnet-4.6' },
            { presetId: 'deepseek', model: 'deepseek-v4-flash' },
            { presetId: 'moonshot', model: 'kimi-2.6' },
            { presetId: 'minimax', model: 'minimax-2.7' },
            { presetId: 'gemini', model: 'gemini-3.1' },
            { presetId: 'openrouter', model: 'openai/gpt-4o' },
            { presetId: 'aliyun_bailian', model: 'qwen-3.6' },
            { presetId: 'volcengine_ark', model: 'deepseek-v4-flash' },
        ];
        const cloudProviders = presets
            .map((p) => {
                const apiKey = pick(p.presetId);
                if (!apiKey) {
                    return null;
                }
                return { presetId: p.presetId, model: p.model, apiKey, enabled: true };
            })
            .filter(Boolean);
        if (cloudProviders.length === 0) {
            throw new Error('未填写任何 MaaS API Key');
        }
        const response = await fetch('/v1/admin/model-providers', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cloudProviders }),
        });
        if (!response.ok) {
            throw new Error(await response.text());
        }
        const data = await response.json();
        return data.saved ?? cloudProviders.length;
    }

    /** 当前服务模式对应的 Bearer；本机推理优先 apiKeys.localhost，与 LlmProviderFactory 类型对齐 */
    getApiKeyForProvider(provider) {
        const keys = this.currentConfig.apiKeys || {};
        if (!provider) {
            return '';
        }
        const pick = (base) => {
            for (const id of [base, `${base}_2`, `${base}_3`]) {
                const v = keys[id];
                if (typeof v === 'string' && v.trim()) {
                    return v.trim();
                }
            }
            return '';
        };
        if (provider === 'yueli-native') {
            return pick('localhost');
        }
        if (provider === 'yueli-cloud') {
            return pick('yueliai');
        }
        if (LOCALHOST_BEARER_PROVIDERS.has(provider)) {
            return pick('localhost') || pick(provider);
        }
        return pick(provider);
    }

    buildPlaygroundAuthHeaders() {
        const token = this.getApiKeyForProvider(this.currentConfig.provider);
        if (!token) {
            return {};
        }
        return { Authorization: `Bearer ${token}` };
    }

    async refreshSandboxHowtoStatus() {
        const statusEl = document.getElementById('sandbox-howto-status');
        if (!statusEl) {
            return;
        }
        try {
            const response = await fetch('/v1/kgm/sandboxes');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json();
            const sandboxes = payload.sandboxes || [];
            const total = sandboxes.length;
            const ready = sandboxes.filter((s) => s.runtimeMode === 'external').length;
            const unconfigured = sandboxes.filter((s) => s.runtimeMode === 'unconfigured').length;
            const running = sandboxes.filter((s) => s.status === 'running').length;
            if (ready > 0) {
                statusEl.className = 'sandbox-howto-status is-ok';
                statusEl.textContent = `API 正常：${total} 个实例，${ready} 个已配置 adapter，${running} 个 running。`;
            } else {
                statusEl.className = 'sandbox-howto-status is-warn';
                statusEl.textContent = `API 正常：${total} 个实例，其中 ${unconfigured} 个 unconfigured（可创建/列表，启动需先配置 adapter）。`;
            }
        } catch (error) {
            statusEl.className = 'sandbox-howto-status is-warn';
            statusEl.textContent = `无法探测沙箱 API：${error.message || error}`;
        }
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
                    <li><strong>沙箱控制面</strong>：首页「沙箱调用」与 <code>sandbox.html</code> 共用 <code>/v1/kgm/sandboxes</code>；工具 <code>list_sandboxes</code> / <code>start_sandbox</code> / <code>stop_sandbox</code>。未配置 adapter 时启动返回 503。</li>
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
            if (this.currentConfig.provider === 'yueli-native') {
                this.statusService.textContent = 'yueli-native';
            } else if (this.currentConfig.provider === 'yueli-cloud') {
                this.statusService.textContent = 'yueli-cloud';
            } else {
                this.statusService.textContent = 'provider-routed';
            }
        }
        if (this.statusProvider) {
            if (this.currentConfig.provider === 'yueli-native') {
                this.statusProvider.textContent = 'Yueli-KGM 本地';
            } else if (this.currentConfig.provider === 'yueli-cloud') {
                const gw = this.currentConfig.yueliGateway || {};
                this.statusProvider.textContent = `YueliAI (${gw.host || 'www.yueli.com'})`;
            } else {
                this.statusProvider.textContent = this.currentConfig.provider || this.currentConfig.targetProvider || '自动';
            }
        }
        if (this.statusModel) this.statusModel.textContent = this.currentConfig.modelName || this.currentConfig.targetModel || '自动';
        if (this.statusProtocol) this.statusProtocol.textContent = this.currentConfig.protocol || 'chat.completions';
        if (this.statusStream) this.statusStream.textContent = this.currentConfig.stream !== false ? 'on' : 'off';
        if (this.statusRouting) {
            this.statusRouting.textContent = this.currentConfig.routingProfile || 'quality_first';
        }
        if (this.statusGateway) {
            const gw = this.currentConfig.yueliGateway || {};
            const keys = this.currentConfig.apiKeys || {};
            const hasKey = Boolean(keys.yueliai || keys.yueliai_2 || keys.yueliai_3);
            if (hasKey && gw.enabled !== false) {
                const host = (gw.host || 'https://www.yueli.com').replace(/^https?:\/\//, '');
                this.statusGateway.textContent = host;
            } else {
                this.statusGateway.textContent = '未配置';
            }
        }
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
            if (this.currentConfig.provider === 'yueli-cloud') {
                await this.handleYueliCloudSubmit();
                return;
            }
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
                await this.maybeGenerateImageViaMediaApi();
            }
        } catch (error) {
            console.error('提交错误:', error);
            this.showError(error.message);
        } finally {
            this.setLoadingState(false);
        }
    }

    /**
     * Optional image generation via OpenAI-compatible thin proxy (not trust-proxy).
     * Triggers when the prompt asks for an image; soft-degrades on 501.
     */
    async maybeGenerateImageViaMediaApi() {
        const prompt = (this.promptText?.value || '').trim();
        const lower = prompt.toLowerCase();
        const wantsImage =
            lower.includes('生成图片') ||
            lower.includes('画一张') ||
            /\b(generate|draw|create)\b.*\b(image|picture|logo)\b/i.test(prompt);
        if (!wantsImage) return;
        const model = this.currentConfig?.imageModel || 'dall-e-3';
        try {
            const res = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this.buildPlaygroundAuthHeaders(),
                },
                body: JSON.stringify({ model, prompt, n: 1 }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const code = body?.error?.code || `http_${res.status}`;
                if (String(code).endsWith('_not_configured') || res.status === 501) {
                    return;
                }
                console.warn('media image failed', body?.error || body);
                return;
            }
            const url = body?.data?.[0]?.url || body?.data?.[0]?.b64_json;
            if (url && this.imageOutput) {
                if (String(url).startsWith('http') || String(url).startsWith('data:')) {
                    this.imageOutput.innerHTML = `<img alt="generated" src="${url}" style="max-width:100%" />`;
                } else {
                    this.imageOutput.innerHTML = `<img alt="generated" src="data:image/png;base64,${url}" style="max-width:100%" />`;
                }
            }
        } catch (err) {
            console.warn('media image request error', err);
        }
    }

    async handleYueliCloudSubmit() {
        const prompt = this.promptText.value.trim();
        const requestData = {
            model: this.resolveModel() || 'deepseek/deepseek-v4-flash',
            input: prompt + this.buildMediaSummary(),
            stream: this.currentConfig.stream !== false,
        };
        const endpoint = requestData.stream ? '/yueliai/v1/completions/stream' : '/yueliai/v1/completions';
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.buildPlaygroundAuthHeaders(),
            },
            body: JSON.stringify(requestData),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`YueliAI ${response.status}: ${text}`);
        }
        if (requestData.stream) {
            await this.consumeYueliAiSse(response);
            return;
        }
        const result = await response.json();
        this.displayYueliAiResults(result);
    }

    displayYueliAiResults(result) {
        if (!result?.success) {
            const msg = result?.error?.message || JSON.stringify(result);
            this.showError(msg);
            return;
        }
        const content = result.data?.content || '';
        this.formatAndShowOutput(content);
        this.traceOutput.textContent = JSON.stringify({
            channel: 'yueliai',
            model: result.data?.model,
            usage: result.data?.usage,
            requestId: result.requestId,
        }, null, 2);
    }

    async consumeYueliAiSse(response) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('SSE body unavailable');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) {
                    continue;
                }
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') {
                    continue;
                }
                try {
                    const chunk = JSON.parse(payload);
                    const piece = chunk.content || chunk.data?.content || '';
                    if (piece) {
                        full += piece;
                        this.formatAndShowOutput(full);
                    }
                } catch {
                    // ignore partial json
                }
            }
        }
        this.traceOutput.textContent = JSON.stringify({ channel: 'yueliai', stream: true, length: full.length }, null, 2);
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
        this.activeIntegrationTab = name;
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
            this.applyYueliGatewayFromServer(data.yueliai);
            this.playgroundConfig = data.playground || {};
            this.playgroundConfigJson.value = JSON.stringify(this.playgroundConfig, null, 2);
            this.saveConfigToLocalStorage();
        } catch (error) {
            this.playgroundConfigJson.value = `{\n  "_loadError": ${JSON.stringify(error.message)}\n}`;
        }
    }

    async savePlaygroundToServer() {
        if (!this.playgroundConfigJson) {
            return;
        }
        try {
            const playground = this.parsePlaygroundConfigJson(this.playgroundConfigJson.value);
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
                pg = this.parsePlaygroundConfigJson(this.playgroundConfigJson.value);
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
        this.switchOutputTab('text');
        let pg;
        try {
            pg = this.parsePlaygroundConfigJson(this.playgroundConfigJson?.value);
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

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            padding: 10px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.2s ease;
            ${type === 'error' ? 'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;' : 'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;'}
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.2s ease';
            setTimeout(() => toast.remove(), 200);
        }, 2500);
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
        if (!normalized.yueliGateway || typeof normalized.yueliGateway !== 'object') {
            normalized.yueliGateway = {
                host: 'https://www.yueli.com',
                upstreamPrefix: '/api',
                enabled: true,
            };
        }
        if (normalized.provider === 'slang') {
            normalized.provider = 'sglang';
        }
        if (normalized.provider === 'llama.cpp' || normalized.provider === 'llamacpp') {
            normalized.provider = 'llama_cpp';
        }
        if (normalized.provider === 'litellm') {
            normalized.provider = '';
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
        this.switchOutputTab('stream');
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
            const [configResponse, summaryResponse, healthResponse] = await Promise.all([
                fetch('/v1/kgm/auto-routing'),
                fetch('/v1/kgm/auto-routing/summary?limit=8'),
                fetch('/v1/runtime/status'),
            ]);
            if (!configResponse.ok) {
                throw new Error(`auto routing config status ${configResponse.status}`);
            }
            const config = await configResponse.json();
            const summary = summaryResponse.ok ? await summaryResponse.json() : null;
            this.autoRoutingConfig = config;
            this.autoRoutingSummary = summary;
            this.renderAutoRoutingPanel();
            if (this.routingHealthPanel) {
                if (healthResponse.ok) {
                    const health = await healthResponse.json();
                    const workers = health.workers || {};
                    const native = health.native || {};
                    this.routingHealthPanel.innerHTML = `
                        <div class="routing-health-grid">
                            <span>LLM: ${health.llm?.healthy ? 'healthy' : 'degraded'} (${this.escapeHtml(health.llm?.model || '-')})</span>
                            <span>Native loaded: ${(native.loadedModels || []).length}</span>
                            <span>llama.cpp: ${workers.llamaCpp?.selectable ? 'ready' : (workers.llamaCpp?.reason || 'n/a')}</span>
                            <span>ds4: ${workers.ds4?.selectable ? 'ready' : (workers.ds4?.reason || 'n/a')}</span>
                            <span>tokenspeed: ${workers.tokenspeed?.selectable ? 'ready' : (workers.tokenspeed?.reason || 'off')}</span>
                        </div>`;
                } else {
                    this.routingHealthPanel.textContent = `健康状态不可用 (${healthResponse.status})`;
                }
            }
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
        if (this.routingMaxCandidates) this.routingMaxCandidates.value = String(config.thresholds?.maxCandidateCount ?? 6);
        if (this.routingAuditEnabled) this.routingAuditEnabled.checked = config.auditEnabled !== false;
        if (this.routingEvalEnabled) this.routingEvalEnabled.checked = config.evaluation?.enabled !== false;
        if (this.routingEvalFallback) this.routingEvalFallback.checked = config.evaluation?.fallbackToHeuristics !== false;
        if (this.routingJudgeEnabled) this.routingJudgeEnabled.checked = config.evaluation?.judge?.enabled !== false;
        if (this.routingJudgeProvider) this.routingJudgeProvider.value = config.evaluation?.judge?.target?.provider || '';
        if (this.routingJudgeModel) this.routingJudgeModel.value = config.evaluation?.judge?.target?.model || '';
        if (this.routingVerifierEnabled) this.routingVerifierEnabled.checked = config.evaluation?.verifier?.enabled !== false;
        if (this.routingVerifierProvider) this.routingVerifierProvider.value = config.evaluation?.verifier?.target?.provider || '';
        if (this.routingVerifierModel) this.routingVerifierModel.value = config.evaluation?.verifier?.target?.model || '';
        Object.entries(this.routingWeightInputs || {}).forEach(([key, input]) => {
            if (input) input.value = String(config.weights?.[key] ?? 0);
        });
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
                <strong>$${(summary.totals?.actualCost ?? 0).toFixed(8)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>评估成本</span>
                <strong>$${(summary.totals?.evaluationCost ?? 0).toFixed(8)}</strong>
            </div>
            <div class="routing-summary-card">
                <span>总成本</span>
                <strong>$${(summary.totals?.totalCost ?? 0).toFixed(8)}</strong>
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
                    <span>latency: ${Math.round(item.avgLatencyMs || 0)} ms · gen cost: $${(item.avgCost || 0).toFixed(8)} · eval cost: $${(item.avgEvaluationCost || 0).toFixed(8)}</span>
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
                    <span>success: ${item.success ? 'yes' : 'no'} · latency: ${Math.round(item.latencyMs || 0)} ms · gen: $${(item.actualCost || 0).toFixed(8)} · eval: $${(item.evaluationCost || 0).toFixed(8)} · total: $${(item.totalCost || 0).toFixed(8)}</span>
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
                targetLatencyMs: Number(this.routingTargetLatency?.value || this.autoRoutingConfig?.thresholds?.targetLatencyMs || 3500),
                maxCandidateCount: Number(this.routingMaxCandidates?.value || this.autoRoutingConfig?.thresholds?.maxCandidateCount || 6),
            },
            weights: Object.fromEntries(
                Object.entries(this.routingWeightInputs || {}).map(([key, input]) => [
                    key,
                    Number(input?.value || this.autoRoutingConfig?.weights?.[key] || 0),
                ]),
            ),
            auditEnabled: this.routingAuditEnabled?.checked !== false,
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

const PROVIDER_ALIASES = [
    'aliyun',
    'aliyun_bailian',
    'anthropic',
    'aws_bedrock',
    'azure_openai',
    'baidu_qianfan',
    'custom',
    'deepseek',
    'ds4',
    'fireworks',
    'gemini',
    'groq',
    'huggingface',
    'koboldcpp',
    'llama_cpp',
    'lmstudio',
    'minimax',
    'mistral',
    'modelscope',
    'moonshot',
    'nvidia',
    'ollama',
    'openai',
    'openrouter',
    'perplexity',
    'sglang',
    'text_generation_webui',
    'together',
    'volcengine_ark',
    'vllm',
    'vmlx',
    'xiaomi',
    'yueli-cloud',
    'zhipu',
];

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    window.kgmPlaygroundInstance = new KGMTrustProxyPlayground();
    
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
