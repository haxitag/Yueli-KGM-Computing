import type { FrontStationIntentLabel } from "./types.js";

/** 与 intentClassifier 原型一致，供 ONNX/MiniLM 嵌入分类复用 */
export const INTENT_PROTOTYPE_TEXTS: Record<FrontStationIntentLabel, string[]> = {
  path_analysis: ["路径", "关系链", "path analysis", "how are they connected", "关联路径", "路径分析"],
  summary: ["总结", "概括", "摘要", "summary", "summarize", "tl;dr"],
  risk_analysis: ["风险", "risk", "合规", "漏洞", "threat"],
  code_generation: ["代码", "函数", "typescript", "python", "bug", "api", "编程"],
  structured_output: ["json", "schema", "表格", "结构化", "output format"],
  math_reasoning: ["计算", "方程", "积分", "math", "prove", "求解"],
  translation: ["翻译", "translate", "英文", "中文", "日文"],
  reasoning: ["为什么", "推理", "分析原因", "why", "reason about"],
  knowledge_query: ["是什么", "什么是", "介绍", "who is", "what is", "知识"],
  general: ["你好", "hello", "帮我", "please"],
};
