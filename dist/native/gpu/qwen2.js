function assertPositiveInt(value, label) {
    const v = Math.trunc(value);
    if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`native_gpu_invalid_config_${label}:${value}`);
    }
    return v;
}
export function buildQwen2SafetensorsAliases(params) {
    const cfg = params.config;
    const vocab = assertPositiveInt(cfg.vocabSize, "vocabSize");
    const hidden = assertPositiveInt(cfg.hiddenSize, "hiddenSize");
    const intermediate = assertPositiveInt(cfg.intermediateSize, "intermediateSize");
    const layers = Math.max(0, Math.trunc(cfg.numLayers));
    const aliases = [
        { target: "token_embedding.weight", source: "model.embed_tokens.weight", shape: [vocab, hidden] },
        { target: "output_norm.weight", source: "model.norm.weight", shape: [hidden] },
        {
            target: "lm_head.weight",
            source: params.tieWordEmbeddings ? "model.embed_tokens.weight" : "lm_head.weight",
            shape: [vocab, hidden],
        },
    ];
    for (let index = 0; index < layers; index += 1) {
        aliases.push({ target: `layers.${index}.attn_norm.weight`, source: `model.layers.${index}.input_layernorm.weight`, shape: [hidden] }, { target: `layers.${index}.ffn_norm.weight`, source: `model.layers.${index}.post_attention_layernorm.weight`, shape: [hidden] }, { target: `layers.${index}.attention.wq.weight`, source: `model.layers.${index}.self_attn.q_proj.weight`, shape: [hidden, hidden] }, { target: `layers.${index}.attention.wk.weight`, source: `model.layers.${index}.self_attn.k_proj.weight`, shape: [hidden, hidden] }, { target: `layers.${index}.attention.wv.weight`, source: `model.layers.${index}.self_attn.v_proj.weight`, shape: [hidden, hidden] }, { target: `layers.${index}.attention.wo.weight`, source: `model.layers.${index}.self_attn.o_proj.weight`, shape: [hidden, hidden] }, { target: `layers.${index}.feed_forward.w1.weight`, source: `model.layers.${index}.mlp.gate_proj.weight`, shape: [intermediate, hidden] }, { target: `layers.${index}.feed_forward.w2.weight`, source: `model.layers.${index}.mlp.down_proj.weight`, shape: [hidden, intermediate] }, { target: `layers.${index}.feed_forward.w3.weight`, source: `model.layers.${index}.mlp.up_proj.weight`, shape: [intermediate, hidden] });
    }
    return aliases;
}
