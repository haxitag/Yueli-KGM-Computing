/**
 * Rust Core Integration - 集成 Shimmy/Fox 高性能推理
 * 混合架构: Node.js 网关 + Rust 推理核心
 */

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { globalModelDiscovery } from "../inference/modelDiscovery.js";
import { QuantizationManager } from "../inference/quantization.js";

interface RustCoreConfig {
  binaryPath?: string;
  modelPath: string;
  quantization?: string;
  gpuLayers?: number;
  cpuMOE?: boolean;
  contextLength?: number;
  port?: number;
  timeout?: number;
}

interface RustCoreStats {
  status: "idle" | "loading" | "ready" | "error";
  loadedModel?: string;
  uptime: number;
  tokensGenerated: number;
  avgLatency: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}

interface InferenceRequest {
  id: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  topP?: number;
  stopSequences?: string[];
  stream?: boolean;
}

interface InferenceResponse {
  id: string;
  text: string;
  tokensGenerated: number;
  finishReason: "stop" | "length" | "error";
  timing: {
    prefillMs: number;
    generationMs: number;
    totalMs: number;
  };
}

/**
 * Rust Core Manager
 * 管理 Shimmy/Fox 进程的启动、通信和监控
 */
export class RustCoreManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private config: Required<RustCoreConfig>;
  private stats: RustCoreStats;
  private requestQueue: Map<string, { resolve: Function; reject: Function }> =
    new Map();
  private isReady = false;
  private startTime = 0;
  private messageBuffer = "";

  constructor(config: RustCoreConfig) {
    super();
    this.config = {
      binaryPath: config.binaryPath ?? this.findRustBinary(),
      modelPath: config.modelPath,
      quantization: config.quantization ?? "Q4_K",
      gpuLayers: config.gpuLayers ?? -1, // -1 = auto
      cpuMOE: config.cpuMOE ?? true,
      contextLength: config.contextLength ?? 4096,
      port: config.port ?? 0, // 0 = auto
      timeout: config.timeout ?? 30000,
    };

    this.stats = {
      status: "idle",
      uptime: 0,
      tokensGenerated: 0,
      avgLatency: 0,
      memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 },
    };
  }

  /**
   * 查找 Rust 二进制文件
   */
  private findRustBinary(): string {
    const candidates = [
      "shimmy",
      "fox",
      "llama-rs",
      join(process.cwd(), "bin", "shimmy"),
      join(process.cwd(), "bin", "fox"),
      "/usr/local/bin/shimmy",
      "/usr/local/bin/fox",
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      "Rust binary not found. Please install shimmy or fox: cargo install shimmy"
    );
  }

  /**
   * 启动 Rust Core 进程
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Rust core already running");
    }

    const args = this.buildArgs();

    this.emit("starting", { binary: this.config.binaryPath, args });

    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.binaryPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          RUST_LOG: "info",
          RUST_BACKTRACE: "1",
        },
      });

      this.startTime = Date.now();

      // 处理 stdout
      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleStdout(data);
      });

      // 处理 stderr
      this.process.stderr?.on("data", (data: Buffer) => {
        const message = data.toString();
        this.emit("stderr", message);

        // 检测就绪状态
        if (message.includes("Server started") || message.includes("Listening")) {
          this.isReady = true;
          this.stats.status = "ready";
          this.emit("ready");
          resolve();
        }
      });

      // 处理进程退出
      this.process.on("exit", (code) => {
        this.isReady = false;
        this.stats.status = code === 0 ? "idle" : "error";
        this.emit("exit", { code });
        this.process = null;
      });

      this.process.on("error", (error) => {
        this.stats.status = "error";
        this.emit("error", error);
        reject(error);
      });

      // 超时处理
      setTimeout(() => {
        if (!this.isReady) {
          reject(new Error("Rust core startup timeout"));
        }
      }, this.config.timeout);
    });
  }

  /**
   * 构建启动参数
   */
  private buildArgs(): string[] {
    const args: string[] = [];

    // 模型路径
    args.push("--model", this.config.modelPath);

    // 量化
    if (this.config.quantization) {
      args.push("--quantization", this.config.quantization);
    }

    // GPU 层数
    if (this.config.gpuLayers >= 0) {
      args.push("--n-gpu-layers", this.config.gpuLayers.toString());
    }

    // MOE CPU 卸载
    if (this.config.cpuMOE) {
      args.push("--cpu-moe");
    }

    // 上下文长度
    args.push("--ctx-size", this.config.contextLength.toString());

    // 端口
    if (this.config.port > 0) {
      args.push("--port", this.config.port.toString());
    }

    // 自动发现模型
    args.push("--auto-discovery");

    return args;
  }

  /**
   * 处理 stdout 输出
   */
  private handleStdout(data: Buffer): void {
    this.messageBuffer += data.toString();

    // 处理换行分隔的 JSON 消息
    let lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() || ""; // 保留不完整的最后一行

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch {
          this.emit("stdout", line);
        }
      }
    }
  }

  /**
   * 处理 JSON 消息
   */
  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;

    const msg = message as Record<string, unknown>;

    // 处理推理响应
    if (msg.type === "inference" && msg.id) {
      const requestId = msg.id as string;
      const handler = this.requestQueue.get(requestId);

      if (handler) {
        if (msg.error) {
          handler.reject(new Error(msg.error as string));
        } else {
          handler.resolve(msg as unknown as InferenceResponse);
        }
        this.requestQueue.delete(requestId);
      }
    }

    // 处理统计更新
    if (msg.type === "stats") {
      this.stats = { ...this.stats, ...(msg.stats as RustCoreStats) };
      this.emit("statsUpdate", this.stats);
    }

    // 处理 token 生成事件
    if (msg.type === "token" && msg.id) {
      this.emit("token", {
        requestId: msg.id,
        token: msg.token,
        isLast: msg.isLast,
      });
    }

    this.emit("message", message);
  }

  /**
   * 执行推理
   */
  async inference(request: Omit<InferenceRequest, "id">): Promise<InferenceResponse> {
    if (!this.isReady) {
      throw new Error("Rust core not ready");
    }

    const id = `inf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const fullRequest: InferenceRequest = {
      ...request,
      id,
    };

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        this.requestQueue.delete(id);
        reject(new Error("Inference timeout"));
      }, this.config.timeout);

      // 存储 handler
      this.requestQueue.set(id, {
        resolve: (result: unknown) => {
          clearTimeout(timeout);
          resolve(result as InferenceResponse);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      // 发送请求
      this.process?.stdin?.write(JSON.stringify(fullRequest) + "\n");
    });
  }

  /**
   * 流式推理
   */
  async *streamInference(
    request: Omit<InferenceRequest, "id" | "stream">
  ): AsyncIterable<{ token: string; isLast: boolean }> {
    if (!this.isReady) {
      throw new Error("Rust core not ready");
    }

    const id = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const tokens: { token: string; isLast: boolean }[] = [];
    let done = false;

    // 监听 token 事件
    const tokenHandler = (data: { requestId: string; token: string; isLast: boolean }) => {
      if (data.requestId === id) {
        tokens.push({ token: data.token, isLast: data.isLast });
        if (data.isLast) {
          done = true;
        }
      }
    };

    this.on("token", tokenHandler);

    // 发送请求
    const fullRequest: InferenceRequest = {
      ...request,
      id,
      stream: true,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    };

    this.process?.stdin?.write(JSON.stringify(fullRequest) + "\n");

    // 生成 token
    while (!done) {
      while (tokens.length > 0) {
        yield tokens.shift()!;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 清理
    this.off("token", tokenHandler);
  }

  /**
   * 获取统计
   */
  getStats(): RustCoreStats {
    return {
      ...this.stats,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * 动态切换模型
   */
  async switchModel(modelPath: string): Promise<void> {
    if (!this.process) {
      throw new Error("Rust core not running");
    }

    // 发送切换模型命令
    const command = {
      type: "switch_model",
      modelPath,
    };

    this.process.stdin?.write(JSON.stringify(command) + "\n");
    this.config.modelPath = modelPath;

    this.emit("modelSwitching", { to: modelPath });

    // 等待就绪
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Model switch timeout"));
      }, 60000);

      const handler = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.once("ready", handler);
    });
  }

  /**
   * 停止 Rust Core
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    // 发送优雅关闭命令
    this.process.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");

    // 等待进程退出
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGTERM");
        resolve();
      }, 5000);

      this.process?.once("exit", () => {
        clearTimeout(timeout);
        this.process = null;
        this.isReady = false;
        this.stats.status = "idle";
        resolve();
      });
    });
  }

  /**
   * 获取推荐配置
   */
  static getRecommendedConfig(
    availableGPUMB: number,
    availableCPUMB: number,
    modelSizeMB: number
  ): RustCoreConfig {
    // 使用 QuantizationManager 的配置
    const quantConfig = QuantizationManager.getRecommendedConfig(
      availableGPUMB,
      availableCPUMB,
      modelSizeMB,
      4096
    );

    const gpuLayers =
      quantConfig.memory.gpuLayers === "auto"
        ? -1
        : (quantConfig.memory.gpuLayers as number);

    return {
      modelPath: "", // 需要外部设置
      quantization: quantConfig.quantization.type,
      gpuLayers,
      cpuMOE: quantConfig.moe.enabled,
      contextLength: quantConfig.quantization.contextLength,
    };
  }
}

/**
 * Rust Core 集群管理器
 * 管理多个 Rust Core 进程，实现负载均衡
 */
export class RustCoreCluster extends EventEmitter {
  private cores: Map<string, RustCoreManager> = new Map();
  private currentIndex = 0;
  private stats = {
    totalRequests: 0,
    avgLatency: 0,
    errors: 0,
  };

  /**
   * 添加 Rust Core 实例
   */
  async addCore(id: string, config: RustCoreConfig): Promise<RustCoreManager> {
    const core = new RustCoreManager(config);
    await core.start();
    this.cores.set(id, core);
    this.emit("coreAdded", { id });
    return core;
  }

  /**
   * 轮询负载均衡
   */
  async inference(
    request: Omit<InferenceRequest, "id">
  ): Promise<InferenceResponse> {
    const cores = Array.from(this.cores.values());
    if (cores.length === 0) {
      throw new Error("No rust cores available");
    }

    // 轮询选择
    const core = cores[this.currentIndex % cores.length];
    this.currentIndex++;

    try {
      const result = await core.inference(request);
      this.updateStats(result.timing.totalMs);
      return result;
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  private updateStats(latency: number): void {
    this.stats.totalRequests++;
    const n = this.stats.totalRequests;
    this.stats.avgLatency =
      (this.stats.avgLatency * (n - 1) + latency) / n;
  }

  /**
   * 获取所有核心统计
   */
  getAllStats(): Array<{ id: string; stats: RustCoreStats }> {
    return Array.from(this.cores.entries()).map(([id, core]) => ({
      id,
      stats: core.getStats(),
    }));
  }

  /**
   * 停止所有核心
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.cores.values()).map((core) =>
      core.stop().catch(() => {})
    );
    await Promise.all(stops);
    this.cores.clear();
  }
}

// 便捷导出
export const globalRustCore = new RustCoreManager({
  modelPath: "",
});
