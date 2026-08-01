import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { CudaLikeApi } from "./pipeline.js";

type NativeCudaModule = {
  cuda?: {
    deviceInfo?: () => { available: boolean; reason?: string; deviceCount?: number };
    malloc?: (byteLength: number) => { id: string };
    memcpyHtoD?: (ptr: { id: string }, bytes: Uint8Array) => void;
    memcpyDtoH?: (ptr: { id: string }) => Uint8Array;
    free?: (ptr: { id: string }) => void;
  };
};

export function loadNativeCudaLikeApi(): { api: CudaLikeApi; info: { available: boolean; reason?: string } } | null {
  const require = createRequire(import.meta.url);
  const configured = process.env.KGM_NATIVE_CORE_ADDON?.trim();
  const defaultPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../native-core/build/Release/kgm_native_core.node",
  );
  const addonPath = path.resolve(configured || defaultPath);
  if (!fs.existsSync(addonPath)) {
    return null;
  }
  const loaded = require(addonPath) as NativeCudaModule;
  const cuda = loaded?.cuda;
  if (!cuda?.malloc || !cuda?.memcpyHtoD || !cuda.deviceInfo) {
    return null;
  }
  const info = cuda.deviceInfo();
  const api: CudaLikeApi = {
    malloc: (byteLength) => cuda.malloc!(byteLength),
    memcpyHtoD: (ptr, bytes) => cuda.memcpyHtoD!(ptr, bytes),
  };
  return { api, info: { available: Boolean(info?.available), reason: info?.reason } };
}

export function loadNativeCudaMemoryApi(): {
  mem: CudaLikeApi & { read: (ptr: { id: string }) => Uint8Array };
  info: { available: boolean; reason?: string };
} | null {
  const require = createRequire(import.meta.url);
  const configured = process.env.KGM_NATIVE_CORE_ADDON?.trim();
  const defaultPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../native-core/build/Release/kgm_native_core.node",
  );
  const addonPath = path.resolve(configured || defaultPath);
  if (!fs.existsSync(addonPath)) {
    return null;
  }
  const loaded = require(addonPath) as NativeCudaModule;
  const cuda = loaded?.cuda;
  if (!cuda?.malloc || !cuda?.memcpyHtoD || !cuda?.memcpyDtoH || !cuda.deviceInfo) {
    return null;
  }
  const info = cuda.deviceInfo();
  return {
    info: { available: Boolean(info?.available), reason: info?.reason },
    mem: {
      malloc: (byteLength) => cuda.malloc!(byteLength),
      memcpyHtoD: (ptr, bytes) => cuda.memcpyHtoD!(ptr, bytes),
      read: (ptr) => cuda.memcpyDtoH!(ptr),
    },
  };
}

