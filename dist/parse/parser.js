export function parseIntent(rawText) {
    const text = stripCodeFence(rawText.trim());
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "type" in parsed) {
            return parsed;
        }
    }
    catch {
        // fall through
    }
    return { type: "final", content: rawText };
}
function stripCodeFence(text) {
    if (text.startsWith("```")) {
        return text.replace(/^```[a-zA-Z]*\n/, "").replace(/```$/, "").trim();
    }
    return text;
}
