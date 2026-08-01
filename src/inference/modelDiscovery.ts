/**
 * 模型自动发现模块
 * 借鉴 Shimmy 的零配置思想，自动扫描本地模型
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, extname, basename } from "node:path";

export interface DiscoveredModel {
  id: string;
  path: string;
  format: "gguf" | "safetensors" | "kgm";
  size: number;
  quantization?: string;
  parameters?: string;
  source: "huggingface" | "ollama" | "local" | "kgm";
  discoveredAt: Date;
}

export interface DiscoveryOptions {
  scanHuggingFace?: boolean;
  scanOllama?: boolean;
  scanLocalDirs?: string[];
  maxDepth?: number;
  minSizeMB?: number;
}

export class ModelDiscovery {
  private discoveredModels: Map<string, DiscoveredModel> = new Map();

  /**
   * 执行完整的模型发现流程
   */
  async discoverAll(options: DiscoveryOptions = {}): Promise<DiscoveredModel[]> {
    const {
      scanHuggingFace = true,
      scanOllama = true,
      scanLocalDirs = [],
      maxDepth = 3,
      minSizeMB = 100,
    } = options;

    const results: DiscoveredModel[] = [];

    // 1. 扫描 Hugging Face Cache
    if (scanHuggingFace) {
      const hfModels = await this.scanHuggingFaceCache(maxDepth, minSizeMB);
      results.push(...hfModels);
    }

    // 2. 扫描 Ollama 模型
    if (scanOllama) {
      const ollamaModels = await this.scanOllamaModels();
      results.push(...ollamaModels);
    }

    // 3. 扫描本地目录
    for (const dir of scanLocalDirs) {
      const localModels = await this.scanLocalDirectory(dir, maxDepth, minSizeMB);
      results.push(...localModels);
    }

    // 去重并存储
    for (const model of results) {
      this.discoveredModels.set(model.id, model);
    }

    return Array.from(this.discoveredModels.values());
  }

  /**
   * 扫描 Hugging Face Cache
   */
  private async scanHuggingFaceCache(
    maxDepth: number,
    minSizeMB: number
  ): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    const hfCache = join(homedir(), ".cache", "huggingface", "hub");

    if (!existsSync(hfCache)) {
      return models;
    }

    try {
      // 扫描 models-- 目录
      const entries = readdirSync(hfCache);
      for (const entry of entries) {
        if (entry.startsWith("models--")) {
          const modelPath = join(hfCache, entry);
          const modelId = entry.replace("models--", "").replace("--", "/");

          // 解析量化信息
          const quantMatch = modelId.match(/([Qq]\d+(_\d+)?)/);
          const quantization = quantMatch ? quantMatch[1].toUpperCase() : undefined;

          // 解析参数量
          const paramMatch = modelId.match(/(\d+b)|(\d+\.?\d*b)/i);
          const parameters = paramMatch ? paramMatch[0].toLowerCase() : undefined;

          // 递归查找模型文件
          const modelFiles = this.findModelFiles(modelPath, maxDepth, minSizeMB);

          for (const file of modelFiles) {
            const model: DiscoveredModel = {
              id: `${modelId}-${basename(file.path)}`,
              path: file.path,
              format: file.format,
              size: file.size,
              quantization,
              parameters,
              source: "huggingface",
              discoveredAt: new Date(),
            };
            models.push(model);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to scan HuggingFace cache:", error);
    }

    return models;
  }

  /**
   * 扫描 Ollama 模型
   */
  private async scanOllamaModels(): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    const ollamaDir = join(homedir(), ".ollama", "models", "manifests");

    if (!existsSync(ollamaDir)) {
      return models;
    }

    try {
      // 尝试使用 ollama list 命令获取更准确的模型列表
      const { execSync } = await import("node:child_process");
      try {
        const output = execSync("ollama list", { encoding: "utf-8" });
        const lines = output.trim().split("\n").slice(1); // 跳过表头

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            const name = parts[0];
            const id = parts[1];
            const sizeStr = parts[2];
            const size = this.parseSize(sizeStr);

            // 查找对应的 blob 文件
            const blobPath = this.findOllamaBlob(name, id);

            if (blobPath) {
              models.push({
                id: `ollama-${name.replace(/[:\/]/g, "-")}`,
                path: blobPath,
                format: "gguf",
                size,
                source: "ollama",
                discoveredAt: new Date(),
              });
            }
          }
        }
      } catch {
        // ollama 命令失败，回退到文件扫描
        const blobDir = join(homedir(), ".ollama", "models", "blobs");
        if (existsSync(blobDir)) {
          const blobs = readdirSync(blobDir);
          for (const blob of blobs) {
            const blobPath = join(blobDir, blob);
            const stats = statSync(blobPath);
            if (stats.isFile() && stats.size > 100 * 1024 * 1024) {
              models.push({
                id: `ollama-${blob.substring(0, 12)}`,
                path: blobPath,
                format: "gguf",
                size: stats.size,
                source: "ollama",
                discoveredAt: new Date(),
              });
            }
          }
        }
      }
    } catch (error) {
      console.warn("Failed to scan Ollama models:", error);
    }

    return models;
  }

  /**
   * 扫描本地目录
   */
  private async scanLocalDirectory(
    dir: string,
    maxDepth: number,
    minSizeMB: number
  ): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    const resolvedDir = resolve(dir);

    if (!existsSync(resolvedDir)) {
      return models;
    }

    const files = this.findModelFiles(resolvedDir, maxDepth, minSizeMB);

    for (const file of files) {
      const model: DiscoveredModel = {
        id: this.generateModelId(file.path, resolvedDir),
        path: file.path,
        format: file.format,
        size: file.size,
        source: "local",
        discoveredAt: new Date(),
      };

      // 尝试从文件名解析量化信息
      const quantMatch = basename(file.path).match(/([Qq]\d+(_\d+)?)/);
      if (quantMatch) {
        model.quantization = quantMatch[1].toUpperCase();
      }

      models.push(model);
    }

    return models;
  }

  /**
   * 递归查找模型文件
   */
  private findModelFiles(
    dir: string,
    maxDepth: number,
    minSizeMB: number,
    currentDepth = 0
  ): Array<{ path: string; format: DiscoveredModel["format"]; size: number }> {
    if (currentDepth > maxDepth) {
      return [];
    }

    const files: Array<{ path: string; format: DiscoveredModel["format"]; size: number }> = [];
    const minSizeBytes = minSizeMB * 1024 * 1024;

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
          // 递归扫描子目录
          const subFiles = this.findModelFiles(
            fullPath,
            maxDepth,
            minSizeMB,
            currentDepth + 1
          );
          files.push(...subFiles);
        } else if (stats.isFile() && stats.size >= minSizeBytes) {
          const ext = extname(entry).toLowerCase();

          // 识别模型文件格式
          if (ext === ".gguf") {
            files.push({ path: fullPath, format: "gguf", size: stats.size });
          } else if (ext === ".safetensors") {
            files.push({ path: fullPath, format: "safetensors", size: stats.size });
          } else if (ext === ".kgm" || entry.endsWith(".kgm.json")) {
            files.push({ path: fullPath, format: "kgm", size: stats.size });
          }
        }
      }
    } catch (error) {
      // 忽略权限错误等
    }

    return files;
  }

  /**
   * 查找 Ollama blob 文件
   */
  private findOllamaBlob(name: string, id: string): string | null {
    const blobDir = join(homedir(), ".ollama", "models", "blobs");
    if (!existsSync(blobDir)) {
      return null;
    }

    // 尝试匹配 sha256-xxx 格式的 blob
    const expectedPrefix = `sha256-${id}`;
    const blobs = readdirSync(blobDir);

    for (const blob of blobs) {
      if (blob.startsWith(expectedPrefix) || blob.includes(id.substring(0, 12))) {
        const blobPath = join(blobDir, blob);
        if (existsSync(blobPath)) {
          return blobPath;
        }
      }
    }

    return null;
  }

  /**
   * 解析大小字符串
   */
  private parseSize(sizeStr: string): number {
    const units: Record<string, number> = {
      b: 1,
      kb: 1024,
      mb: 1024 * 1024,
      gb: 1024 * 1024 * 1024,
      tb: 1024 * 1024 * 1024 * 1024,
    };

    const match = sizeStr.toLowerCase().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2] || "b";
    return Math.floor(value * (units[unit] || 1));
  }

  /**
   * 生成模型 ID
   */
  private generateModelId(filePath: string, baseDir: string): string {
    const relativePath = filePath.replace(baseDir, "").replace(/^[/\\]/, "");
    const safeId = relativePath
      .replace(/[/\\]/g, "-")
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    return `local-${safeId}`;
  }

  /**
   * 获取已发现的模型
   */
  getDiscoveredModels(): DiscoveredModel[] {
    return Array.from(this.discoveredModels.values());
  }

  /**
   * 根据 ID 获取模型
   */
  getModel(id: string): DiscoveredModel | undefined {
    return this.discoveredModels.get(id);
  }

  /**
   * 清除发现记录
   */
  clear(): void {
    this.discoveredModels.clear();
  }
}

// 全局单例
export const globalModelDiscovery = new ModelDiscovery();
