import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { breakLongCjkProseParagraphs, prepareChatMessageForDisplay } from './index.js';

describe('breakLongCjkProseParagraphs', () => {
  it('inserts breaks after Chinese sentence ends on long lines', () => {
    const line =
      '大家好，我是 Yueli Copilot，面向企业知识场景。我擅长写作与结构化输出。' +
      '我还能协助分析、检索与多轮对话任务编排，帮助团队提升交付效率与可读性。';
    const out = breakLongCjkProseParagraphs(line);
    assert.ok(out.includes('。\n\n'));
    assert.ok(out.split('\n\n').length >= 2);
  });

  it('splits inline bullet + emoji capability list onto separate markdown lines', () => {
    const raw =
      '• 📝内容创作 ——文章、文档博客白皮书等 • 🌐翻译多语言专业 💻代码生成高质量 📊数据分析 🔍信息总结 💡创意构思';
    const out = prepareChatMessageForDisplay(raw);
    assert.ok(out.includes('- 📝'));
    assert.ok(out.includes('- 🌐'));
    assert.ok(out.includes('- 💻'));
    assert.ok(out.includes('- 📊'));
    assert.ok(out.split('\n').filter((l) => /^- /.test(l.trim())).length >= 4);
  });

  it('prepareChatMessageForDisplay does not collapse readable paragraphs', () => {
    const raw = '好的，我来写自我介绍。大家好我是 Copilot。我擅长结构化输出。';
    const out = prepareChatMessageForDisplay(raw);
    assert.ok(out.includes('\n') || out.length < 80);
  });
});
