import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

import { NativeRuntimeEngine } from "../native/engine.js";

type CliArgs = {
  modelPath: string;
  prompt: string;
  maxTokens: number;
  llamaBin: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelPath = path.resolve(args.modelPath);

  const engine = new NativeRuntimeEngine(modelPath, {
    servingBackend: "js-reference",
    kvCacheMode: "paged",
    kvPageSize: 16,
    seed: 1,
  });
  const native = await engine.complete(args.prompt, {
    model: path.basename(modelPath),
    maxTokens: args.maxTokens,
    temperature: 0,
    topK: 1,
    topP: 1,
    repetitionPenalty: 1,
  });
  const llama = await runLlamaCppGreedy(args.llamaBin, modelPath, args.prompt, args.maxTokens);

  const normalizedNative = native.text.trim();
  const normalizedLlama = llama.trim();

  console.log(JSON.stringify({
    modelPath,
    prompt: args.prompt,
    maxTokens: args.maxTokens,
    native: normalizedNative,
    llamaCpp: normalizedLlama,
    match: normalizedNative === normalizedLlama,
  }, null, 2));

  assert.equal(normalizedNative, normalizedLlama);
}

function parseArgs(argv: string[]): CliArgs {
  let modelPath = "";
  let prompt = "";
  let maxTokens = 16;
  let llamaBin = process.env.LLAMA_CPP_BIN?.trim() ?? "";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--model" && argv[index + 1]) {
      modelPath = argv[++index]!;
      continue;
    }
    if (value === "--prompt" && argv[index + 1]) {
      prompt = argv[++index]!;
      continue;
    }
    if (value === "--max-tokens" && argv[index + 1]) {
      maxTokens = Math.max(1, Number(argv[++index] ?? 16));
      continue;
    }
    if (value === "--llama-bin" && argv[index + 1]) {
      llamaBin = argv[++index]!;
      continue;
    }
  }

  if (!modelPath) {
    throw new Error("usage: tsx src/demo/gguf_llama_cpp_cross_validate.ts --model /path/to/model.gguf [--prompt text] [--max-tokens 16] [--llama-bin llama-cli]");
  }
  if (!llamaBin) {
    throw new Error("llama_cpp_bin_required: pass --llama-bin or set LLAMA_CPP_BIN");
  }

  return {
    modelPath,
    prompt,
    maxTokens,
    llamaBin,
  };
}

async function runLlamaCppGreedy(
  llamaBin: string,
  modelPath: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const args = [
    "-m",
    modelPath,
    "-p",
    prompt,
    "-n",
    String(maxTokens),
    "--temp",
    "0",
    "--top-k",
    "1",
    "--top-p",
    "1",
    "--repeat-penalty",
    "1",
    "--no-display-prompt",
    "--simple-io",
  ];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(llamaBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`llama_cpp_cross_validate_failed:${code}:${stderr.trim() || "unknown_error"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
