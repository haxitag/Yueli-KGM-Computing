import type { Embedder } from "../embedding/canonical.js";
import type { Signal, SignalType } from "../core/types.js";

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'pdf' | 'text';

export type MediaContent = {
  /** 媒体类型 */
  type: MediaType;
  /** 媒体数据（URL、Base64或文本内容） */
  data: string;
  /** 媒体元数据 */
  metadata?: {
    /** 文件名 */
    filename?: string;
    /** 文件大小（字节） */
    size?: number;
    /** MIME类型 */
    mimeType?: string;
    /** 维度信息（对于图像/视频） */
    dimensions?: { width: number; height: number };
    /** 时长（对于音频/视频，单位秒） */
    duration?: number;
    /** 创建时间 */
    createdAt?: string;
  };
};

export type ProcessedMediaContent = {
  /** 媒体类型 */
  type: MediaType;
  /** 处理后的文本表示 */
  textRepresentation: string;
  /** 嵌入向量 */
  embedding?: number[];
  /** 媒体特征 */
  features?: Record<string, unknown>;
  /** 媒体元数据 */
  metadata: MediaContent['metadata'];
};

export type MultimodalProviderConfig = {
  baseUrl: string;
  path: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type MultimodalProcessingOptions = {
  /** 图像处理选项 */
  image?: {
    /** 是否提取文本（OCR） */
    extractText?: boolean;
    /** 是否提取视觉特征 */
    extractFeatures?: boolean;
    /** 图像描述生成 */
    generateDescription?: boolean;
  };
  /** 音频处理选项 */
  audio?: {
    /** 是否转录为文本 */
    transcribe?: boolean;
    /** 音频特征提取 */
    extractFeatures?: boolean;
  };
  /** 视频处理选项 */
  video?: {
    /** 是否提取关键帧 */
    extractKeyFrames?: boolean;
    /** 是否转录音频 */
    transcribeAudio?: boolean;
    /** 视频描述生成 */
    generateDescription?: boolean;
  };
  /** 文档处理选项 */
  document?: {
    /** 是否提取文本 */
    extractText?: boolean;
    /** 是否保留格式 */
    preserveFormat?: boolean;
  };
  /** 嵌入处理选项 */
  embedder?: Embedder;
  /** 最大处理时间（毫秒） */
  timeoutMs?: number;
  /** 外部多模态 provider；未传时读取 KGM_MULTIMODAL_* 环境变量 */
  provider?: MultimodalProviderConfig;
};

export class MultimodalProcessor {
  /**
   * 处理单个媒体内容
   */
  async processMedia(
    content: MediaContent, 
    options: MultimodalProcessingOptions = {}
  ): Promise<ProcessedMediaContent> {
    const { embedder, timeoutMs = 30000 } = options;
    
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Media processing timeout')), timeoutMs);
    });

    const processingPromise = this.processMediaType(content, options);
    const result = await Promise.race([processingPromise, timeoutPromise]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    
    // 如果提供了嵌入器，生成嵌入向量
    if (embedder && result.textRepresentation) {
      result.embedding = await embedder.embed(result.textRepresentation);
    }
    
    return result;
  }

  /**
   * 批量处理多个媒体内容
   */
  async processBatch(
    contents: MediaContent[], 
    options: MultimodalProcessingOptions = {}
  ): Promise<ProcessedMediaContent[]> {
    const results: ProcessedMediaContent[] = [];
    
    for (const content of contents) {
      const processed = await this.processMedia(content, options);
      results.push(processed);
    }
    
    return results;
  }

  /**
   * 根据媒体类型处理内容
   */
  private async processMediaType(
    content: MediaContent, 
    options: MultimodalProcessingOptions
  ): Promise<ProcessedMediaContent> {
    switch (content.type) {
      case 'image':
        return this.processImage(content, options.image || {}, options);
      case 'audio':
        return this.processAudio(content, options.audio || {}, options);
      case 'video':
        return this.processVideo(content, options.video || {}, options);
      case 'document':
      case 'pdf':
        return this.processDocument(content, options.document || {});
      case 'text':
        return this.processText(content);
      default:
        throw new Error(`Unsupported media type: ${content.type}`);
    }
  }

  /**
   * 处理图像内容
   */
  private async processImage(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['image']>,
    rootOptions: MultimodalProcessingOptions,
  ): Promise<ProcessedMediaContent> {
    const { extractText = true, extractFeatures = true, generateDescription = true } = options;
    
    if (extractText || generateDescription || extractFeatures) {
      return callMultimodalProvider(content, {
        tasks: { extractText, extractFeatures, generateDescription },
        provider: rootOptions.provider,
        timeoutMs: rootOptions.timeoutMs,
      });
    }
    
    return {
      type: 'image',
      textRepresentation: '',
      features: {},
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理音频内容
   */
  private async processAudio(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['audio']>,
    rootOptions: MultimodalProcessingOptions,
  ): Promise<ProcessedMediaContent> {
    const { transcribe = true, extractFeatures = true } = options;
    
    if (transcribe || extractFeatures) {
      return callMultimodalProvider(content, {
        tasks: { transcribe, extractFeatures },
        provider: rootOptions.provider,
        timeoutMs: rootOptions.timeoutMs,
      });
    }
    
    return {
      type: 'audio',
      textRepresentation: '',
      features: {},
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理视频内容
   */
  private async processVideo(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['video']>,
    rootOptions: MultimodalProcessingOptions,
  ): Promise<ProcessedMediaContent> {
    const { extractKeyFrames = true, transcribeAudio = true, generateDescription = true } = options;

    if (extractKeyFrames || transcribeAudio || generateDescription) {
      return callMultimodalProvider(content, {
        tasks: { extractKeyFrames, transcribeAudio, generateDescription },
        provider: rootOptions.provider,
        timeoutMs: rootOptions.timeoutMs,
      });
    }
    
    return {
      type: 'video',
      textRepresentation: '',
      features: {},
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理文档内容
   */
  private async processDocument(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['document']>
  ): Promise<ProcessedMediaContent> {
    const { extractText = true, preserveFormat = false } = options;
    
    let textRepresentation = '';
    
    if (extractText) {
      textRepresentation = content.data;
    }
    
    return {
      type: content.type,
      textRepresentation,
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理纯文本内容
   */
  private async processText(content: MediaContent): Promise<ProcessedMediaContent> {
    return {
      type: 'text',
      textRepresentation: content.data,
      metadata: content.metadata || {},
    };
  }

  /**
   * 将媒体内容转换为信号
   */
  async convertToSignal(
    content: MediaContent,
    options: MultimodalProcessingOptions = {}
  ): Promise<Signal> {
    const processed = await this.processMedia(content, options);
    
    // 确定信号类型
    let signalType: SignalType = 'web'; // 默认类型
    
    switch (content.type) {
      case 'image':
        signalType = 'web'; // 可以是web或其他类型
        break;
      case 'audio':
        signalType = 'web';
        break;
      case 'video':
        signalType = 'web';
        break;
      case 'document':
      case 'pdf':
        signalType = 'web';
        break;
      case 'text':
        signalType = 'web';
        break;
    }
    
    return {
      type: signalType,
      source: `multimodal-${content.type}`,
      title: content.metadata?.filename || `Multimodal Content ${content.type}`,
      value: processed.textRepresentation,
      timestamp: new Date().toISOString(),
      metadata: processed.features || {},
    };
  }

  /**
   * 从URL加载媒体内容
   */
  async loadFromUrl(url: string): Promise<MediaContent> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`media_fetch_failed:${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const data = await response.arrayBuffer();
    const extension = url.split('.').pop()?.toLowerCase() || '';
    let mediaType = this.getMediaTypeFromMime(contentType);
    
    if (!mediaType && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
      mediaType = 'image';
    } else if (!mediaType && ['mp3', 'wav', 'ogg', 'flac'].includes(extension)) {
      mediaType = 'audio';
    } else if (!mediaType && ['mp4', 'avi', 'mov', 'mkv'].includes(extension)) {
      mediaType = 'video';
    } else if (!mediaType && ['pdf', 'doc', 'docx'].includes(extension)) {
      mediaType = 'document';
    }
    if (!mediaType) {
      mediaType = 'text';
    }
    
    return {
      type: mediaType,
      data: mediaType === 'text' ? new TextDecoder().decode(data) : Buffer.from(data).toString('base64'),
      metadata: {
        filename: url.split('/').pop(),
        mimeType: contentType || this.getMimeType(mediaType),
        size: data.byteLength,
      },
    };
  }

  private getMediaTypeFromMime(mimeType: string): MediaType | undefined {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType === "application/pdf") return "pdf";
    if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml")) return "text";
    return undefined;
  }

  /**
   * 获取媒体类型对应的MIME类型
   */
  private getMimeType(type: MediaType): string {
    switch (type) {
      case 'image':
        return 'image/jpeg';
      case 'audio':
        return 'audio/mpeg';
      case 'video':
        return 'video/mp4';
      case 'document':
        return 'application/msword';
      case 'pdf':
        return 'application/pdf';
      case 'text':
        return 'text/plain';
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * 验证媒体内容
   */
  validateMediaContent(content: MediaContent): boolean {
    if (!content.type || !content.data) {
      return false;
    }
    
    const validTypes: MediaType[] = ['image', 'audio', 'video', 'document', 'pdf', 'text'];
    return validTypes.includes(content.type);
  }

  /**
   * 估算处理时间
   */
  estimateProcessingTime(content: MediaContent): number {
    // 根据媒体类型和大小估算处理时间（毫秒）
    const baseTime = 1000; // 基础处理时间1秒
    
    if (content.metadata?.size) {
      // 每MB增加1秒处理时间
      const sizeInMB = content.metadata.size / (1024 * 1024);
      return baseTime + (sizeInMB * 1000);
    }
    
    switch (content.type) {
      case 'image':
        return baseTime * 2; // 图像处理可能较慢
      case 'audio':
        return baseTime * 3; // 音频转录耗时较长
      case 'video':
        return baseTime * 5; // 视频处理最耗时
      default:
        return baseTime;
    }
  }
}

async function callMultimodalProvider(
  content: MediaContent,
  params: {
    tasks: Record<string, boolean>;
    provider?: MultimodalProviderConfig;
    timeoutMs?: number;
  },
): Promise<ProcessedMediaContent> {
  const provider = params.provider ?? providerFromEnv();
  if (!provider) {
    throw new Error(`${content.type}_processing_provider_not_configured`);
  }
  const timeoutMs = params.timeoutMs ?? provider.timeoutMs ?? 120000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(joinUrl(provider.baseUrl, provider.path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        type: content.type,
        data: content.data,
        metadata: content.metadata ?? {},
        tasks: params.tasks,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`multimodal_provider_http_${response.status}:${await response.text()}`);
    }
    return parseProviderResponse(content, await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function parseProviderResponse(content: MediaContent, raw: unknown): ProcessedMediaContent {
  if (!raw || typeof raw !== "object") {
    throw new Error("multimodal_provider_invalid_response");
  }
  const record = raw as Record<string, unknown>;
  const nested = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
  const textRepresentation =
    readString(nested, "textRepresentation")
    ?? readString(nested, "text")
    ?? readString(nested, "markdown")
    ?? readString(nested, "description")
    ?? readString(nested, "transcript")
    ?? "";
  const features = readRecord(nested, "features") ?? readRecord(nested, "metadata") ?? {};
  return {
    type: content.type,
    textRepresentation,
    features,
    metadata: {
      ...(content.metadata ?? {}),
      ...(readRecord(nested, "mediaMetadata") ?? {}),
    },
  };
}

function providerFromEnv(): MultimodalProviderConfig | undefined {
  const baseUrl = process.env.KGM_MULTIMODAL_BASE_URL?.trim();
  if (!baseUrl) {
    return undefined;
  }
  return {
    baseUrl,
    path: process.env.KGM_MULTIMODAL_PATH?.trim() || "/v1/media/process",
    model: process.env.KGM_MULTIMODAL_MODEL?.trim() || undefined,
    apiKey: process.env.KGM_MULTIMODAL_KEY?.trim() || undefined,
    timeoutMs: parseNumber(process.env.KGM_MULTIMODAL_TIMEOUT_MS),
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
