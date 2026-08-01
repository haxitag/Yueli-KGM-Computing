export type CudaDevicePtr = { id: string };

export type CudaSimAllocation = {
  ptr: CudaDevicePtr;
  byteLength: number;
  bytes: Uint8Array;
};

/**
 * CUDA 仿真层（用于 CI/无 GPU 环境）：
 * - malloc：返回 device ptr
 * - memcpyHtoD：把 host bytes 复制到 device bytes
 *
 * 真实 CUDA 版本只需实现同样的接口（CUDA malloc + cudaMemcpy），即可无缝替换。
 */
export class CudaSimApi {
  private nextId = 0;
  private allocations = new Map<string, CudaSimAllocation>();

  malloc(byteLength: number): CudaDevicePtr {
    const len = Math.max(0, Math.trunc(byteLength));
    const id = `dev_${this.nextId++}`;
    const ptr = { id };
    this.allocations.set(id, { ptr, byteLength: len, bytes: new Uint8Array(len) });
    return ptr;
  }

  memcpyHtoD(ptr: CudaDevicePtr, hostBytes: Uint8Array): void {
    const alloc = this.allocations.get(ptr.id);
    if (!alloc) {
      throw new Error(`cuda_sim_invalid_ptr:${ptr.id}`);
    }
    if (hostBytes.byteLength !== alloc.byteLength) {
      throw new Error(`cuda_sim_memcpy_size_mismatch:${hostBytes.byteLength}:${alloc.byteLength}`);
    }
    alloc.bytes.set(hostBytes);
  }

  /** 测试/验证用途：读取 device bytes */
  read(ptr: CudaDevicePtr): Uint8Array {
    const alloc = this.allocations.get(ptr.id);
    if (!alloc) {
      throw new Error(`cuda_sim_invalid_ptr:${ptr.id}`);
    }
    return new Uint8Array(alloc.bytes);
  }
}

