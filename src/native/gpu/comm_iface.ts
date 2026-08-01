export type Communicator = {
  worldSize: number;
  rank: number;
  /** All-reduce SUM over Float32 buffers (SIM first). */
  allReduceSumF32(values: Float32Array): Promise<Float32Array>;
  /** Broadcast from root rank to all ranks. */
  broadcastF32(values: Float32Array | null, root: number): Promise<Float32Array>;
};

