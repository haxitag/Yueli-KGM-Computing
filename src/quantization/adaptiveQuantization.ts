/**
 * 自适应混合精度量化管理器
 * 借鉴 VMLX 的 JANG 2-bit 自适应量化技术
 * 根据模型层重要性动态选择量化精度
 */

export interface QuantizationConfig {
  bits: number;
  type: 'fp16' | 'int8' | 'nf4' | 'jang';
  enabled: boolean;
}

export interface LayerInfo {
  name: string;
  type: 'attention' | 'feedforward' | 'embedding' | 'normalization' | 'output';
  importance: number; // 0-1 重要性分数
  parameters: number;
}

export class AdaptiveQuantizationManager {
  private layerImportanceCache: Map<string, number> = new Map();
  private defaultConfig: QuantizationConfig = { bits: 4, type: 'nf4', enabled: true };

  /**
   * 根据层类型和重要性选择量化配置
   */
  selectQuantization(layer: LayerInfo): QuantizationConfig {
    const cached = this.layerImportanceCache.get(layer.name);
    if (cached !== undefined) {
      layer.importance = cached;
    }

    // 关键层保持高精度，非关键层使用低精度
    if (layer.importance > 0.9) {
      return { bits: 16, type: 'fp16', enabled: true };
    }
    if (layer.importance > 0.7) {
      return { bits: 8, type: 'int8', enabled: true };
    }
    if (layer.importance > 0.5) {
      return { bits: 4, type: 'nf4', enabled: true };
    }
    // JANG 自适应混合精度（VMLX 特色技术）
    return { bits: 2, type: 'jang', enabled: true };
  }

  /**
   * 计算层的重要性分数
   */
  calculateImportance(layer: Omit<LayerInfo, 'importance'>): number {
    let importance = 0.5; // 基础重要性

    // 根据层类型加权
    switch (layer.type) {
      case 'attention':
        importance += 0.3; // 注意力层更重要
        break;
      case 'embedding':
        importance += 0.2;
        break;
      case 'output':
        importance += 0.25;
        break;
      case 'feedforward':
        importance += 0.1;
        break;
      case 'normalization':
        importance -= 0.1;
        break;
    }

    // 根据参数数量调整（参数越多越重要）
    const paramFactor = Math.min(layer.parameters / 1000000, 0.3);
    importance += paramFactor;

    // 限制在 0-1 范围内
    return Math.max(0, Math.min(1, importance));
  }

  /**
   * 批量处理模型所有层
   */
  processModelLayers(layers: Omit<LayerInfo, 'importance'>[]): QuantizationConfig[] {
    return layers.map(layer => {
      const importance = this.calculateImportance(layer);
      this.layerImportanceCache.set(layer.name, importance);
      return this.selectQuantization({ ...layer, importance });
    });
  }

  /**
   * 获取量化统计信息
   */
  getStats(): { totalLayers: number; byPrecision: Record<string, number> } {
    const byPrecision: Record<string, number> = { 'fp16': 0, 'int8': 0, 'nf4': 0, 'jang': 0 };
    
    this.layerImportanceCache.forEach(importance => {
      let type: keyof typeof byPrecision;
      if (importance > 0.9) type = 'fp16';
      else if (importance > 0.7) type = 'int8';
      else if (importance > 0.5) type = 'nf4';
      else type = 'jang';
      byPrecision[type]++;
    });

    return {
      totalLayers: this.layerImportanceCache.size,
      byPrecision
    };
  }
}
