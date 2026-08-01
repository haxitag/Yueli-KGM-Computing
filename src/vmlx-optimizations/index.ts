/**
 * VMLX 最佳实践优化模块
 * 整合所有从 VMLX 借鉴的优化技术
 */

export * from '../quantization/adaptiveQuantization.js';
export * from '../cache/layeredCache.js';
export * from '../decoding/promptLookupDecoder.js';
export * from '../distributed/clusterManager.js';
export * from '../multimodal/multimodalEngine.js';

import { AdaptiveQuantizationManager } from '../quantization/adaptiveQuantization.js';
import { LayeredCacheManager } from '../cache/layeredCache.js';
import { PromptLookupDecoder } from '../decoding/promptLookupDecoder.js';
import { DistributedClusterManager } from '../distributed/clusterManager.js';
import { IntegratedMultimodalEngine } from '../multimodal/multimodalEngine.js';

/**
 * 创建优化套件
 */
export function createOptimizationSuite() {
  return {
    quantization: new AdaptiveQuantizationManager(),
    cache: new LayeredCacheManager({}),
    decoder: new PromptLookupDecoder(),
    cluster: new DistributedClusterManager({}),
    multimodal: new IntegratedMultimodalEngine()
  };
}

export type OptimizationSuite = ReturnType<typeof createOptimizationSuite>;
