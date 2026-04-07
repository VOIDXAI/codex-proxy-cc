import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

import { AppError } from "../shared/errors.mjs";
import { resolveBinaryOnPath } from "../shared/resolve-binary.mjs";

const DEFAULT_CLIENT_INFO = {
  name: "codex-proxy-cc",
  title: "Codex Proxy CC",
  version: "0.1.0",
};

const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "command/exec/outputDelta",
    "item/fileChange/outputDelta",
    "item/reasoning/textDelta",
  ],
};

function buildJsonRpcError(code, message) {
  return { code, message };
}

function createProtocolError(message, data) {
  const error = new AppError(message, {
    status: 502,
    type: "api_error",
    details: data,
  });
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

export function findCodexBinary(binaryName, env = process.env) {
  if (!binaryName) {
    throw new AppError("Codex binary is not configured");
  }

  const resolved = resolveBinaryOnPath(binaryName, { env });
  if (!resolved) {
    throw new AppError(`Could not find Codex binary '${binaryName}' on PATH`, {
      status: 500,
      type: "not_found_error",
    });
  }
  return resolved;
}

export function getCodexLoginStatus(binaryName, cwd = process.cwd(), env = process.env) {
  const binary = findCodexBinary(binaryName, env);
  const result = spawnSync(binary, ["login", "status"], {
    cwd,
    encoding: "utf8",
    env,
  });

  return {
    available: true,
    loggedIn: result.status === 0,
    detail: (result.stdout || result.stderr || "").trim() || "unknown",
  };
}

function isClosedStdinError(error) {
  return (
    error?.code === "ERR_STREAM_WRITE_AFTER_END" ||
    error?.code === "EPIPE"
  );
}

export class SpawnedCodexAppServerClient {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    this.exitError = null;
    this.exitResolved = false;
    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  async initialize() {
    const binary = findCodexBinary(this.options.command || "codex", this.options.env);
    this.proc = spawn(binary, ["app-server"], {
      cwd: this.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdin.on("error", error => {
      if (this.closed && isClosedStdinError(error)) {
        return;
      }
      this.handleExit(
        createProtocolError("codex app-server stdin failed", {
          error: error instanceof Error ? error.message : String(error),
          code: error?.code,
        }),
      );
    });
    this.proc.stderr.on("data", chunk => {
      this.stderr += chunk;
    });
    this.proc.on("error", error => {
      this.handleExit(error);
    });
    this.proc.on("exit", (code, signal) => {
      if (code === 0) {
        this.handleExit(null);
        return;
      }
      this.handleExit(
        createProtocolError(
          `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`})`,
        ),
      );
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", line => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo || DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities || DEFAULT_CAPABILITIES,
    });
    this.notify("initialized", {});
  }

  request(method, params) {
    if (this.closed) {
      throw new AppError("codex app-server client is closed", {
        status: 500,
        type: "api_error",
      });
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(
        createProtocolError("Failed to parse codex app-server JSONL", {
          line,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          createProtocolError(
            message.error.message || `codex app-server ${pending.method} failed`,
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }
    this.exitResolved = true;
    this.exitError = error;

    for (const pending of this.pending.values()) {
      pending.reject(error || new AppError("codex app-server connection closed"));
    }
    this.pending.clear();
    this.resolveExit();
  }

  async handleServerRequest(message) {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`),
      }, { ignoreIfClosed: true });
      return;
    }

    try {
      const result = await handler(message);
      this.sendMessage({
        id: message.id,
        result: result ?? {},
      }, { ignoreIfClosed: true });
    } catch (error) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(
          -32000,
          error instanceof Error ? error.message : String(error),
        ),
      }, { ignoreIfClosed: true });
    }
  }

  sendMessage(message, options = {}) {
    const { ignoreIfClosed = false } = options;
    const stdin = this.proc?.stdin;
    if (!stdin || this.closed || stdin.destroyed || stdin.writableEnded) {
      if (ignoreIfClosed) {
        return false;
      }
      throw new AppError("codex app-server stdin is not available", {
        status: 500,
        type: "api_error",
      });
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      if (ignoreIfClosed && isClosedStdinError(error)) {
        return false;
      }
      throw error;
    }
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && typeof this.proc.kill === "function") {
          this.proc.kill("SIGTERM");
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }
}

export async function connectCodexAppServer(cwd, options = {}) {
  const client = new SpawnedCodexAppServerClient(cwd, options);
  await client.initialize();
  return client;
}
