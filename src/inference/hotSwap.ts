/**
 * 热模型切换模块
 * 借鉴 Shimmy 的热加载能力，实现运行时无缝切换模型
 */

import { EventEmitter } from "node:events";
import type { DiscoveredModel } from "./modelDiscovery.js";

export interface LoadedModel {
  id: string;
  path: string;
  format: string;
  loadedAt: Date;
  memoryUsage: number; // MB
  lastUsed: Date;
  useCount: number;
  isActive: boolean;
}

export interface HotSwapOptions {
  maxLoadedModels?: number; // 最大同时加载的模型数
  autoUnloadInterval?: number; // 自动卸载间隔 (ms)
  preloadNext?: boolean; // 是否预加载下一个可能使用的模型
  keepWarmDuration?: number; // 保持热加载状态的时间 (ms)
}

export interface SwapContext {
  preserveKVCache?: boolean; // 是否保留 KV 缓存 (实验性)
  copySystemPrompt?: boolean; // 复制系统提示词
  temperature?: number; // 复制温度设置
  maxTokens?: number; // 复制最大 token 数
}

export class HotModelSwap extends EventEmitter {
  private loadedModels: Map<string, LoadedModel> = new Map();
  private activeModelId: string | null = null;
  private options: Required<HotSwapOptions>;
  private unloadTimer: NodeJS.Timeout | null = null;
  private modelQueue: string[] = []; // LRU 队列

  constructor(options: HotSwapOptions = {}) {
    super();
    this.options = {
      maxLoadedModels: options.maxLoadedModels ?? 3,
      autoUnloadInterval: options.autoUnloadInterval ?? 300000, // 5分钟
      preloadNext: options.preloadNext ?? true,
      keepWarmDuration: options.keepWarmDuration ?? 600000, // 10分钟
    };

    this.startAutoUnload();
  }

  /**
   * 加载模型
   */
  async loadModel(
    model: DiscoveredModel,
    makeActive = false
  ): Promise<LoadedModel> {
    const existing = this.loadedModels.get(model.id);

    if (existing) {
      // 已加载，更新使用统计
      existing.lastUsed = new Date();
      existing.useCount++;
      this.updateLRU(model.id);

      if (makeActive) {
        await this.activateModel(model.id);
      }

      this.emit("modelLoaded", { model: existing, cached: true });
      return existing;
    }

    // 检查是否需要卸载旧模型
    if (this.loadedModels.size >= this.options.maxLoadedModels) {
      await this.unloadLRUModel();
    }

    // 执行实际加载
    const loadedModel: LoadedModel = {
      id: model.id,
      path: model.path,
      format: model.format,
      loadedAt: new Date(),
      memoryUsage: model.size / (1024 * 1024), // bytes -> MB
      lastUsed: new Date(),
      useCount: 0,
      isActive: false,
    };

    // 这里会调用实际的模型加载逻辑
    await this.performLoad(model);

    this.loadedModels.set(model.id, loadedModel);
    this.updateLRU(model.id);

    if (makeActive) {
      await this.activateModel(model.id);
    }

    this.emit("modelLoaded", { model: loadedModel, cached: false });
    return loadedModel;
  }

  /**
   * 激活模型
   */
  async activateModel(modelId: string): Promise<boolean> {
    const model = this.loadedModels.get(modelId);
    if (!model) {
      this.emit("error", new Error(`Model ${modelId} not loaded`));
      return false;
    }

    // 停用当前活动模型
    if (this.activeModelId && this.activeModelId !== modelId) {
      const oldModel = this.loadedModels.get(this.activeModelId);
      if (oldModel) {
        oldModel.isActive = false;
        this.emit("modelDeactivated", oldModel);
      }
    }

    // 激活新模型
    model.isActive = true;
    model.lastUsed = new Date();
    this.activeModelId = modelId;

    this.emit("modelActivated", model);
    return true;
  }

  /**
   * 热切换模型
   * 核心功能：在不重启服务的情况下切换模型
   */
  async hotSwap(
    toModel: DiscoveredModel,
    context: SwapContext = {}
  ): Promise<{
    success: boolean;
    fromModel?: LoadedModel;
    toModel: LoadedModel;
    swapTime: number; // ms
    preserved?: Partial<SwapContext>;
  }> {
    const startTime = Date.now();
    const fromModel = this.activeModelId
      ? this.loadedModels.get(this.activeModelId)
      : undefined;

    try {
      // 1. 加载目标模型 (如果还没加载)
      const targetModel = await this.loadModel(toModel, false);

      // 2. 执行切换
      const activated = await this.activateModel(toModel.id);
      if (!activated) {
        throw new Error("Failed to activate target model");
      }

      // 3. 预加载可能下一个使用的模型
      if (this.options.preloadNext && fromModel) {
        this.preloadRelatedModels(toModel);
      }

      const swapTime = Date.now() - startTime;

      this.emit("hotSwapComplete", {
        from: fromModel?.id,
        to: toModel.id,
        duration: swapTime,
      });

      return {
        success: true,
        fromModel,
        toModel: targetModel,
        swapTime,
        preserved: context.copySystemPrompt
          ? { temperature: context.temperature, maxTokens: context.maxTokens }
          : undefined,
      };
    } catch (error) {
      this.emit("hotSwapError", { error, from: fromModel?.id, to: toModel.id });

      // 回滚到原模型
      if (fromModel && this.activeModelId !== fromModel.id) {
        await this.activateModel(fromModel.id);
      }

      return {
        success: false,
        toModel: await this.loadModel(toModel, false),
        swapTime: Date.now() - startTime,
      };
    }
  }

  /**
   * 卸载模型
   */
  async unloadModel(modelId: string): Promise<boolean> {
    const model = this.loadedModels.get(modelId);
    if (!model) return false;

    // 如果是活动模型，先停用
    if (model.isActive) {
      model.isActive = false;
      if (this.activeModelId === modelId) {
        this.activeModelId = null;
      }
    }

    // 执行实际卸载
    await this.performUnload(modelId);

    this.loadedModels.delete(modelId);
    this.removeFromLRU(modelId);

    this.emit("modelUnloaded", model);
    return true;
  }

  /**
   * 获取当前活动模型
   */
  getActiveModel(): LoadedModel | null {
    return this.activeModelId
      ? this.loadedModels.get(this.activeModelId) || null
      : null;
  }

  /**
   * 获取所有已加载模型
   */
  getLoadedModels(): LoadedModel[] {
    return Array.from(this.loadedModels.values());
  }

  /**
   * 获取内存使用统计
   */
  getMemoryStats(): {
    totalLoaded: number;
    activeModelMemory: number;
    cachedModelsMemory: number;
    availableSlots: number;
  } {
    const totalLoaded = this.loadedModels.size;
    const activeModel = this.getActiveModel();
    const activeModelMemory = activeModel?.memoryUsage || 0;

    const cachedModelsMemory = Array.from(this.loadedModels.values())
      .filter((m) => !m.isActive)
      .reduce((sum, m) => sum + m.memoryUsage, 0);

    return {
      totalLoaded,
      activeModelMemory,
      cachedModelsMemory,
      availableSlots: this.options.maxLoadedModels - totalLoaded,
    };
  }

  /**
   * 执行实际的模型加载
   * 子类可以覆盖此方法实现具体的加载逻辑
   */
  protected async performLoad(model: DiscoveredModel): Promise<void> {
    // 模拟加载延迟
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 实际实现中会调用 llama.cpp 或 ollama 的加载接口
    this.emit("loading", { modelId: model.id, path: model.path });
  }

  /**
   * 执行实际的模型卸载
   */
  protected async performUnload(modelId: string): Promise<void> {
    // 实际实现中会调用释放资源的接口
    this.emit("unloading", { modelId });
  }

  /**
   * 更新 LRU 队列
   */
  private updateLRU(modelId: string): void {
    this.removeFromLRU(modelId);
    this.modelQueue.push(modelId);
  }

  /**
   * 从 LRU 队列移除
   */
  private removeFromLRU(modelId: string): void {
    const index = this.modelQueue.indexOf(modelId);
    if (index !== -1) {
      this.modelQueue.splice(index, 1);
    }
  }

  /**
   * 卸载最久未使用的模型
   */
  private async unloadLRUModel(): Promise<void> {
    if (this.modelQueue.length === 0) return;

    const lruModelId = this.modelQueue[0];
    const model = this.loadedModels.get(lruModelId);

    // 不要卸载活动模型
    if (model && !model.isActive) {
      await this.unloadModel(lruModelId);
    }
  }

  /**
   * 启动自动卸载
   */
  private startAutoUnload(): void {
    if (this.unloadTimer) return;

    this.unloadTimer = setInterval(() => {
      this.performAutoUnload();
    }, this.options.autoUnloadInterval);
  }

  /**
   * 执行自动卸载
   */
  private async performAutoUnload(): Promise<void> {
    const now = Date.now();
    const expiredModels: string[] = [];

    for (const [id, model] of this.loadedModels) {
      // 跳过活动模型
      if (model.isActive) continue;

      // 检查是否超过保持时间
      const idleTime = now - model.lastUsed.getTime();
      if (idleTime > this.options.keepWarmDuration) {
        expiredModels.push(id);
      }
    }

    // 卸载过期模型
    for (const id of expiredModels) {
      await this.unloadModel(id);
    }

    if (expiredModels.length > 0) {
      this.emit("autoUnloaded", expiredModels);
    }
  }

  /**
   * 预加载相关模型
   */
  private preloadRelatedModels(currentModel: DiscoveredModel): void {
    // 这里可以实现基于使用模式的预加载策略
    // 例如：如果当前加载了 llama3-8b，预加载 llama3-70b
    this.emit("preloadRequested", { currentModel });
  }

  /**
   * 停止自动卸载
   */
  stopAutoUnload(): void {
    if (this.unloadTimer) {
      clearInterval(this.unloadTimer);
      this.unloadTimer = null;
    }
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    this.stopAutoUnload();
    this.loadedModels.clear();
    this.modelQueue = [];
    this.activeModelId = null;
    this.removeAllListeners();
  }
}

// 便捷导出
export const globalHotSwap = new HotModelSwap();
