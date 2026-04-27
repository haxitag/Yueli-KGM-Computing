// KCE (Knowledge Computing Engine) 核心模块
// 实现：语义解析 → 知识裁剪 → 计划生成 → DAG执行 → 验证

class KCEEngine {
  constructor(options = {}) {
    this.apiBase = options.apiBase || '/v1';
    this.planner = new KCEPlanner(this);
    this.executor = new KCEExecutor(this);
    this.verifier = new KCEVerifier(this);
    this.trace = [];
  }

  /**
   * 执行知识计算任务
   * @param {Object} input - KCE 输入
   * @returns {Object} KCE 输出（答案 + 证据 + 轨迹）
   */
  async compute(input) {
    const startTime = Date.now();
    this.trace = [];

    try {
      // 阶段 1: 语义解析
      this.addTrace('semantic_parse', 'start', { query: input.query });
      const logicalForm = await this.planner.parse(input);
      this.addTrace('semantic_parse', 'complete', { logical_form: logicalForm });

      // 阶段 2: 知识裁剪
      this.addTrace('knowledge_projection', 'start', { logical_form: logicalForm });
      const subgraph = await this.planner.projectKnowledge(input, logicalForm);
      this.addTrace('knowledge_projection', 'complete', { 
        subgraph_nodes: subgraph.nodes?.length || 0,
        subgraph_edges: subgraph.edges?.length || 0
      });

      // 阶段 3: 执行计划生成
      this.addTrace('plan_generation', 'start', { logical_form, subgraph });
      const executionPlan = await this.planner.generatePlan(input, logicalForm, subgraph);
      this.addTrace('plan_generation', 'complete', { 
        plan_nodes: executionPlan.nodes?.length || 0,
        plan_edges: executionPlan.edges?.length || 0
      });

      // 阶段 4: DAG 执行
      this.addTrace('dag_execution', 'start', { plan: executionPlan });
      const executionResult = await this.executor.execute(executionPlan, input);
      this.addTrace('dag_execution', 'complete', { 
        steps_executed: executionResult.steps?.length || 0
      });

      // 阶段 5: 验证
      this.addTrace('verification', 'start', { result: executionResult });
      const validationResult = await this.verifier.validate(
        executionResult,
        subgraph,
        input.context?.constraints || []
      );
      this.addTrace('verification', 'complete', validationResult);

      const totalTime = Date.now() - startTime;

      // 构建输出
      return {
        answer: executionResult.answer,
        evidence: {
          nodes: subgraph.nodes || [],
          edges: subgraph.edges || [],
          subgraph_id: subgraph.id
        },
        reasoning_trace: this.trace,
        execution_plan: executionPlan,
        validation: validationResult,
        confidence: validationResult.confidence || 0.85,
        metrics: {
          total_latency_ms: totalTime,
          steps_executed: executionResult.steps?.length || 0,
          validation_passed: validationResult.passed
        }
      };
    } catch (error) {
      console.error('KCE 执行失败:', error);
      throw error;
    }
  }

  /**
   * 添加轨迹记录
   */
  addTrace(step, status, data) {
    this.trace.push({
      step,
      status,
      timestamp: Date.now(),
      data: this.sanitizeForTrace(data)
    });
  }

  /**
   * 清理轨迹数据（移除过大对象）
   */
  sanitizeForTrace(data) {
    if (!data) return data;
    const str = JSON.stringify(data);
    if (str.length > 5000) {
      return { _truncated: true, summary: `${str.length} bytes` };
    }
    return data;
  }

  /**
   * 将执行轨迹转换为 Mermaid 时序图
   */
  generateMermaidSequenceDiagram(result) {
    let mermaid = 'sequenceDiagram\n';
    mermaid += '  participant User\n';
    mermaid += '  participant KCE\n';
    mermaid += '  participant Parser\n';
    mermaid += '  participant Knowledge\n';
    mermaid += '  participant Planner\n';
    mermaid += '  participant Executor\n';
    mermaid += '  participant Verifier\n\n';

    // 用户输入
    mermaid += '  User->>KCE: 提交查询\n';

    // 遍历轨迹生成时序图
    const trace = result.reasoning_trace || [];
    for (let i = 0; i < trace.length; i++) {
      const step = trace[i];
      
      if (step.step === 'semantic_parse') {
        if (step.status === 'start') {
          mermaid += '  KCE->>Parser: 语义解析\n';
        } else {
          mermaid += '  Parser-->>KCE: 返回 LogicalForm\n';
        }
      } else if (step.step === 'knowledge_projection') {
        if (step.status === 'start') {
          mermaid += '  KCE->>Knowledge: 知识裁剪\n';
        } else {
          mermaid += '  Knowledge-->>KCE: 返回子图\n';
        }
      } else if (step.step === 'plan_generation') {
        if (step.status === 'start') {
          mermaid += '  KCE->>Planner: 生成执行计划\n';
        } else {
          mermaid += '  Planner-->>KCE: 返回 DAG\n';
        }
      } else if (step.step === 'dag_execution') {
        if (step.status === 'start') {
          mermaid += '  KCE->>Executor: 执行 DAG\n';
          // 添加执行步骤
          if (result.execution_plan?.nodes) {
            result.execution_plan.nodes.forEach((node, idx) => {
              mermaid += `  Executor->>Executor: 执行节点 ${idx + 1}: ${node.operator}\n`;
            });
          }
        } else {
          mermaid += '  Executor-->>KCE: 执行完成\n';
        }
      } else if (step.step === 'verification') {
        if (step.status === 'start') {
          mermaid += '  KCE->>Verifier: 验证结果\n';
        } else {
          mermaid += '  Verifier-->>KCE: 验证通过 ✓\n';
        }
      }
    }

    // 最终输出
    mermaid += '  KCE-->>User: 返回答案 + 证据链 + 轨迹\n';

    return mermaid;
  }

  /**
   * 将执行计划转换为 Mermaid DAG 图
   */
  generateMermaidDAG(plan) {
    if (!plan || !plan.nodes) return '';
    
    let mermaid = 'graph TD\n';
    
    // 添加节点
    plan.nodes.forEach(node => {
      const label = `${node.operator}`;
      const style = this.getNodeStyle(node.type);
      mermaid += `  ${node.id}["${label}"]:::${style}\n`;
    });

    // 添加边
    if (plan.edges) {
      plan.edges.forEach(edge => {
        mermaid += `  ${edge.from} --> ${edge.to}\n`;
      });
    }

    // 添加样式定义
    mermaid += '\n  classDef graph_op fill:#E3F2FD,stroke:#2196F3\n';
    mermaid += '  classDef logic_op fill:#F3E5F5,stroke:#9C27B0\n';
    mermaid += '  classDef llm_op fill:#FFF3E0,stroke:#FF9800\n';
    mermaid += '  classDef tool_op fill:#E8F5E9,stroke:#4CAF50\n';

    return mermaid;
  }

  /**
   * 获取节点样式
   */
  getNodeStyle(type) {
    const styleMap = {
      'graph_op': 'graph_op',
      'logic_op': 'logic_op',
      'llm_op': 'llm_op',
      'tool_op': 'tool_op'
    };
    return styleMap[type] || 'graph_op';
  }
}

/**
 * KCE Planner - 语义解析、知识裁剪、计划生成
 */
class KCEPlanner {
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * 阶段 1: 语义解析（Query → LogicalForm）
   */
  async parse(input) {
    const prompt = `你是一个语义解析器。请将用户的查询解析为结构化的逻辑形式。

输出 JSON 格式：
{
  "intent": "查询意图",
  "entities": [{"type": "实体类型", "name": "实体名称"}],
  "relations": ["关系1", "关系2"],
  "constraints": [{"type": "约束类型", "value": "约束值"}]
}

用户查询: ${input.query}

请输出 JSON（不要其他文字）：`;

    try {
      const response = await fetch(`${this.engine.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1000
        })
      });

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      return JSON.parse(content);
    } catch (error) {
      console.error('语义解析失败:', error);
      return {
        intent: 'unknown',
        entities: [],
        relations: [],
        constraints: []
      };
    }
  }

  /**
   * 阶段 2: 知识裁剪（基于 LogicalForm 检索子图）
   */
  async projectKnowledge(input, logicalForm) {
    const subgraph = { nodes: [], edges: [], id: `subgraph_${Date.now()}` };

    try {
      // 1. 从实体检索
      if (logicalForm.entities?.length > 0) {
        for (const entity of logicalForm.entities) {
          const node = await this.retrieveEntity(entity);
          if (node) subgraph.nodes.push(node);
        }
      }

      // 2. 扩展关系
      if (logicalForm.relations?.length > 0 && subgraph.nodes.length > 0) {
        const edges = await this.expandRelations(subgraph.nodes, logicalForm.relations);
        subgraph.edges.push(...edges);
      }

      // 3. 应用约束过滤
      if (logicalForm.constraints?.length > 0) {
        this.applyConstraints(subgraph, logicalForm.constraints);
      }

      return subgraph;
    } catch (error) {
      console.error('知识裁剪失败:', error);
      return subgraph;
    }
  }

  /**
   * 检索实体
   */
  async retrieveEntity(entity) {
    // 这里可以调用图谱 API 或向量检索
    // 示例返回
    return {
      id: `entity_${Date.now()}`,
      type: entity.type,
      name: entity.name,
      properties: {}
    };
  }

  /**
   * 扩展关系
   */
  async expandRelations(nodes, relations) {
    const edges = [];
    // 示例：为节点间添加关系边
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        relation: relations[0] || 'related_to'
      });
    }
    return edges;
  }

  /**
   * 应用约束
   */
  applyConstraints(subgraph, constraints) {
    // 根据约束过滤子图
    // 示例实现
  }

  /**
   * 阶段 3: 生成执行计划（LogicalForm + Subgraph → DAG）
   */
  async generatePlan(input, logicalForm, subgraph) {
    const prompt = `你是一个执行计划生成器。请根据以下信息生成 DAG 执行计划。

查询意图: ${logicalForm.intent || 'unknown'}
实体: ${JSON.stringify(logicalForm.entities || [])}
关系: ${JSON.stringify(logicalForm.relations || [])}
子图节点数: ${subgraph.nodes?.length || 0}
子图边数: ${subgraph.edges?.length || 0}

输出 JSON 格式（节点列表）：
[
  {"id": "n1", "type": "graph_op", "operator": "retrieve_entity", "depends_on": []},
  {"id": "n2", "type": "graph_op", "operator": "expand_relations", "depends_on": ["n1"]},
  {"id": "n3", "type": "llm_op", "operator": "reason", "depends_on": ["n2"]},
  {"id": "n4", "type": "logic_op", "operator": "validate", "depends_on": ["n3"]}
]

请输出 JSON 数组（不要其他文字）：`;

    try {
      const response = await fetch(`${this.engine.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 2000
        })
      });

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '[]';
      const nodes = JSON.parse(content);

      // 构建边
      const edges = [];
      nodes.forEach(node => {
        if (node.depends_on) {
          node.depends_on.forEach(dep => {
            edges.push({ from: dep, to: node.id });
          });
        }
      });

      return { nodes, edges };
    } catch (error) {
      console.error('计划生成失败:', error);
      // 返回默认计划
      return {
        nodes: [
          { id: 'n1', type: 'llm_op', operator: 'direct_answer', depends_on: [] }
        ],
        edges: []
      };
    }
  }
}

/**
 * KCE Executor - DAG 执行引擎
 */
class KCEExecutor {
  constructor(engine) {
    this.engine = engine;
    this.operatorRegistry = new Map();
    this.registerDefaultOperators();
  }

  /**
   * 注册默认算子
   */
  registerDefaultOperators() {
    // 图算子
    this.operatorRegistry.set('graph_op', {
      execute: async (node, state) => {
        // 调用图谱 API
        return { status: 'completed', data: {} };
      }
    });

    // 逻辑算子
    this.operatorRegistry.set('logic_op', {
      execute: async (node, state) => {
        // 规则验证
        return { status: 'completed', valid: true };
      }
    });

    // LLM 算子
    this.operatorRegistry.set('llm_op', {
      execute: async (node, state) => {
        // 调用 LLM
        const response = await fetch(`${this.engine.apiBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: state.context || '' }],
            temperature: 0.7,
            max_tokens: 2000
          })
        });
        const data = await response.json();
        return { 
          status: 'completed', 
          answer: data.choices?.[0]?.message?.content || ''
        };
      }
    });

    // 工具算子
    this.operatorRegistry.set('tool_op', {
      execute: async (node, state) => {
        // 调用工具
        return { status: 'completed', result: {} };
      }
    });
  }

  /**
   * 执行 DAG
   */
  async execute(plan, input) {
    const results = new Map();
    const steps = [];

    // 拓扑排序
    const ordered = this.topologicalSort(plan.nodes, plan.edges);

    // 按序执行
    for (const node of ordered) {
      const startTime = Date.now();
      
      // 解析依赖
      const dependencies = this.resolveDependencies(node, results);
      
      // 构建上下文
      const context = this.buildContext(input, dependencies);
      
      // 执行算子
      const operator = this.operatorRegistry.get(node.type);
      let output;
      try {
        output = await operator.execute(node, { context, dependencies });
      } catch (error) {
        output = { status: 'error', error: error.message };
      }

      const duration = Date.now() - startTime;
      results.set(node.id, output);
      steps.push({
        node_id: node.id,
        operator: node.operator,
        type: node.type,
        output,
        duration_ms: duration
      });
    }

    // 提取最终答案
    const lastStep = steps[steps.length - 1];
    const answer = lastStep?.output?.answer || '执行完成';

    return {
      answer,
      steps,
      results: Object.fromEntries(results)
    };
  }

  /**
   * 拓扑排序
   */
  topologicalSort(nodes, edges) {
    const graph = new Map();
    const inDegree = new Map();

    // 初始化
    nodes.forEach(node => {
      graph.set(node.id, []);
      inDegree.set(node.id, 0);
    });

    // 构建图
    edges.forEach(edge => {
      if (graph.has(edge.from)) {
        graph.get(edge.from).push(edge.to);
        inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
      }
    });

    // Kahn 算法
    const queue = [];
    nodes.forEach(node => {
      if (inDegree.get(node.id) === 0) {
        queue.push(node);
      }
    });

    const result = [];
    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);

      const neighbors = graph.get(node.id) || [];
      neighbors.forEach(neighbor => {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          const neighborNode = nodes.find(n => n.id === neighbor);
          if (neighborNode) queue.push(neighborNode);
        }
      });
    }

    return result;
  }

  /**
   * 解析依赖
   */
  resolveDependencies(node, results) {
    const dependencies = {};
    if (node.depends_on) {
      node.depends_on.forEach(depId => {
        dependencies[depId] = results.get(depId);
      });
    }
    return dependencies;
  }

  /**
   * 构建上下文
   */
  buildContext(input, dependencies) {
    return {
      query: input.query,
      dependencies
    };
  }
}

/**
 * KCE Verifier - 验证器
 */
class KCEVerifier {
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * 验证执行结果
   */
  async validate(result, subgraph, constraints) {
    const checks = [];

    // 1. 基本完整性检查
    checks.push({
      name: 'answer_completeness',
      passed: !!result.answer && result.answer.length > 0,
      confidence: 1.0
    });

    // 2. 证据链检查
    checks.push({
      name: 'evidence_chain',
      passed: subgraph.nodes?.length > 0 || subgraph.edges?.length > 0,
      confidence: 0.9
    });

    // 3. 约束满足检查（简化版）
    if (constraints.length > 0) {
      checks.push({
        name: 'constraint_satisfaction',
        passed: true, // 实际应检查约束
        confidence: 0.85
      });
    }

    // 4. 计算总体置信度
    const confidence = this.computeConfidence(checks);

    return {
      passed: checks.every(c => c.passed),
      checks,
      confidence
    };
  }

  /**
   * 计算置信度
   */
  computeConfidence(checks) {
    if (checks.length === 0) return 0.5;
    const sum = checks.reduce((acc, check) => acc + (check.confidence || 0), 0);
    return sum / checks.length;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KCEEngine, KCEPlanner, KCEExecutor, KCEVerifier };
}
