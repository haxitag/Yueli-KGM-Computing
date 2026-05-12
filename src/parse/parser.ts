import type { LlmIntent } from "../core/types.js";

export function parseIntent(rawText: string): LlmIntent {
  // 首先尝试直接解析
  let text = stripCodeFence(rawText.trim());
  
  // 尝试1：直接解析
  try {
    const parsed = JSON.parse(text) as LlmIntent;
    if (isValidLlmIntent(parsed)) {
      return parsed;
    }
  } catch {
    // 继续尝试其他方法
  }
  
  // 尝试2：在文本中查找JSON对象
  const jsonMatch = findJsonInText(rawText);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch) as LlmIntent;
      if (isValidLlmIntent(parsed)) {
        return parsed;
      }
    } catch {
      // 继续
    }
  }
  
  // 尝试3：简单的函数调用模式匹配
  const functionMatch = matchFunctionCall(rawText);
  if (functionMatch) {
    return functionMatch;
  }
  
  // 回退到最终响应
  return { type: "final", content: rawText };
}

function isValidLlmIntent(obj: unknown): obj is LlmIntent {
  if (!obj || typeof obj !== "object") return false;
  const intent = obj as Record<string, unknown>;
  if (typeof intent.type !== "string") return false;
  
  if (intent.type === "final") {
    return typeof intent.content === "string";
  } else if (intent.type === "call") {
    return typeof intent.target === "string";
  } else if (intent.type === "invoke_skill") {
    return typeof intent.skill === "string";
  }
  return false;
}

function findJsonInText(text: string): string | null {
  // 查找可能的JSON对象开始和结束位置
  let start = text.indexOf("{");
  if (start === -1) return null;
  
  let braceCount = 1;
  let end = -1;
  
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "{") braceCount++;
    else if (text[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        end = i;
        break;
      }
    }
  }
  
  if (end === -1) return null;
  return text.slice(start, end + 1);
}

function matchFunctionCall(text: string): LlmIntent | null {
  // 简单的函数调用模式匹配，如 "call search_web" 或 "invoke_skill my_skill"
  const callMatch = text.match(/^\s*(call|invoke_skill)\s+(\w+)(?:\s+(\{[\s\S]*\}))?/i);
  if (callMatch) {
    const [, action, name, argsStr] = callMatch;
    let args: Record<string, unknown> = {};
    
    if (argsStr) {
      try {
        args = JSON.parse(argsStr);
      } catch {
        args = { raw: argsStr };
      }
    }
    
    if (action.toLowerCase() === "call") {
      return {
        type: "call",
        target: name,
        arguments: args
      };
    } else if (action.toLowerCase() === "invoke_skill") {
      return {
        type: "invoke_skill",
        skill: name,
        input: args
      };
    }
  }
  return null;
}

function stripCodeFence(text: string): string {
  if (text.startsWith("```")) {
    return text.replace(/^```[a-zA-Z]*\n/, "").replace(/```$/, "").trim();
  }
  return text;
}
