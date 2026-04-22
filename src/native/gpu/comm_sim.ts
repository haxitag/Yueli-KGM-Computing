import type { Communicator } from "./comm_iface.js";

type AllReduceEntry = {
  buffers: Map<number, Float32Array>;
  waiters: Array<(out: Float32Array) => void>;
};

type BroadcastEntry = {
  root?: Float32Array;
  waiters: Array<(out: Float32Array) => void>;
  received: Set<number>;
};

type Rendezvous = {
  allreduce: Map<string, AllReduceEntry>;
  broadcast: Map<string, BroadcastEntry>;
};

function ensureRendezvous(obj?: Rendezvous): Rendezvous {
  return obj ?? { allreduce: new Map(), broadcast: new Map() };
}

export function createSimCommunicator(params: {
  worldSize: number;
  rank: number;
  groupId: string;
  rendezvous?: Rendezvous;
}): { comm: Communicator; rendezvous: Rendezvous } {
  const rv = ensureRendezvous(params.rendezvous);
  const prefix = params.groupId;

  const comm: Communicator = {
    worldSize: params.worldSize,
    rank: params.rank,

    async allReduceSumF32(values: Float32Array): Promise<Float32Array> {
      const key = `${prefix}:allreduce:${values.length}`;
      const entry = rv.allreduce.get(key) ?? { buffers: new Map(), waiters: [] as Array<(out: Float32Array) => void> };
      rv.allreduce.set(key, entry);
      entry.buffers.set(params.rank, values);

      if (entry.buffers.size === params.worldSize) {
        const out = new Float32Array(values.length);
        for (const buf of entry.buffers.values()) {
          if (buf.length !== out.length) {
            throw new Error("native_gpu_comm_allreduce_shape_mismatch");
          }
          for (let i = 0; i < out.length; i += 1) {
            out[i] += buf[i]!;
          }
        }
        for (const w of entry.waiters) {
          w(out);
        }
        rv.allreduce.delete(key);
        return out;
      }

      return await new Promise<Float32Array>((resolve) => {
        entry.waiters.push(resolve);
      });
    },

    async broadcastF32(values: Float32Array | null, root: number): Promise<Float32Array> {
      const key = `${prefix}:broadcast:${root}`;
      const entry = rv.broadcast.get(key) ?? {
        root: undefined,
        waiters: [] as Array<(out: Float32Array) => void>,
        received: new Set<number>(),
      };
      rv.broadcast.set(key, entry);

      if (params.rank === root) {
        if (!values) {
          throw new Error("native_gpu_comm_broadcast_root_requires_values");
        }
        entry.root = values;
      }

      if (entry.root) {
        for (const w of entry.waiters) {
          w(entry.root);
        }
        entry.waiters.length = 0;
        entry.received.add(params.rank);
        if (entry.received.size >= params.worldSize) {
          rv.broadcast.delete(key);
        }
        return entry.root;
      }
      return await new Promise<Float32Array>((resolve) => entry.waiters.push(resolve));
    },
  };

  return { comm, rendezvous: rv };
}

