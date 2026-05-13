import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const bindingModuleCache = new Map();
export function getNativeCoreBindingStatus() {
    const configuredPath = process.env.KGM_NATIVE_CORE_LIBRARY?.trim();
    if (!configuredPath) {
        return {
            backend: "native-core",
            configured: false,
            available: false,
            reason: "KGM_NATIVE_CORE_LIBRARY is not set",
        };
    }
    const libraryPath = path.resolve(configuredPath);
    if (!fs.existsSync(libraryPath)) {
        return {
            backend: "native-core",
            configured: true,
            available: false,
            libraryPath,
            reason: "configured native core library does not exist",
        };
    }
    return {
        backend: "native-core",
        configured: true,
        available: true,
        libraryPath,
    };
}
export async function loadNativeCoreBinding() {
    const status = getNativeCoreBindingStatus();
    if (!status.available || !status.libraryPath) {
        throw new Error(`Yueli KGM Runtime core binding unavailable:${status.reason ?? "binding_not_configured"}`);
    }
    const cached = bindingModuleCache.get(status.libraryPath);
    if (cached) {
        return cached;
    }
    const loading = importNativeCoreBindingModule(status.libraryPath);
    bindingModuleCache.set(status.libraryPath, loading);
    return loading;
}
async function importNativeCoreBindingModule(libraryPath) {
    const loaded = await tryImportModule(libraryPath);
    const resolved = resolveBindingExport(loaded);
    if (!resolved || typeof resolved.createBackend !== "function") {
        throw new Error(`native_core_binding_invalid_exports:${libraryPath}`);
    }
    if (resolved.kind && resolved.kind !== "kgm-native-core-binding") {
        throw new Error(`native_core_binding_invalid_kind:${libraryPath}`);
    }
    return resolved;
}
async function tryImportModule(libraryPath) {
    const extension = path.extname(libraryPath).toLowerCase();
    if (extension === ".cjs" || extension === ".node") {
        const require = createRequire(import.meta.url);
        return require(libraryPath);
    }
    try {
        return await import(pathToFileURL(libraryPath).href);
    }
    catch (error) {
        if (extension !== ".js") {
            throw error;
        }
        const require = createRequire(import.meta.url);
        return require(libraryPath);
    }
}
function resolveBindingExport(loaded) {
    if (!loaded || typeof loaded !== "object") {
        return null;
    }
    const record = loaded;
    if (isBindingModule(record)) {
        return record;
    }
    if (record.default && isBindingModule(record.default)) {
        return record.default;
    }
    if (typeof record.createBackend === "function") {
        return {
            kind: "kgm-native-core-binding",
            version: 1,
            createBackend: record.createBackend,
        };
    }
    return null;
}
function isBindingModule(value) {
    return Boolean(value && typeof value === "object" && typeof value.createBackend === "function");
}
