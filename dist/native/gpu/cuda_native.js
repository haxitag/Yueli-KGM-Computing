import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
export function loadNativeCudaLikeApi() {
    const require = createRequire(import.meta.url);
    const configured = process.env.KGM_NATIVE_CORE_ADDON?.trim();
    const defaultPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../native-core/build/Release/kgm_native_core.node");
    const addonPath = path.resolve(configured || defaultPath);
    if (!fs.existsSync(addonPath)) {
        return null;
    }
    const loaded = require(addonPath);
    const cuda = loaded?.cuda;
    if (!cuda?.malloc || !cuda?.memcpyHtoD || !cuda.deviceInfo) {
        return null;
    }
    const info = cuda.deviceInfo();
    const api = {
        malloc: (byteLength) => cuda.malloc(byteLength),
        memcpyHtoD: (ptr, bytes) => cuda.memcpyHtoD(ptr, bytes),
    };
    return { api, info: { available: Boolean(info?.available), reason: info?.reason } };
}
export function loadNativeCudaMemoryApi() {
    const require = createRequire(import.meta.url);
    const configured = process.env.KGM_NATIVE_CORE_ADDON?.trim();
    const defaultPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../native-core/build/Release/kgm_native_core.node");
    const addonPath = path.resolve(configured || defaultPath);
    if (!fs.existsSync(addonPath)) {
        return null;
    }
    const loaded = require(addonPath);
    const cuda = loaded?.cuda;
    if (!cuda?.malloc || !cuda?.memcpyHtoD || !cuda?.memcpyDtoH || !cuda.deviceInfo) {
        return null;
    }
    const info = cuda.deviceInfo();
    return {
        info: { available: Boolean(info?.available), reason: info?.reason },
        mem: {
            malloc: (byteLength) => cuda.malloc(byteLength),
            memcpyHtoD: (ptr, bytes) => cuda.memcpyHtoD(ptr, bytes),
            read: (ptr) => cuda.memcpyDtoH(ptr),
        },
    };
}
