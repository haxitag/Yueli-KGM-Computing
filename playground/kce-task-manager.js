// KCE 任务管理模块 - Playground 集成
// 负责任务创建、执行、时序图渲染

// KCE API 客户端 - 调用服务端 /v1/kgm/kce/compute
class KCEApiClient {
  constructor(apiBase = '/v1') {
    this.apiBase = apiBase;
    this.trace = [];
  }

  async compute(request) {
    this.trace = [];
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${this.apiBase}/kgm/kce/compute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: request.query,
          kce: {
            mode: request.policy?.mode || 'quality',
            llm: { enabled: true }
          },
          userId: 'playground_user',
          kgm: request.context?.kgm || {}
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      
      // 构建前端兼容的 trace
      this.trace = result.reasoning_trace || [];
      
      return {
        answer: result.answer,
        logical_form: result.logical_form,
        evidence: result.evidence,
        reasoning_trace: result.reasoning_trace,
        execution_plan: result.execution_plan,
        validation: result.validation,
        confidence: result.confidence,
        metrics: result.metrics
      };
    } catch (error) {
      this.trace.push({
        step: 'api_call',
        status: 'error',
        timestamp: Date.now(),
        data: { message: error.message }
      });
      throw error;
    }
  }

  generateMermaidSequenceDiagram(result) {
    const trace = result.reasoning_trace || [];
    let mermaid = 'sequenceDiagram\n';
    mermaid += '    participant User\n';
    mermaid += '    participant KCE\n';
    mermaid += '    participant Graph\n';
    mermaid += '    participant Memory\n';
    mermaid += '    participant LLM\n\n';

    trace.forEach(step => {
      const stepName = step.step || 'unknown';
      const status = step.status || 'unknown';
      
      if (stepName === 'semantic_parse') {
        mermaid += '    User->>KCE: Query\n';
        mermaid += '    KCE->>LLM: Parse intent\n';
        mermaid += `    LLM-->>KCE: ${status}\n`;
      } else if (stepName === 'knowledge_projection') {
        mermaid += '    KCE->>Graph: Query subgraph\n';
        mermaid += '    KCE->>Memory: Retrieve evidence\n';
        mermaid += `    Graph-->>KCE: ${status}\n`;
        mermaid += `    Memory-->>KCE: ${status}\n`;
      } else if (stepName === 'plan_generation') {
        mermaid += '    KCE->>KCE: Generate DAG\n';
        mermaid += `    KCE-->>KCE: ${status}\n`;
      } else if (stepName === 'dag_execution') {
        mermaid += '    KCE->>Graph: Execute operations\n';
        mermaid += `    Graph-->>KCE: ${status}\n`;
      } else if (stepName === 'verification') {
        mermaid += '    KCE->>KCE: Validate answer\n';
        mermaid += `    KCE-->>KCE: ${status}\n`;
      }
    });

    mermaid += '    KCE-->>User: Answer\n';
    return mermaid;
  }

  generateMermaidDAG(executionPlan) {
    if (!executionPlan || !executionPlan.nodes) {
      return 'graph TD\n    A[No Plan Available]';
    }

    let mermaid = 'graph TD\n';
    
    // Add nodes
    executionPlan.nodes.forEach(node => {
      const label = `${node.id}\n(${node.operator})`;
      mermaid += `    ${node.id}["${label}"]\n`;
    });

    // Add edges
    executionPlan.edges.forEach(edge => {
      mermaid += `    ${edge.from} --> ${edge.to}\n`;
    });

    return mermaid;
  }
}

class KCETaskManager {
  constructor(playground) {
    this.playground = playground;
    this.tasks = [];
    this.currentTask = null;
    this.kceEngine = new KCEApiClient(this.playground.apiBase || '/v1');
    
    this.initializeElements();
    this.setupEventListeners();
  }

  initializeElements() {
    this.newTaskBtn = document.getElementById('new-task-btn');
    this.runTaskBtn = document.getElementById('run-task-btn');
    this.clearTasksBtn = document.getElementById('clear-tasks-btn');
    this.taskList = document.getElementById('task-list');
    this.taskDetail = document.getElementById('task-detail');
    this.taskQuery = document.getElementById('task-query');
    this.taskStatus = document.getElementById('task-status');
    this.taskDuration = document.getElementById('task-duration');
    this.sequenceDiagram = document.getElementById('sequence-diagram');
    this.dagDiagram = document.getElementById('dag-diagram');
    this.taskTraceOutput = document.getElementById('task-trace-output');
  }

  setupEventListeners() {
    if (this.newTaskBtn) {
      this.newTaskBtn.addEventListener('click', () => this.createNewTask());
    }
    if (this.runTaskBtn) {
      this.runTaskBtn.addEventListener('click', () => this.runCurrentTask());
    }
    if (this.clearTasksBtn) {
      this.clearTasksBtn.addEventListener('click', () => this.clearAllTasks());
    }
  }

  /**
   * 创建新任务
   */
  createNewTask() {
    const query = this.playground.promptText?.value || '';
    if (!query.trim()) {
      alert('请先在输入框中输入查询内容');
      return;
    }

    const task = {
      id: `task_${Date.now()}`,
      query: query,
      status: 'pending',
      createdAt: new Date(),
      result: null,
      duration: null
    };

    this.tasks.unshift(task);
    this.renderTaskList();
    this.selectTask(task.id);
    
    // 启用执行按钮
    if (this.runTaskBtn) {
      this.runTaskBtn.disabled = false;
    }
  }

  /**
   * 渲染任务列表
   */
  renderTaskList() {
    if (!this.taskList) return;

    this.taskList.innerHTML = '';
    
    if (this.tasks.length === 0) {
      this.taskList.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">暂无任务，点击"新建任务"开始</p>';
      return;
    }

    this.tasks.forEach(task => {
      const taskItem = document.createElement('div');
      taskItem.className = `task-item ${this.currentTask?.id === task.id ? 'active' : ''}`;
      taskItem.onclick = () => this.selectTask(task.id);

      const statusClass = `task-status-${task.status}`;
      const statusText = {
        'pending': '待执行',
        'running': '执行中',
        'completed': '已完成',
        'error': '失败'
      }[task.status] || task.status;

      taskItem.innerHTML = `
        <div class="task-item-header">
          <span class="task-item-title">${task.id.slice(0, 12)}...</span>
          <span class="task-item-status ${statusClass}">${statusText}</span>
        </div>
        <div class="task-item-query">${task.query}</div>
      `;

      this.taskList.appendChild(taskItem);
    });
  }

  /**
   * 选择任务
   */
  selectTask(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;

    this.currentTask = task;
    this.renderTaskList();

    // 显示任务详情
    if (this.taskDetail) {
      this.taskDetail.hidden = false;
      this.taskQuery.textContent = task.query;
      
      const statusText = {
        'pending': '待执行',
        'running': '执行中',
        'completed': '已完成',
        'error': '失败'
      }[task.status] || task.status;
      
      this.taskStatus.textContent = statusText;
      this.taskStatus.className = `info-value task-status-${task.status}`;
      
      this.taskDuration.textContent = task.duration ? `${task.duration}ms` : '-';

      // 如果有结果，渲染图表
      if (task.result) {
        this.renderDiagrams(task.result);
        this.renderTrace(task.result);
      } else {
        this.sequenceDiagram.innerHTML = '<p style="color: #999;">执行后将显示时序图</p>';
        this.dagDiagram.innerHTML = '<p style="color: #999;">执行后将显示 DAG</p>';
        this.taskTraceOutput.textContent = '等待执行...';
      }
    }
  }

  /**
   * 执行当前任务
   */
  async runCurrentTask() {
    if (!this.currentTask || this.currentTask.status === 'running') return;

    const task = this.currentTask;
    task.status = 'running';
    this.renderTaskList();
    this.selectTask(task.id);

    const startTime = Date.now();

    try {
      // 调用 KCE 引擎
      const result = await this.kceEngine.compute({
        query: task.query,
        context: {},
        policy: { mode: 'quality' }
      });

      const duration = Date.now() - startTime;
      
      task.status = 'completed';
      task.result = result;
      task.duration = duration;

      this.renderTaskList();
      this.selectTask(task.id);

    } catch (error) {
      const duration = Date.now() - startTime;
      
      task.status = 'error';
      task.duration = duration;
      task.result = {
        error: error.message,
        reasoning_trace: this.kceEngine.trace
      };

      this.renderTaskList();
      this.selectTask(task.id);
    }
  }

  /**
   * 渲染时序图和 DAG
   */
  async renderDiagrams(result) {
    if (!result) return;

    // 渲染时序图
    if (this.sequenceDiagram) {
      try {
        const sequenceMermaid = this.kceEngine.generateMermaidSequenceDiagram(result);
        this.sequenceDiagram.innerHTML = `<div class="mermaid">${sequenceMermaid}</div>`;
        await mermaid.run({
          nodes: [this.sequenceDiagram.querySelector('.mermaid')]
        });
      } catch (error) {
        console.error('时序图渲染失败:', error);
        this.sequenceDiagram.innerHTML = `<p style="color: #999;">时序图渲染失败: ${error.message}</p>`;
      }
    }

    // 渲染 DAG
    if (this.dagDiagram && result.execution_plan) {
      try {
        const dagMermaid = this.kceEngine.generateMermaidDAG(result.execution_plan);
        this.dagDiagram.innerHTML = `<div class="mermaid">${dagMermaid}</div>`;
        await mermaid.run({
          nodes: [this.dagDiagram.querySelector('.mermaid')]
        });
      } catch (error) {
        console.error('DAG 渲染失败:', error);
        this.dagDiagram.innerHTML = `<p style="color: #999;">DAG 渲染失败: ${error.message}</p>`;
      }
    }
  }

  /**
   * 渲染执行轨迹
   */
  renderTrace(result) {
    if (!this.taskTraceOutput || !result) return;

    const trace = result.reasoning_trace || [];
    const output = trace.map(step => {
      const time = new Date(step.timestamp).toLocaleTimeString();
      return `[${time}] ${step.step} - ${step.status}\n${JSON.stringify(step.data, null, 2)}`;
    }).join('\n\n');

    this.taskTraceOutput.textContent = output || '无轨迹数据';
  }

  /**
   * 清空所有任务
   */
  clearAllTasks() {
    if (this.tasks.length === 0) return;
    
    if (confirm('确定要清空所有任务吗？')) {
      this.tasks = [];
      this.currentTask = null;
      this.renderTaskList();
      
      if (this.taskDetail) {
        this.taskDetail.hidden = true;
      }
      
      if (this.runTaskBtn) {
        this.runTaskBtn.disabled = true;
      }
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KCETaskManager;
}
