const listSandboxesDefinition = {
    name: "list_sandboxes",
    kind: "tool",
    description: "List available virtual sandboxes and their preview state.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
        type: "object",
        properties: {
            sandboxes: { type: "array" },
        },
    },
    metadata: {
        latency: "fast",
        sideEffect: false,
        costLevel: "low",
        permission: "sandbox:read",
        integration: "builtin",
        tags: ["sandbox", "preview"],
    },
};
const startSandboxDefinition = {
    name: "start_sandbox",
    kind: "tool",
    description: "Start a sandbox instance by id.",
    inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
            id: { type: "string" },
        },
    },
    outputSchema: {
        type: "object",
        properties: {
            sandbox: { type: "object" },
        },
    },
    metadata: {
        latency: "medium",
        sideEffect: true,
        costLevel: "medium",
        permission: "sandbox:control",
        integration: "builtin",
        tags: ["sandbox", "control"],
    },
};
const stopSandboxDefinition = {
    name: "stop_sandbox",
    kind: "tool",
    description: "Stop a sandbox instance by id.",
    inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
            id: { type: "string" },
        },
    },
    outputSchema: {
        type: "object",
        properties: {
            sandbox: { type: "object" },
        },
    },
    metadata: {
        latency: "medium",
        sideEffect: true,
        costLevel: "medium",
        permission: "sandbox:control",
        integration: "builtin",
        tags: ["sandbox", "control"],
    },
};
export function registerSandboxTools(registry, sandboxManager) {
    registry.register(listSandboxesDefinition, async () => ({ sandboxes: sandboxManager.list() }));
    registry.register(startSandboxDefinition, async (args) => ({ sandbox: sandboxManager.start(String(args.id ?? "")) }));
    registry.register(stopSandboxDefinition, async (args) => ({ sandbox: sandboxManager.stop(String(args.id ?? "")) }));
}
