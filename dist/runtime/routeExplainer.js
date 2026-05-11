export function explainRuntimeRoute(params) {
    const config = params.configStore.get();
    const requestedModel = params.request?.model && params.request.model !== "auto" ? params.request.model : config.llm.model;
    const candidates = [];
    const route = params.topology.routes.find((item) => item.model === requestedModel) ?? params.topology.routes[0];
    if (route) {
        candidates.push({
            path: "llmProvider",
            engine: route.providerId,
            model: route.model,
            healthy: route.healthy,
            score: route.model === requestedModel ? 0.82 : 0.68,
            estimatedCost: 0,
            estimatedLatencyMs: 1800,
        });
    }
    const nativeModel = params.topology.paths.native.loadedModels[0] ?? null;
    candidates.push({
        path: "native",
        model: nativeModel,
        healthy: Boolean(nativeModel),
        score: nativeModel ? 0.7 : undefined,
        estimatedCost: nativeModel ? 0 : undefined,
        estimatedLatencyMs: nativeModel ? 1200 : undefined,
        reason: nativeModel ? undefined : "no native model loaded",
    });
    const blockingIssues = params.issues.filter((issue) => issue.severity === "error");
    const selected = candidates.find((candidate) => candidate.healthy && candidate.path === "llmProvider")
        ?? candidates.find((candidate) => candidate.healthy);
    return {
        selectedPath: selected?.path ?? "none",
        selectedEngine: selected?.engine ?? null,
        selectedModel: selected?.model ?? null,
        selectedRouteKey: selected?.path === "llmProvider" ? route?.key ?? null : null,
        candidates,
        blockingIssues,
        wouldUseMock: process.env.KGM_MOCK_MODE === "1",
    };
}
