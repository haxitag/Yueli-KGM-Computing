/**
 * Worker Thread Pool - 处理非推理任务
 * 减少主线程阻塞，提升并发性能
 */

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { EventEmitter } from "node:events";

interface Task<T = unknown> {
  id: string;
  type: string;
  payload: T;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  priority: number;
  enqueueTime: number;
}

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  taskCount: number;
  lastUsed: number;
}

export interface WorkerPoolOptions {
  minWorkers?: number;
  maxWorkers?: number;
  taskTimeout?: number;
  idleTimeout?: number;
  queueSize?: number;
}

export class WorkerPool extends EventEmitter {
  private workers: Map<number, WorkerInfo> = new Map();
  private taskQueue: Task[] = [];
  private taskMap: Map<string, Task> = new Map();
  private workerIdCounter = 0;
  private options: Required<WorkerPoolOptions>;
  private idleCheckTimer?: NodeJS.Timeout;
  private stats = {
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    queueWaits: 0,
    avgWaitTime: 0,
  };

  constructor(options: WorkerPoolOptions = {}) {
    super();
    this.options = {
      minWorkers: options.minWorkers ?? Math.max(2, cpus().length),
      maxWorkers: options.maxWorkers ?? Math.max(4, cpus().length * 2),
      taskTimeout: options.taskTimeout ?? 30000,
      idleTimeout: options.idleTimeout ?? 60000,
      queueSize: options.queueSize ?? 1000,
    };

    this.initializeWorkers();
    this.startIdleCheck();
  }

  private initializeWorkers(): void {
    for (let i = 0; i < this.options.minWorkers; i++) {
      this.createWorker();
    }
  }

  private createWorker(): number {
    const workerId = ++this.workerIdCounter;
    
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      
      parentPort.on('message', async (task) => {
        try {
          let result;
          switch (task.type) {
            case 'tokenize':
              result = await tokenize(task.payload);
              break;
            case 'renderTemplate':
              result = await renderTemplate(task.payload);
              break;
            case 'serialize':
              result = JSON.stringify(task.payload);
              break;
            case 'deserialize':
              result = JSON.parse(task.payload);
              break;
            case 'countTokens':
              result = countTokens(task.payload);
              break;
            case 'normalize':
              result = normalizeResponse(task.payload);
              break;
            default:
              throw new Error('Unknown task type: ' + task.type);
          }
          parentPort.postMessage({ id: task.id, result, error: null });
        } catch (error) {
          parentPort.postMessage({ 
            id: task.id, 
            result: null, 
            error: error.message 
          });
        }
      });
      
      async function tokenize({ text, model }) {
        // 简化的 token 计数 (实际实现会更复杂)
        return Math.ceil(text.length / 4);
      }
      
      async function renderTemplate({ template, variables }) {
        // 简化的模板渲染
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
          return variables[key] ?? match;
        });
      }
      
      function countTokens({ messages, model }) {
        // 估算 token 数
        let total = 0;
        for (const msg of messages) {
          total += Math.ceil((msg.content?.length || 0) / 4);
          total += 4; // 角色标记
        }
        return total;
      }
      
      function normalizeResponse({ response, format }) {
        // 响应格式规范化
        if (format === 'openai') {
          return {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: response.model,
            choices: response.choices || [],
            usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          };
        }
        return response;
      }
    `, { eval: true });

    const workerInfo: WorkerInfo = {
      worker,
      busy: false,
      taskCount: 0,
      lastUsed: Date.now(),
    };

    worker.on('message', (result) => {
      this.handleWorkerResult(workerId, result);
    });

    worker.on('error', (error) => {
      this.emit('workerError', { workerId, error });
      this.recycleWorker(workerId);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.recycleWorker(workerId);
      }
    });

    this.workers.set(workerId, workerInfo);
    this.emit('workerCreated', { workerId });
    
    return workerId;
  }

  private recycleWorker(workerId: number): void {
    const workerInfo = this.workers.get(workerId);
    if (workerInfo) {
      workerInfo.worker.terminate().catch(() => {});
      this.workers.delete(workerId);
      
      // 如果低于最小 worker 数，创建新的
      if (this.workers.size < this.options.minWorkers) {
        this.createWorker();
      }
    }
  }

  private handleWorkerResult(workerId: number, result: { id: string; result: unknown; error: string | null }): void {
    const workerInfo = this.workers.get(workerId);
    if (workerInfo) {
      workerInfo.busy = false;
      workerInfo.taskCount++;
      workerInfo.lastUsed = Date.now();
    }

    const task = this.taskMap.get(result.id);
    if (task) {
      this.taskMap.delete(result.id);
      
      const waitTime = Date.now() - task.enqueueTime;
      this.updateStats(waitTime);

      if (result.error) {
        task.reject(new Error(result.error));
        this.stats.failedTasks++;
      } else {
        task.resolve(result.result);
        this.stats.completedTasks++;
      }

      // 处理队列中的下一个任务
      this.processQueue();
    }
  }

  private updateStats(waitTime: number): void {
    this.stats.queueWaits++;
    // 滑动平均
    this.stats.avgWaitTime = 
      (this.stats.avgWaitTime * (this.stats.queueWaits - 1) + waitTime) / 
      this.stats.queueWaits;
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    // 找到空闲的 worker
    const availableWorker = Array.from(this.workers.entries())
      .find(([_, info]) => !info.busy);

    if (availableWorker) {
      const [workerId, workerInfo] = availableWorker;
      const task = this.taskQueue.shift();
      
      if (task) {
        workerInfo.busy = true;
        workerInfo.lastUsed = Date.now();
        
        const timeout = setTimeout(() => {
          task.reject(new Error('Task timeout'));
          this.taskMap.delete(task.id);
          this.recycleWorker(workerId);
        }, this.options.taskTimeout);

        // 清理 timeout 引用
        const originalResolve = task.resolve;
        const originalReject = task.reject;
        task.resolve = (value) => {
          clearTimeout(timeout);
          originalResolve(value);
        };
        task.reject = (reason) => {
          clearTimeout(timeout);
          originalReject(reason);
        };

        workerInfo.worker.postMessage({
          id: task.id,
          type: task.type,
          payload: task.payload,
        });
      }
    } else if (this.workers.size < this.options.maxWorkers) {
      // 创建新的 worker
      this.createWorker();
      // 重试处理队列
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * 提交任务到 Worker Pool
   */
  async execute<T, R>(type: string, payload: T, priority = 5): Promise<R> {
    if (this.taskQueue.length >= this.options.queueSize) {
      throw new Error('Task queue full');
    }

    this.stats.totalTasks++;
    const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      const task: Task = {
        id,
        type,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
        enqueueTime: Date.now(),
      };

      this.taskMap.set(id, task);
      
      // 按优先级插入队列
      const insertIndex = this.taskQueue.findIndex(t => t.priority < priority);
      if (insertIndex === -1) {
        this.taskQueue.push(task);
      } else {
        this.taskQueue.splice(insertIndex, 0, task);
      }

      this.processQueue();
    });
  }

  /**
   * Tokenize 文本
   */
  async tokenize(text: string, model?: string): Promise<number> {
    return this.execute('tokenize', { text, model });
  }

  /**
   * 渲染模板
   */
  async renderTemplate(template: string, variables: Record<string, string>): Promise<string> {
    return this.execute('renderTemplate', { template, variables });
  }

  /**
   * JSON 序列化
   */
  async serialize(data: unknown): Promise<string> {
    return this.execute('serialize', data);
  }

  /**
   * JSON 反序列化
   */
  async deserialize(json: string): Promise<unknown> {
    return this.execute('deserialize', json);
  }

  /**
   * 计算消息 token 数
   */
  async countTokens(messages: Array<{ content: string }>, model?: string): Promise<number> {
    return this.execute('countTokens', { messages, model });
  }

  /**
   * 规范化响应格式
   */
  async normalizeResponse(response: unknown, format: string): Promise<unknown> {
    return this.execute('normalize', { response, format });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      activeWorkers: this.workers.size,
      busyWorkers: Array.from(this.workers.values()).filter(w => w.busy).length,
      queueLength: this.taskQueue.length,
    };
  }

  /**
   * 动态调整 worker 数量
   */
  resize(minWorkers: number, maxWorkers: number): void {
    this.options.minWorkers = minWorkers;
    this.options.maxWorkers = maxWorkers;

    // 创建更多 worker 如果需要
    while (this.workers.size < minWorkers) {
      this.createWorker();
    }
  }

  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      const now = Date.now();
      const idleThreshold = this.options.idleTimeout;

      for (const [workerId, info] of this.workers) {
        // 如果 worker 空闲太久且超过最小数量，回收它
        if (!info.busy && 
            now - info.lastUsed > idleThreshold && 
            this.workers.size > this.options.minWorkers) {
          this.recycleWorker(workerId);
        }
      }
    }, 30000); // 每 30 秒检查一次
  }

  /**
   * 关闭 Worker Pool
   */
  async shutdown(): Promise<void> {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
    }

    // 等待队列处理完成
    while (this.taskQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 终止所有 worker
    const terminatePromises = Array.from(this.workers.values()).map(info => 
      info.worker.terminate().catch(() => {})
    );
    
    await Promise.all(terminatePromises);
    this.workers.clear();
    this.emit('shutdown');
  }
}

// 全局单例
export const globalWorkerPool = new WorkerPool();
