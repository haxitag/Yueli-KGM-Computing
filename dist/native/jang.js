import fs from "node:fs";
import path from "node:path";
const JANG_CONFIG_FILENAMES = ["jang_config.json", "jang_config.yaml"];
function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function pickProfile(data) {
    const candidates = [
        data.profile,
        data.jang_profile,
        data.quantization_profile,
        data.name,
        data.format,
        data.jang,
    ];
    for (const c of candidates) {
        if (typeof c === "string" && /JANG/i.test(c)) {
            return c.trim();
        }
    }
    const nested = data.quantization;
    if (nested && typeof nested === "object" && nested !== null) {
        const q = nested;
        for (const key of ["profile", "scheme", "type"]) {
            const v = q[key];
            if (typeof v === "string" && /JANG/i.test(v)) {
                return v.trim();
            }
        }
    }
    return undefined;
}
function pickVersion(data) {
    const v = data.version ?? data.schema_version ?? data.jang_version;
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}
function readAverageBits(data) {
    const keys = [
        data.average_bits,
        data.avg_bits,
        data.mean_bits,
        data.bits_average,
        data.target_average_bit,
    ];
    for (const k of keys) {
        if (typeof k === "number" && Number.isFinite(k)) {
            return k;
        }
        if (typeof k === "string") {
            const n = Number(k);
            if (Number.isFinite(n)) {
                return n;
            }
        }
    }
    const q = data.quantization;
    if (q && typeof q === "object" && q !== null) {
        const qo = q;
        return readAverageBits(qo);
    }
    return undefined;
}
function normalizeTier(value) {
    if (typeof value !== "string") {
        return "unknown";
    }
    const u = value.trim().toUpperCase();
    if (u.includes("CRITICAL") || u === "C" || u === "HIGH" || u === "KEY") {
        return "critical";
    }
    if (u.includes("COMPRESS") || u === "LOW" || u === "M" || u === "COARSE") {
        return "compress";
    }
    return "unknown";
}
function readBits(obj) {
    const keys = ["bits", "bitwidth", "bit_width", "w_bits", "n_bit", "weight_bits", "effective_bits"];
    for (const key of keys) {
        const v = obj[key];
        if (typeof v === "number" && Number.isFinite(v)) {
            return v;
        }
        if (typeof v === "string") {
            const n = Number(v);
            if (Number.isFinite(n)) {
                return n;
            }
        }
    }
    return undefined;
}
function pushEntry(entries, tier, id, obj) {
    const tierFromObj = obj.tier ?? obj.role ?? obj.kind ?? obj.class ?? obj.category;
    const resolved = tierFromObj !== undefined ? normalizeTier(tierFromObj) : tier;
    const bits = readBits(obj);
    entries.push({
        id,
        tier: resolved === "unknown" ? tier : resolved,
        bits,
    });
}
/**
 * Parse `jang_config.json` (or embedded `quantization`) into CRITICAL/COMPRESS-style layer plan.
 * Accepts several community shapes: `layers{}`, `CRITICAL`/`COMPRESS` arrays, `layer_allocation`, etc.
 */
export function parseJangConfig(data) {
    const entries = [];
    const ingestLayersObject = (layers, defaultTier) => {
        for (const [key, value] of Object.entries(layers)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                pushEntry(entries, defaultTier, key, value);
            }
        }
    };
    const layers = data.layers;
    if (layers && typeof layers === "object" && !Array.isArray(layers)) {
        ingestLayersObject(layers, "unknown");
    }
    const nested = data.quantization;
    if (nested && typeof nested === "object" && nested !== null) {
        const q = nested;
        if (q.layers && typeof q.layers === "object" && !Array.isArray(q.layers)) {
            ingestLayersObject(q.layers, "unknown");
        }
    }
    const allocation = data.layer_allocation ?? data.allocation ?? data.per_layer;
    if (allocation && typeof allocation === "object" && !Array.isArray(allocation)) {
        ingestLayersObject(allocation, "unknown");
    }
    for (const tierKey of ["CRITICAL", "critical", "Critical"]) {
        const block = data[tierKey];
        if (Array.isArray(block)) {
            for (const item of block) {
                if (typeof item === "string") {
                    entries.push({ id: item, tier: "critical" });
                }
                else if (item && typeof item === "object") {
                    pushEntry(entries, "critical", typeof item.name === "string"
                        ? item.name
                        : undefined, item);
                }
            }
        }
    }
    for (const tierKey of ["COMPRESS", "compress", "Compress"]) {
        const block = data[tierKey];
        if (Array.isArray(block)) {
            for (const item of block) {
                if (typeof item === "string") {
                    entries.push({ id: item, tier: "compress" });
                }
                else if (item && typeof item === "object") {
                    pushEntry(entries, "compress", typeof item.name === "string"
                        ? item.name
                        : undefined, item);
                }
            }
        }
    }
    let criticalCount = 0;
    let compressCount = 0;
    let unknownCount = 0;
    for (const e of entries) {
        if (e.tier === "critical") {
            criticalCount += 1;
        }
        else if (e.tier === "compress") {
            compressCount += 1;
        }
        else {
            unknownCount += 1;
        }
    }
    const averageBits = readAverageBits(data);
    return {
        entries,
        criticalCount,
        compressCount,
        unknownCount,
        averageBits,
        hasLayerDetail: entries.length > 0,
    };
}
/**
 * Detect JANG from standalone jang_config.json / jang_config.yaml beside weights,
 * or from keys inside config.json (HF-style repos).
 */
export function detectJangInModelDirectory(modelDir) {
    for (const name of JANG_CONFIG_FILENAMES) {
        const configPath = path.join(modelDir, name);
        if (!name.endsWith(".json")) {
            continue;
        }
        const data = readJsonIfExists(configPath);
        if (data && Object.keys(data).length > 0) {
            const profile = pickProfile(data);
            const looksJang = Boolean(profile)
                || /JANG_|jang|adaptive.*n-bit|n-bit.*grad/i.test(JSON.stringify(data));
            if (looksJang || name.startsWith("jang_config")) {
                const layerPlan = parseJangConfig(data);
                return buildMetadata(profile ?? "JANG", pickVersion(data), configPath, layerPlan);
            }
        }
    }
    const configPath = path.join(modelDir, "config.json");
    const config = readJsonIfExists(configPath);
    if (config) {
        const profile = pickProfile(config);
        if (profile) {
            const layerPlan = parseJangConfig(config);
            return buildMetadata(profile, pickVersion(config), configPath, layerPlan);
        }
        const q = config.quantization;
        if (q && typeof q === "object" && q !== null) {
            const qo = q;
            const nestedProfile = pickProfile(qo);
            if (nestedProfile) {
                const layerPlan = parseJangConfig({ ...qo, profile: nestedProfile });
                return buildMetadata(nestedProfile, pickVersion(qo), configPath, layerPlan);
            }
        }
    }
    return undefined;
}
function buildMetadata(profile, version, configPath, layerPlan) {
    const layerSummary = layerPlan.hasLayerDetail
        ? `layers: ${layerPlan.criticalCount} critical, ${layerPlan.compressCount} compress, ${layerPlan.unknownCount} other`
        : undefined;
    const avgSummary = typeof layerPlan.averageBits === "number"
        ? `avg ~${layerPlan.averageBits.toFixed(2)} bit`
        : undefined;
    const summary = [
        `JANG (Jang Adaptive N-bit Grading) — profile ${profile}`,
        version ? `schema/version ${version}` : undefined,
        avgSummary,
        layerSummary,
        "MLX-native mixed precision; requires MLX execution path (not CPU reference kernels).",
    ]
        .filter(Boolean)
        .join(". ");
    return {
        profile,
        version,
        configPath,
        executionTarget: "mlx-native",
        layerPlan: layerPlan.hasLayerDetail || typeof layerPlan.averageBits === "number" ? layerPlan : undefined,
        summary,
    };
}
