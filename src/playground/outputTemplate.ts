/** 简单 {{var}} 插槽替换，供业务 HTML / Markdown 模板使用 */

export function applyOutputTemplateString(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_m, key) => {
    const k = String(key).trim();
    return vars[k] ?? "";
  });
}
