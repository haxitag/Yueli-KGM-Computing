/**
 * 多模态服务引擎。
 * 未注册专用服务时走与 HTTP `/v1/images|audio` 相同的 media provider。
 * 未配置上游时抛出真实错误，不返回占位字节。
 */

import type { KgmConfig } from "../core/configStore.js";
import { ConfigStore } from "../core/configStore.js";
import {
  proxyAudioSpeech,
  proxyAudioTranscriptions,
  proxyImagesEdits,
  proxyImagesGenerations,
} from "../openai/mediaCompat.js";
import type { MediaProxyResult } from "../openai/mediaCompat.js";

export interface ImageOptions {
  width?: number;
  height?: number;
  steps?: number;
  model?: string;
  style?: string;
}

export interface SpeechOptions {
  voice?: string;
  language?: string;
  rate?: number;
  pitch?: number;
}

export interface MultimodalRequest {
  type: 'image' | 'image-edit' | 'tts' | 'stt' | 'vision';
  prompt?: string;
  image?: Buffer | string;
  audio?: Buffer;
  options?: ImageOptions | SpeechOptions;
}

export interface MultimodalResponse {
  type: 'image' | 'audio' | 'text' | 'vision';
  data: Buffer | string | number[];
  metadata?: Record<string, unknown>;
}

export interface MultimodalService {
  generateImage(prompt: string, options?: ImageOptions): Promise<Buffer>;
  editImage(base64Image: string, prompt: string): Promise<Buffer>;
  textToSpeech(text: string, options?: SpeechOptions): Promise<Buffer>;
  speechToText(audioBuffer: Buffer): Promise<string>;
  visionEmbed(imageBuffer: Buffer): Promise<number[]>;
}

export class IntegratedMultimodalEngine implements MultimodalService {
  private services: Partial<Record<string, MultimodalService>> = {};
  private mediaConfig?: Pick<KgmConfig, "media" | "llm">;
  private defaultOptions = {
    image: { width: 1024, height: 1024, steps: 4 },
    speech: { voice: 'default', language: 'zh-CN' }
  };

  constructor(mediaConfig?: Pick<KgmConfig, "media" | "llm">) {
    this.mediaConfig = mediaConfig;
  }

  private resolvedMediaConfig(): Pick<KgmConfig, "media" | "llm"> {
    return this.mediaConfig ?? new ConfigStore().get();
  }

  private assertMedia(result: MediaProxyResult): asserts result is Extract<MediaProxyResult, { ok: true }> {
    if (!result.ok) {
      const err = result.body.error;
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "media_provider_not_configured";
      throw new Error(code);
    }
  }

  /**
   * 注册多模态服务
   */
  registerService(type: string, service: MultimodalService): void {
    this.services[type] = service;
  }

  /**
   * 生成图像
   */
  async generateImage(prompt: string, options?: ImageOptions): Promise<Buffer> {
    const imageService = this.services['image'] || this.services['default'];
    if (imageService) {
      return imageService.generateImage(prompt, options);
    }
    const result = await proxyImagesGenerations(
      {
        prompt,
        size: options?.width && options?.height ? `${options.width}x${options.height}` : undefined,
        model: options?.model,
      },
      this.resolvedMediaConfig(),
    );
    this.assertMedia(result);
    if (result.binary) return result.binary;
    const rows = (result.json as { data?: Array<{ b64_json?: string }> } | undefined)?.data;
    const b64 = rows?.find((row) => typeof row.b64_json === "string")?.b64_json;
    if (!b64) {
      throw new Error("image_generation_empty_upstream");
    }
    return Buffer.from(b64, "base64");
  }

  /**
   * 编辑图像
   */
  async editImage(base64Image: string, prompt: string): Promise<Buffer> {
    const imageService = this.services['image'] || this.services['default'];
    if (imageService && typeof imageService.editImage === 'function') {
      return imageService.editImage(base64Image, prompt);
    }
    const result = await proxyImagesEdits(
      { prompt, image: base64Image },
      this.resolvedMediaConfig(),
    );
    this.assertMedia(result);
    if (result.binary) return result.binary;
    throw new Error("image_edit_empty_upstream");
  }

  /**
   * 文本转语音
   */
  async textToSpeech(text: string, options?: SpeechOptions): Promise<Buffer> {
    const ttsService = this.services['tts'] || this.services['default'];
    if (ttsService) {
      return ttsService.textToSpeech(text, options);
    }
    const result = await proxyAudioSpeech(
      { input: text, voice: options?.voice, model: undefined },
      this.resolvedMediaConfig(),
    );
    this.assertMedia(result);
    if (result.binary) return result.binary;
    throw new Error("text_to_speech_empty_upstream");
  }

  /**
   * 语音转文本
   */
  async speechToText(audioBuffer: Buffer): Promise<string> {
    const sttService = this.services['stt'] || this.services['default'];
    if (sttService) {
      return sttService.speechToText(audioBuffer);
    }
    const result = await proxyAudioTranscriptions(
      { file_base64: audioBuffer.toString("base64"), filename: "audio.bin" },
      this.resolvedMediaConfig(),
    );
    this.assertMedia(result);
    const text = (result.json as { text?: string } | undefined)?.text;
    if (typeof text !== "string") {
      throw new Error("speech_to_text_empty_upstream");
    }
    return text;
  }

  /**
   * 视觉嵌入
   */
  async visionEmbed(imageBuffer: Buffer): Promise<number[]> {
    const visionService = this.services['vision'] || this.services['default'];
    if (visionService && typeof visionService.visionEmbed === 'function') {
      return visionService.visionEmbed(imageBuffer);
    }
    throw new Error("vision_embed_provider_not_configured");
  }

  /**
   * 统一多模态处理入口
   */
  async process(request: MultimodalRequest): Promise<MultimodalResponse> {
    switch (request.type) {
      case 'image':
        const image = await this.generateImage(
          request.prompt || '',
          request.options as ImageOptions
        );
        return { type: 'image', data: image };

      case 'image-edit':
        const edited = await this.editImage(
          typeof request.image === 'string' ? request.image : request.image?.toString('base64') || '',
          request.prompt || ''
        );
        return { type: 'image', data: edited };

      case 'tts':
        const audio = await this.textToSpeech(
          request.prompt || '',
          request.options as SpeechOptions
        );
        return { type: 'audio', data: audio };

      case 'stt':
        const text = await this.speechToText(
          request.audio || Buffer.from([])
        );
        return { type: 'text', data: text };

      case 'vision':
        const embed = await this.visionEmbed(
          typeof request.image === 'string' ? Buffer.from(request.image, 'base64') : request.image || Buffer.from([])
        );
        return { type: 'vision', data: embed };

      default:
        throw new Error(`Unsupported request type: ${request.type}`);
    }
  }

  /**
   * 获取可用服务列表
   */
  getAvailableServices(): string[] {
    return Object.keys(this.services);
  }

  /**
   * 检查服务是否可用
   */
  hasService(type: string): boolean {
    return typeof this.services[type] !== 'undefined';
  }
}
