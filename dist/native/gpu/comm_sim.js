function ensureRendezvous(obj) {
    return obj ?? { allreduce: new Map(), broadcast: new Map() };
}
export function createSimCommunicator(params) {
    const rv = ensureRendezvous(params.rendezvous);
    const prefix = params.groupId;
    const comm = {
        worldSize: params.worldSize,
        rank: params.rank,
        async allReduceSumF32(values) {
            const key = `${prefix}:allreduce:${values.length}`;
            const entry = rv.allreduce.get(key) ?? { buffers: new Map(), waiters: [] };
            rv.allreduce.set(key, entry);
            entry.buffers.set(params.rank, values);
            if (entry.buffers.size === params.worldSize) {
                const out = new Float32Array(values.length);
                for (const buf of entry.buffers.values()) {
                    if (buf.length !== out.length) {
                        throw new Error("native_gpu_comm_allreduce_shape_mismatch");
                    }
                    for (let i = 0; i < out.length; i += 1) {
                        out[i] += buf[i];
                    }
                }
                for (const w of entry.waiters) {
                    w(out);
                }
                rv.allreduce.delete(key);
                return out;
            }
            return await new Promise((resolve) => {
                entry.waiters.push(resolve);
            });
        },
        async broadcastF32(values, root) {
            const key = `${prefix}:broadcast:${root}`;
            const entry = rv.broadcast.get(key) ?? {
                root: undefined,
                waiters: [],
                received: new Set(),
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
            return await new Promise((resolve) => entry.waiters.push(resolve));
        },
    };
    return { comm, rendezvous: rv };
}
