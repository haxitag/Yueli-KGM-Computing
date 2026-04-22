import { existsSync } from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export function createDefaultSandboxAdapters() {
    return {
        computer: new CommandSandboxAdapter({
            kind: "computer",
            label: "VM Runtime Adapter",
            startEnv: "KGM_SANDBOX_COMPUTER_START_CMD",
            stopEnv: "KGM_SANDBOX_COMPUTER_STOP_CMD",
            statusEnv: "KGM_SANDBOX_COMPUTER_STATUS_CMD",
            endpointEnv: "KGM_SANDBOX_COMPUTER_ENDPOINT",
            embeddedFlagEnv: "KGM_SANDBOX_COMPUTER_USE_EMBEDDED",
            embeddedRunner: "bash",
            embeddedScript: "qemu-vm-adapter.sh",
            hint: "Wire this to QEMU, Firecracker, or another VM runtime command. Set KGM_SANDBOX_COMPUTER_USE_EMBEDDED=1 to use the bundled QEMU adapter.",
            note: "If commands are configured, the sandbox manager will start and stop a real VM-side process.",
        }),
        browser: new CommandSandboxAdapter({
            kind: "browser",
            label: "Playwright Adapter",
            startEnv: "KGM_SANDBOX_BROWSER_START_CMD",
            stopEnv: "KGM_SANDBOX_BROWSER_STOP_CMD",
            statusEnv: "KGM_SANDBOX_BROWSER_STATUS_CMD",
            endpointEnv: "KGM_SANDBOX_BROWSER_WS_ENDPOINT",
            embeddedFlagEnv: "KGM_SANDBOX_BROWSER_USE_EMBEDDED",
            embeddedRunner: "node",
            embeddedScript: "playwright-browser-adapter.mjs",
            hint: "Wire this to a Playwright worker, browser pool, or browser WebSocket endpoint. Set KGM_SANDBOX_BROWSER_USE_EMBEDDED=1 to use the bundled Playwright adapter.",
            note: "Recommended: point start command at a Playwright adapter process or provide a WS endpoint.",
        }),
        mobile: new CommandSandboxAdapter({
            kind: "mobile",
            label: "Android Emulator Adapter",
            startEnv: "KGM_SANDBOX_MOBILE_START_CMD",
            stopEnv: "KGM_SANDBOX_MOBILE_STOP_CMD",
            statusEnv: "KGM_SANDBOX_MOBILE_STATUS_CMD",
            endpointEnv: "KGM_SANDBOX_MOBILE_ENDPOINT",
            embeddedFlagEnv: "KGM_SANDBOX_MOBILE_USE_EMBEDDED",
            embeddedRunner: "bash",
            embeddedScript: "android-emulator-adapter.sh",
            hint: "Wire this to Android Emulator, ADB-managed devices, or another mobile simulator. Set KGM_SANDBOX_MOBILE_USE_EMBEDDED=1 to use the bundled emulator adapter.",
            note: "Recommended: use emulator start/stop commands or an adapter service that fronts the device runtime.",
        }),
    };
}
class CommandSandboxAdapter {
    kind;
    label;
    startEnv;
    stopEnv;
    statusEnv;
    endpointEnv;
    embeddedFlagEnv;
    embeddedRunner;
    embeddedScript;
    hint;
    note;
    processes = new Map();
    constructor(params) {
        this.kind = params.kind;
        this.label = params.label;
        this.startEnv = params.startEnv;
        this.stopEnv = params.stopEnv;
        this.statusEnv = params.statusEnv;
        this.endpointEnv = params.endpointEnv;
        this.embeddedFlagEnv = params.embeddedFlagEnv;
        this.embeddedRunner = params.embeddedRunner;
        this.embeddedScript = params.embeddedScript;
        this.hint = params.hint;
        this.note = params.note;
    }
    isConfigured() {
        return Boolean(this.resolveCommand("start") || process.env[this.endpointEnv]);
    }
    adapterHint() {
        return this.hint;
    }
    notes() {
        return [this.note];
    }
    start(instance) {
        const endpoint = process.env[this.endpointEnv];
        if (endpoint) {
            return;
        }
        const command = this.resolveCommand("start");
        if (!command) {
            return;
        }
        if (this.isRunning(instance)) {
            return;
        }
        const child = spawn(command, {
            shell: true,
            detached: true,
            stdio: "ignore",
            env: {
                ...process.env,
                KGM_SANDBOX_ID: instance.id,
            },
        });
        child.unref();
        this.processes.set(instance.id, child.pid ?? 0);
    }
    stop(instance) {
        const stopCommand = this.resolveCommand("stop");
        if (stopCommand) {
            execSync(stopCommand, {
                stdio: "ignore",
                env: {
                    ...process.env,
                    KGM_SANDBOX_ID: instance.id,
                    KGM_SANDBOX_PID: String(this.processes.get(instance.id) ?? ""),
                },
            });
            this.processes.delete(instance.id);
            return;
        }
        const pid = this.processes.get(instance.id);
        if (!pid) {
            return;
        }
        try {
            process.kill(pid);
        }
        catch {
            // ignore
        }
        this.processes.delete(instance.id);
    }
    isRunning(instance) {
        const endpoint = process.env[this.endpointEnv];
        if (endpoint) {
            return true;
        }
        const statusCommand = this.resolveCommand("status");
        if (statusCommand) {
            try {
                execSync(statusCommand, {
                    stdio: "ignore",
                    env: {
                        ...process.env,
                        KGM_SANDBOX_ID: instance.id,
                        KGM_SANDBOX_PID: String(this.processes.get(instance.id) ?? ""),
                    },
                });
                return true;
            }
            catch {
                return false;
            }
        }
        const pid = this.processes.get(instance.id);
        if (!pid) {
            return false;
        }
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    preview(instance) {
        const endpoint = process.env[this.endpointEnv];
        if (endpoint) {
            return {
                detail: `${this.label} attached via ${endpoint}`,
            };
        }
        const pid = this.processes.get(instance.id);
        const embedded = this.usingEmbeddedAdapter();
        return {
            detail: pid
                ? `${this.label} process pid=${pid}`
                : embedded
                    ? `${this.label} configured via bundled adapter`
                    : `${this.label} configured`,
        };
    }
    resolveCommand(commandType) {
        const envName = commandType === "start" ? this.startEnv : commandType === "stop" ? this.stopEnv : this.statusEnv;
        const explicit = process.env[envName];
        if (explicit) {
            return explicit;
        }
        if (!this.usingEmbeddedAdapter()) {
            return undefined;
        }
        const scriptPath = path.resolve(SANDBOX_SCRIPT_DIR, this.embeddedScript);
        if (!existsSync(scriptPath)) {
            return undefined;
        }
        return `${this.embeddedRunner} "${scriptPath}" ${commandType}`;
    }
    usingEmbeddedAdapter() {
        return parseBoolEnv(this.embeddedFlagEnv);
    }
}
const SANDBOX_SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/sandbox");
function parseBoolEnv(name) {
    const value = process.env[name];
    if (!value) {
        return false;
    }
    return value === "1" || value.toLowerCase() === "true";
}
