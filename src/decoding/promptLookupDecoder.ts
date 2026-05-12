/**
 * Prompt Lookup Decoding
 * 借鉴 VMLX 的 n-gram 匹配加速技术
 * 无需 Draft Model 即可实现结构化输出加速
 */

export interface TokenMatch {
  tokens: number[];
  startIndex: number;
  confidence: number;
}

export class PromptLookupDecoder {
  private ngramIndex: Map<string, number[]> = new Map();
  private n: number = 4; // 默认使用 4-gram

  /**
   * 构建 n-gram 索引
   */
  buildIndex(prompt: string, tokenizer: (text: string) => number[], n?: number): void {
    this.n = n || this.n;
    const tokens = tokenizer(prompt);
    this.ngramIndex = new Map();

    for (let i = 0; i <= tokens.length - this.n; i++) {
      const key = tokens.slice(i, i + this.n).join(',');
      if (!this.ngramIndex.has(key)) {
        this.ngramIndex.set(key, []);
      }
      this.ngramIndex.get(key)!.push(i + this.n);
    }
  }

  /**
   * 在解码时查找匹配
   * @param prefixTokens - 当前前缀的 token 序列
   * @returns 匹配的后续 token 位置数组
   */
  findMatch(prefixTokens: number[]): TokenMatch | undefined {
    if (prefixTokens.length < this.n) {
      return undefined;
    }

    // 取最后 n 个 token 作为查找键
    const key = prefixTokens.slice(-this.n).join(',');
    const positions = this.ngramIndex.get(key);

    if (!positions || positions.length === 0) {
      return undefined;
    }

    // 返回第一个匹配位置及其上下文
    const startIndex = positions[0];
    return {
      tokens: positions,
      startIndex,
      confidence: positions.length / (this.ngramIndex.size || 1)
    };
  }

  /**
   * 批量查找匹配
   * @param prefixTokens - 当前前缀的 token 序列
   * @param maxResults - 最大返回数量
   */
  findMatches(prefixTokens: number[], maxResults: number = 5): TokenMatch[] {
    const matches: TokenMatch[] = [];
    
    // 尝试不同长度的 n-gram
    for (let currentN = Math.min(this.n, prefixTokens.length); currentN >= 2; currentN--) {
      const key = prefixTokens.slice(-currentN).join(',');
      const positions = this.ngramIndex.get(key);
      
      if (positions && positions.length > 0) {
        matches.push({
          tokens: positions.slice(0, maxResults),
          startIndex: positions[0],
          confidence: positions.length / (this.ngramIndex.size || 1) * (currentN / this.n)
        });
      }
      
      if (matches.length >= maxResults) {
        break;
      }
    }

    // 按置信度排序
    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取索引统计信息
   */
  getStats(): {
    ngramCount: number;
    n: number;
    coverage: number;
  } {
    return {
      ngramCount: this.ngramIndex.size,
      n: this.n,
      coverage: this.ngramIndex.size > 0 ? 
        Array.from(this.ngramIndex.values()).reduce((acc, arr) => acc + arr.length, 0) / this.ngramIndex.size : 0
    };
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.ngramIndex.clear();
  }
}
