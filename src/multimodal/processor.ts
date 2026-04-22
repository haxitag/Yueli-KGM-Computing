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
    
    // 设置超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Media processing timeout')), timeoutMs);
    });

    // 根据媒体类型处理内容
    const processingPromise = this.processMediaType(content, options);
    
    // 使用竞态条件来处理超时
    const result = await Promise.race([processingPromise, timeoutPromise]);
    
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
      try {
        const processed = await this.processMedia(content, options);
        results.push(processed);
      } catch (error) {
        console.error(`Failed to process media content:`, error);
        // 添加错误占位符
        results.push({
          type: content.type,
          textRepresentation: `Error processing ${content.type} content`,
          metadata: content.metadata || {},
        });
      }
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
        return this.processImage(content, options.image || {});
      case 'audio':
        return this.processAudio(content, options.audio || {});
      case 'video':
        return this.processVideo(content, options.video || {});
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
    options: NonNullable<MultimodalProcessingOptions['image']>
  ): Promise<ProcessedMediaContent> {
    const { extractText = true, extractFeatures = true, generateDescription = true } = options;
    
    let textRepresentation = '';
    const features: Record<string, unknown> = {};
    
    // 在实际实现中，这里会调用图像处理服务
    // 例如调用Vision API进行图像描述或OCR
    if (extractText) {
      // 模拟OCR结果
      textRepresentation += 'Image OCR result: [OCR content would appear here]\n';
    }
    
    if (generateDescription) {
      // 模拟图像描述
      textRepresentation += 'Image description: [Visual content description would appear here]\n';
    }
    
    if (extractFeatures) {
      // 模拟视觉特征
      features.visualTags = ['object1', 'object2', 'scene_type'];
      features.colorPalette = ['#FF0000', '#00FF00', '#0000FF'];
    }
    
    return {
      type: 'image',
      textRepresentation: textRepresentation.trim(),
      features,
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理音频内容
   */
  private async processAudio(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['audio']>
  ): Promise<ProcessedMediaContent> {
    const { transcribe = true, extractFeatures = true } = options;
    
    let textRepresentation = '';
    const features: Record<string, unknown> = {};
    
    if (transcribe) {
      // 模拟音频转录
      textRepresentation = 'Audio transcription: [Transcribed speech would appear here]';
    }
    
    if (extractFeatures) {
      // 模拟音频特征
      features.transcript = '[Transcribed speech would appear here]';
      features.speakers = ['Speaker 1'];
      features.language = 'en';
    }
    
    return {
      type: 'audio',
      textRepresentation,
      features,
      metadata: content.metadata || {},
    };
  }

  /**
   * 处理视频内容
   */
  private async processVideo(
    content: MediaContent, 
    options: NonNullable<MultimodalProcessingOptions['video']>
  ): Promise<ProcessedMediaContent> {
    const { extractKeyFrames = true, transcribeAudio = true, generateDescription = true } = options;
    
    let textRepresentation = '';
    const features: Record<string, unknown> = {};
    
    if (extractKeyFrames) {
      textRepresentation += 'Video key frames extracted\n';
    }
    
    if (transcribeAudio) {
      textRepresentation += 'Video audio transcription: [Transcribed speech would appear here]\n';
    }
    
    if (generateDescription) {
      textRepresentation += 'Video description: [Video content description would appear here]\n';
    }
    
    if (extractKeyFrames) {
      features.keyFrames = ['frame1', 'frame2', 'frame3'];
    }
    
    return {
      type: 'video',
      textRepresentation: textRepresentation.trim(),
      features,
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
      // 模拟文档文本提取
      textRepresentation = content.data; // 假设数据已经是文本内容
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
    // 在实际实现中，这里会下载媒体文件并识别类型
    // 模拟实现
    const extension = url.split('.').pop()?.toLowerCase() || '';
    let mediaType: MediaType = 'text';
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
      mediaType = 'image';
    } else if (['mp3', 'wav', 'ogg', 'flac'].includes(extension)) {
      mediaType = 'audio';
    } else if (['mp4', 'avi', 'mov', 'mkv'].includes(extension)) {
      mediaType = 'video';
    } else if (['pdf', 'doc', 'docx'].includes(extension)) {
      mediaType = 'document';
    }
    
    return {
      type: mediaType,
      data: url,
      metadata: {
        filename: url.split('/').pop(),
        mimeType: this.getMimeType(mediaType),
      },
    };
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