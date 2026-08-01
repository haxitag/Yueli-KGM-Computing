/**
 * 分布式任务调度器
 * 支持负载均衡、故障转移和任务队列
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { ClusterManager, ClusterNode } from './cluster.js';

export interface TaskDefinition {
  /** 任务ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务类型 */
  type: string;
  /** 任务负载 */
  payload: any;
  /** 优先级 (1-10, 1最高) */
  priority: number;
  /** 创建时间 */
  createdAt: Date;
  /** 过期时间 */
  expiresAt?: Date;
  /** 最大重试次数 */
  maxRetries: number;
  /** 当前重试次数 */
  retryCount: number;
  /** 任务状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** 分配到的节点ID */
  assignedNode?: string;
  /** 结果 */
  result?: any;
  /** 错误信息 */
  error?: string;
  /** 元数据 */
  metadata: Record<string, any>;
}

export interface SchedulerConfig {
  /** 队列类型：memory|redis|database */
  queueType: 'memory' | 'redis' | 'database';
  /** 队列最大长度 */
  maxQueueSize: number;
  /** 任务超时时间（毫秒） */
  taskTimeout: number;
  /** 任务重试延迟（毫秒） */
  retryDelay: number;
  /** 负载均衡策略：round-robin|least-load|affinity */
  loadBalancing: 'round-robin' | 'least-load' | 'affinity';
  /** 是否启用任务持久化 */
  persistence: boolean;
  /** 并行任务数限制（每节点） */
  concurrencyPerNode: number;
}

export interface WorkerMetrics {
  /** 节点ID */
  nodeId: string;
  /** 处理中的任务数 */
  activeTasks: number;
  /** 总完成的任务数 */
  completedTasks: number;
  /** 总失败的任务数 */
  failedTasks: number;
  /** 平均处理时间（毫秒） */
  avgProcessingTime: number;
  /** 最后心跳时间 */
  lastHeartbeat: Date;
  /** 节点负载评分（0-100） */
  loadScore: number;
  /** 自定义标签 */
  tags: string[];
}

export interface TaskResult {
  /** 任务ID */
  taskId: string;
  /** 任务状态 */
  status: 'completed' | 'failed';
  /** 结果 */
  result?: any;
  /** 错误信息 */
  error?: string;
  /** 处理节点 */
  processingNode: string;
  /** 开始时间 */
  startTime: Date;
  /** 结束时间 */
  endTime: Date;
  /** 耗时（毫秒） */
  duration: number;
}

/**
 * 分布式任务调度器
 */
export class DistributedScheduler extends EventEmitter {
  private cluster: ClusterManager;
  private config: SchedulerConfig;
  private taskQueue: Map<string, TaskDefinition> = new Map();
  private pendingTasks: string[] = []; // 按优先级排序的任务ID列表
  private runningTasks: Map<string, TaskDefinition> = new Map();
  private workerMetrics: Map<string, WorkerMetrics> = new Map();
  private processingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private taskProcessors: Map<string, (task: TaskDefinition) => Promise<any>> = new Map();
  
  constructor(
    cluster: ClusterManager,
    config: Partial<SchedulerConfig> = {}
  ) {
    super();
    
    this.cluster = cluster;
    this.config = {
      queueType: config.queueType || 'memory',
      maxQueueSize: config.maxQueueSize || 10000,
      taskTimeout: config.taskTimeout || 300000, // 5分钟
      retryDelay: config.retryDelay || 5000,
      loadBalancing: config.loadBalancing || 'least-load',
      persistence: config.persistence || false,
      concurrencyPerNode: config.concurrencyPerNode || 10,
    };
    
    // 订阅集群事件
    this.cluster.on('node.join', this.handleNodeJoin.bind(this));
    this.cluster.on('node.leave', this.handleNodeLeave.bind(this));
    
    // 启动任务处理循环
    this.startProcessingLoop();
    
    // 启动指标收集
    this.startMetricsCollection();
  }
  
  /**
   * 注册任务处理器
   */
  registerTaskHandler(
    taskType: string,
    handler: (task: TaskDefinition) => Promise<any>
  ): void {
    this.taskProcessors.set(taskType, handler);
    console.log(`✅ 注册任务处理器: ${taskType}`);
  }
  
  /**
   * 提交任务
   */
  async submitTask(
    name: string,
    type: string,
    payload: any,
    options: {
      priority?: number;
      expiresIn?: number; // 毫秒
      maxRetries?: number;
      metadata?: Record<string, any>;
      affinity?: string; // 亲和性标签
    } = {}
  ): Promise<string> {
    // 检查队列是否已满
    if (this.taskQueue.size >= this.config.maxQueueSize) {
      throw new Error('Task queue is full');
    }
    
    const taskId = randomUUID();
    const now = new Date();
    
    const task: TaskDefinition = {
      id: taskId,
      name,
      type,
      payload,
      priority: options.priority || 5,
      createdAt: now,
      expiresAt: options.expiresIn ? new Date(now.getTime() + options.expiresIn) : undefined,
      maxRetries: options.maxRetries || 3,
      retryCount: 0,
      status: 'pending',
      metadata: options.metadata || {},
    };
    
    // 保存任务
    this.taskQueue.set(taskId, task);
    
    // 添加到待处理队列（按优先级排序）
    this.addToPendingQueue(taskId, task.priority);
    
    console.log(`📝 提交任务: ${name} (${taskId})`);
    this.emit('task.submitted', task);
    
    // 立即尝试调度
    this.scheduleTasks();
    
    return taskId;
  }
  
  /**
   * 获取任务状态
   */
  getTaskStatus(taskId: string): TaskDefinition | null {
    return (
      this.taskQueue.get(taskId) ||
      this.runningTasks.get(taskId) ||
      null
    );
  }
  
  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.taskQueue.get(taskId) || this.runningTasks.get(taskId);
    
    if (!task) {
      return false;
    }
    
    if (task.status === 'running') {
      // 如果任务正在运行，通知处理节点取消
      if (task.assignedNode) {
        await this.notifyNodeToCancel(task.assignedNode, taskId);
      }
    }
    
    task.status = 'cancelled';
    
    // 从相应队列中移除
    if (this.taskQueue.has(taskId)) {
      const index = this.pendingTasks.indexOf(taskId);
      if (index !== -1) {
        this.pendingTasks.splice(index, 1);
      }
      this.taskQueue.delete(taskId);
    } else if (this.runningTasks.has(taskId)) {
      this.runningTasks.delete(taskId);
    }
    
    console.log(`❌ 取消任务: ${task.name} (${taskId})`);
    this.emit('task.cancelled', task);
    
    return true;
  }
  
  /**
   * 获取任务队列状态
   */
  getQueueStatus(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    byType: Record<string, number>;
    byNode: Record<string, number>;
    workerMetrics: WorkerMetrics[];
  } {
    const byType: Record<string, number> = {};
    const byNode: Record<string, number> = {};
    
    let pending = 0;
    let running = 0;
    
    for (const task of this.taskQueue.values()) {
      if (task.status === 'pending') pending++;
      if (task.status === 'running') running++;
      
      byType[task.type] = (byType[task.type] || 0) + 1;
    }
    
    for (const task of this.runningTasks.values()) {
      if (task.assignedNode) {
        byNode[task.assignedNode] = (byNode[task.assignedNode] || 0) + 1;
      }
    }
    
    // 计算worker指标
    const workerMetrics = Array.from(this.workerMetrics.values());
    
    return {
      total: this.taskQueue.size,
      pending,
      running,
      completed: 0, // 这些信息需要持久化存储才能准确获取
      failed: 0,
      byType,
      byNode,
      workerMetrics,
    };
  }
  
  /**
   * 获取工作节点列表
   */
  getWorkers(): WorkerMetrics[] {
    return Array.from(this.workerMetrics.values());
  }
  
  /**
   * 平衡节点负载
   */
  async rebalanceWorkload(): Promise<void> {
    const onlineNodes = this.cluster.getNodes().filter(node => node.status === 'online');
    
    if (onlineNodes.length === 0) {
      return;
    }
    
    // 计算平均负载
    const workerMetrics = Array.from(this.workerMetrics.values());
    const totalLoad = workerMetrics.reduce((sum, metrics) => sum + metrics.loadScore, 0);
    const avgLoad = totalLoad / workerMetrics.length;
    
    // 识别过载和空闲节点
    const overloadedNodes: string[] = [];
    const underloadedNodes: string[] = [];
    
    for (const metrics of workerMetrics) {
      if (metrics.loadScore > avgLoad * 1.3) { // 超过平均30%
        overloadedNodes.push(metrics.nodeId);
      } else if (metrics.loadScore < avgLoad * 0.7) { // 低于平均30%
        underloadedNodes.push(metrics.nodeId);
      }
    }
    
    // 迁移任务（简化实现，实际需要复杂的迁移逻辑）
    console.log(`⚖️  重新平衡负载: ${overloadedNodes.length} 过载节点, ${underloadedNodes.length} 空闲节点`);
    
    this.emit('workload.rebalanced', { overloadedNodes, underloadedNodes });
  }
  
  /**
   * 清理过期任务
   */
  cleanupExpiredTasks(): void {
    const now = new Date();
    let expiredCount = 0;
    
    for (const [taskId, task] of this.taskQueue.entries()) {
      if (task.expiresAt && task.expiresAt < now && task.status === 'pending') {
        task.status = 'cancelled';
        task.error = 'Task expired';
        
        // 从待处理队列中移除
        const index = this.pendingTasks.indexOf(taskId);
        if (index !== -1) {
          this.pendingTasks.splice(index, 1);
        }
        
        expiredCount++;
        
        console.log(`🗑️  清理过期任务: ${task.name} (${taskId})`);
        this.emit('task.expired', task);
      }
    }
    
    // 清理运行中超时的任务
    for (const [taskId, task] of this.runningTasks.entries()) {
      const startTime = task.createdAt.getTime();
      if (now.getTime() - startTime > this.config.taskTimeout) {
        task.status = 'failed';
        task.error = 'Task timeout';
        this.runningTasks.delete(taskId);
        
        expiredCount++;
        
        console.log(`⏰ 任务超时: ${task.name} (${taskId})`);
        this.emit('task.timeout', task);
      }
    }
    
    if (expiredCount > 0) {
      console.log(`🧹 已清理 ${expiredCount} 个过期/超时任务`);
    }
  }
  
  private addToPendingQueue(taskId: string, priority: number): void {
    // 按优先级排序插入
    let insertIndex = 0;
    for (let i = 0; i < this.pendingTasks.length; i++) {
      const existingTaskId = this.pendingTasks[i];
      const existingTask = this.taskQueue.get(existingTaskId);
      if (existingTask && existingTask.priority > priority) {
        insertIndex = i;
        break;
      }
      insertIndex++;
    }
    
    this.pendingTasks.splice(insertIndex, 0, taskId);
  }
  
  private startProcessingLoop(): void {
    // 定期调度任务
    const interval = setInterval(() => {
      this.scheduleTasks();
      this.processTaskResults();
      this.cleanupExpiredTasks();
    }, 100); // 100ms调度间隔
    
    this.processingIntervals.set('scheduler', interval);
  }
  
  private startMetricsCollection(): void {
    // 定期收集工作节点指标
    const interval = setInterval(() => {
      this.collectWorkerMetrics();
    }, 5000); // 5秒一次
    
    this.processingIntervals.set('metrics', interval);
  }
  
  private scheduleTasks(): void {
    // 如果没有待处理任务，直接返回
    if (this.pendingTasks.length === 0) return;
    
    // 获取所有在线节点
    const onlineNodes = this.cluster.getNodes().filter(node => node.status === 'online');
    
    if (onlineNodes.length === 0) {
      console.warn('⚠️ 没有在线节点可用');
      return;
    }
    
    // 根据负载均衡策略选择节点
    const selectedNodes = this.selectNodesForTasks(onlineNodes);
    if (selectedNodes.length === 0) return;
    
    // 分配任务到节点
    let scheduledCount = 0;
    let nodeIndex = 0;
    
    // 从待处理队列中取出任务
    while (this.pendingTasks.length > 0 && scheduledCount < selectedNodes.length * 5) { // 每轮最多分配一些任务
      const taskId = this.pendingTasks.shift()!;
      const task = this.taskQueue.get(taskId);
      
      if (!task || task.status !== 'pending') continue;
      
      // 选择节点
      const targetNode = selectedNodes[nodeIndex % selectedNodes.length];
      
      // 分配任务
      task.assignedNode = targetNode.id;
      task.status = 'running';
      this.runningTasks.set(taskId, task);
      this.taskQueue.delete(taskId);
      
      // 发送任务到节点
      this.dispatchTaskToNode(task, targetNode);
      
      console.log(`🚀 调度任务: ${task.name} -> ${targetNode.name}`);
      this.emit('task.dispatched', { task, node: targetNode });
      
      scheduledCount++;
      nodeIndex++;
    }
    
    if (scheduledCount > 0) {
      console.log(`📊 已调度 ${scheduledCount} 个任务`);
    }
  }
  
  private selectNodesForTasks(onlineNodes: ClusterNode[]): ClusterNode[] {
    switch (this.config.loadBalancing) {
      case 'round-robin':
        return [...onlineNodes];
        
      case 'least-load':
        return this.selectByLeastLoad(onlineNodes);
        
      case 'affinity':
        return this.selectByAffinity(onlineNodes);
        
      default:
        return onlineNodes;
    }
  }
  
  private selectByLeastLoad(onlineNodes: ClusterNode[]): ClusterNode[] {
    // 根据节点负载选择，负载低的优先
    return [...onlineNodes].sort((a, b) => {
      const metricsA = this.workerMetrics.get(a.id);
      const metricsB = this.workerMetrics.get(b.id);
      
      const loadA = metricsA?.loadScore || 0;
      const loadB = metricsB?.loadScore || 0;
      
      return loadA - loadB;
    });
  }
  
  private selectByAffinity(onlineNodes: ClusterNode[]): ClusterNode[] {
    // 根据亲和性标签选择（简化实现）
    // 实际实现需要考虑任务的affinity标签和节点的标签匹配
    
    // 先按负载选择
    const sortedByLoad = this.selectByLeastLoad(onlineNodes);
    
    // 如果有节点的标签匹配任务，优先选择
    // 这里简化处理，返回按负载排序的结果
    return sortedByLoad;
  }
  
  private async dispatchTaskToNode(task: TaskDefinition, node: ClusterNode): Promise<void> {
    // 这里应该使用实际的RPC或消息队列发送任务
    // 为了演示，我们模拟任务处理
    
    setTimeout(() => {
      this.processTaskOnNode(task, node);
    }, 10 + Math.random() * 100); // 模拟网络延迟
  }
  
  private async processTaskOnNode(task: TaskDefinition, node: ClusterNode): Promise<void> {
    try {
      console.log(`⚙️  节点 ${node.name} 开始处理任务: ${task.name}`);
      
      // 查找任务处理器
      const processor = this.taskProcessors.get(task.type);
      
      if (!processor) {
        throw new Error(`No processor found for task type: ${task.type}`);
      }
      
      // 执行任务
      const startTime = Date.now();
      const result = await processor(task);
      const duration = Date.now() - startTime;
      
      // 更新任务状态
      task.status = 'completed';
      task.result = result;
      
      // 记录处理时间
      const metrics = this.workerMetrics.get(node.id);
      if (metrics) {
        const totalTime = metrics.avgProcessingTime * metrics.completedTasks + duration;
        metrics.completedTasks++;
        metrics.activeTasks--;
        metrics.avgProcessingTime = totalTime / metrics.completedTasks;
        metrics.lastHeartbeat = new Date();
        
        // 更新负载评分
        const concurrencyLimit = this.config.concurrencyPerNode;
        const loadFactor = metrics.activeTasks / concurrencyLimit;
        metrics.loadScore = Math.min(100, Math.round(loadFactor * 100));
        
        this.workerMetrics.set(node.id, metrics);
      }
      
      console.log(`✅ 任务完成: ${task.name} (${duration}ms)`);
      
      // 触发完成事件
      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'completed',
        result,
        processingNode: node.id,
        startTime: new Date(startTime),
        endTime: new Date(),
        duration,
      };
      
      this.emit('task.completed', taskResult);
      
    } catch (error) {
      // 任务失败处理
      await this.handleTaskFailure(task, node, error);
    } finally {
      // 清理运行中任务
      this.runningTasks.delete(task.id);
      
      // 继续调度新任务
      setTimeout(() => {
        this.scheduleTasks();
      }, 0);
    }
  }
  
  private async handleTaskFailure(
    task: TaskDefinition,
    node: ClusterNode,
    error: any
  ): Promise<void> {
    console.error(`❌ 任务失败: ${task.name}`, error);
    
    task.retryCount++;
    task.error = error instanceof Error ? error.message : String(error);
    
    // 检查是否超过最大重试次数
    if (task.retryCount >= task.maxRetries) {
      task.status = 'failed';
      
      // 触发失败事件
      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'failed',
        error: task.error,
        processingNode: node.id,
        startTime: task.createdAt,
        endTime: new Date(),
        duration: Date.now() - task.createdAt.getTime(),
      };
      
      this.emit('task.failed', taskResult);
      
    } else {
      // 重试任务
      task.status = 'pending';
      task.assignedNode = undefined;
      
      // 重新加入待处理队列（带延迟）
      setTimeout(() => {
        this.taskQueue.set(task.id, task);
        this.addToPendingQueue(task.id, task.priority);
        
        console.log(`🔄 重试任务: ${task.name} (${task.retryCount}/${task.maxRetries})`);
        this.emit('task.retrying', task);
        
        // 触发重新调度
        this.scheduleTasks();
      }, this.config.retryDelay * task.retryCount); // 指数退避
    }
    
    // 更新节点指标
    const metrics = this.workerMetrics.get(node.id);
    if (metrics) {
      metrics.failedTasks++;
      metrics.activeTasks--;
      metrics.lastHeartbeat = new Date();
      this.workerMetrics.set(node.id, metrics);
    }
  }
  
  private processTaskResults(): void {
    // 这里可以处理从节点返回的任务结果
    // 为了演示，我们在processTaskOnNode中直接处理
  }
  
  private collectWorkerMetrics(): void {
    const onlineNodes = this.cluster.getNodes().filter(node => node.status === 'online');
    
    for (const node of onlineNodes) {
      const existingMetrics = this.workerMetrics.get(node.id);
      
      if (!existingMetrics) {
        // 创建新的指标记录
        this.workerMetrics.set(node.id, {
          nodeId: node.id,
          activeTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          avgProcessingTime: 0,
          lastHeartbeat: new Date(),
          loadScore: 0,
          tags: node.metadata?.tags || [],
        });
      } else {
        // 更新心跳时间
        existingMetrics.lastHeartbeat = new Date();
        this.workerMetrics.set(node.id, existingMetrics);
      }
    }
    
    // 清理离线节点的指标
    for (const [nodeId] of this.workerMetrics.entries()) {
      const node = this.cluster.getNodes().find(n => n.id === nodeId);
      if (!node || node.status !== 'online') {
        this.workerMetrics.delete(nodeId);
      }
    }
  }
  
  private handleNodeJoin(node: ClusterNode): void {
    console.log(`👥 新工作节点加入: ${node.name}`);
    
    // 创建节点指标
    this.workerMetrics.set(node.id, {
      nodeId: node.id,
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      avgProcessingTime: 0,
      lastHeartbeat: new Date(),
      loadScore: 0,
      tags: node.metadata?.tags || [],
    });
    
    // 触发重新调度
    setTimeout(() => {
      this.scheduleTasks();
    }, 100);
  }
  
  private handleNodeLeave(node: ClusterNode): void {
    console.log(`👥 工作节点离开: ${node.name}`);
    
    // 清理节点指标
    this.workerMetrics.delete(node.id);
    
    // 重新分配该节点的运行中任务
    const tasksToReassign: TaskDefinition[] = [];
    
    for (const task of this.runningTasks.values()) {
      if (task.assignedNode === node.id) {
        tasksToReassign.push(task);
      }
    }
    
    if (tasksToReassign.length > 0) {
      console.log(`🔄 重新分配 ${tasksToReassign.length} 个任务`);
      
      for (const task of tasksToReassign) {
        task.status = 'pending';
        task.assignedNode = undefined;
        task.retryCount++;
        
        // 重新加入待处理队列
        this.taskQueue.set(task.id, task);
        this.addToPendingQueue(task.id, task.priority);
        
        // 从运行中任务中移除
        this.runningTasks.delete(task.id);
      }
      
      // 触发重新调度
      setTimeout(() => {
        this.scheduleTasks();
      }, 100);
    }
  }
  
  private async notifyNodeToCancel(nodeId: string, taskId: string): Promise<void> {
    console.log(`🛑 通知节点 ${nodeId} 取消任务 ${taskId}`);
    
    // 这里应该发送取消消息到节点
    // 为了演示，我们只记录日志
  }
  
  /**
   * 停止调度器
   */
  async stop(): Promise<void> {
    // 清理所有定时器
    for (const interval of this.processingIntervals.values()) {
      clearInterval(interval);
    }
    
    this.processingIntervals.clear();
    
    console.log('🛑 分布式任务调度器已停止');
  }
}