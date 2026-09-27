import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixAtxHeadingSpacing,
  normalizeGfmLite,
  normalizeJammedMarkdownBlockBreaks
} from './gfm-lite.js';
import { resolveOutputNormalizeMode, applyOutputNormalizeIfEnabled } from './resolve.js';
import { prepareChatMessageForDisplay } from './prepare.js';

describe('normalizeGfmLite', () => {
  it('fixAtxHeadingSpacing inserts space after hashes', () => {
    assert.equal(fixAtxHeadingSpacing('##写在前面'), '## 写在前面');
    assert.equal(fixAtxHeadingSpacing('###2.1 能力'), '### 2.1 能力');
  });

  it('normalizeJammedMarkdownBlockBreaks splits glued headings', () => {
    const raw = '句号。---### 标题';
    const out = normalizeJammedMarkdownBlockBreaks(raw);
    assert.ok(out.includes('\n### '));
  });

  it('normalizeGfmLite fixes list after paragraph', () => {
    assert.equal(normalizeGfmLite('你好：\n- 一项'), '你好：\n\n- 一项');
  });

  it('prepareChatMessageForDisplay handles ##写在前面', () => {
    const out = prepareChatMessageForDisplay('##写在前面\n正文');
    assert.ok(out.startsWith('## 写在前面'));
  });

  it('splits packed emoji bullet capability list onto separate lines', () => {
    const raw = '• 📝写作助手 • 🌐翻译 • 💻代码 • 📊分析';
    const out = normalizeGfmLite(raw);
    assert.match(out, /^- 📝写作助手/m);
    assert.match(out, /^- 🌐翻译/m);
    assert.match(out, /^- 💻代码/m);
    assert.match(out, /^- 📊分析/m);
    assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 4);
  });
});

describe('resolveOutputNormalizeMode', () => {
  it('reads kgm.extensions.output.normalize', () => {
    assert.equal(
      resolveOutputNormalizeMode({ extensions: { output: { normalize: 'gfm-lite' } } }),
      'gfm-lite'
    );
  });

  it('applyOutputNormalizeIfEnabled is no-op when off', () => {
    assert.equal(applyOutputNormalizeIfEnabled('##写在'), '##写在');
  });

  it('applyOutputNormalizeIfEnabled fixes when on', () => {
    const out = applyOutputNormalizeIfEnabled('##写在', {
      extensions: { output: { normalize: 'gfm-lite' } }
    });
    assert.equal(out, '## 写在');
  });
});
