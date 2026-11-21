const { spawn } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18756;
const DEFAULT_SAG_BASE_URL = "http://127.0.0.1:24681/v1";
const DEFAULT_SAG_PORT = 24681;
const READY_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 120;
const HEALTH_PROBE_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 240000;
const CRASH_WINDOW_MS = 30000;
const MAX_CRASHES_IN_WINDOW = 3;

const operations = new Set([
  "status", "workspace", "search", "search-notes", "ask", "topic", "topic-book", "note", "edit-note", "suggest", "link",
]);

const CONFIG_ENV_KEYS = new Set([
  "KOODO_MODEL_BASE_URL",
  "KOODO_MODEL_NAME",
  "KOODO_MODEL_API_KEY",
  "KOODO_SAG_BASE_URL",
  "KOODO_SAG_API_KEY",
  "KOODO_SAG_PATHS",
  "KOODO_SAG_AUTO_START",
  "KOODO_SAG_BIN",
  "KOODO_BRAVE_API_KEY",
  "KOODO_TAVILY_API_KEY",
  "KOODO_RERANKER_MODEL_DIR",
  "KOODO_RESEARCH_PYTHON",
  "KOODO_RESEARCH_PORT",
  "KOODO_RESEARCH_AUTO_START",
]);

function isFlagDisabled(value) {
  if (typeof value === "boolean") return !value;
  if (typeof value !== "string") return false;
  return /^(0|false|no|off)$/i.test(value.trim());
}

function parsePort(value, fallback) {
  const num = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : fallback;
}

function getDataDir(env = process.env) {
  return env.KOODO_RESEARCH_DATA_DIR?.trim() || path.join(os.homedir(), ".koodo-research");
}

function isExistingFile(filePath, fsSyncImpl = fsSync) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    return fsSyncImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function loadResearchEnv(dataDir, baseEnv = process.env, fsSyncImpl = fsSync, logger = console) {
  const merged = { ...baseEnv };
  const configPath = path.join(dataDir, "config.json");
  if (!isExistingFile(configPath, fsSyncImpl)) {
    return merged;
  }
  try {
    const raw = fsSyncImpl.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return merged;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!CONFIG_ENV_KEYS.has(key)) continue;
      if (merged[key] !== undefined && String(merged[key]).trim() !== "") continue;
      if (Array.isArray(value) && key === "KOODO_SAG_PATHS") {
        const joined = value
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim())
          .join(path.delimiter);
        if (joined) merged[key] = joined;
      } else if (typeof value === "boolean") {
        merged[key] = value ? "1" : "0";
      } else if (typeof value === "number" && Number.isFinite(value)) {
        merged[key] = String(value);
      } else if (typeof value === "string" && value.trim()) {
        merged[key] = value.trim();
      }
    }
  } catch {
    logger.warn("[research-agent] Failed to parse optional research config file.");
  }
  return merged;
}

function resolveProjectRoot(fsSyncImpl = fsSync) {
  const candidates = [path.resolve(__dirname, "../../..")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(process.resourcesPath);
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked"));
  }
  for (const candidate of candidates) {
    if (isExistingFile(path.join(candidate, "research_agent", "__main__.py"), fsSyncImpl)) {
      return candidate;
    }
  }
  return candidates[0];
}

function resolvePythonCommand(projectRoot, env = process.env, platform = process.platform, fsSyncImpl = fsSync) {
  const explicit = env.KOODO_RESEARCH_PYTHON?.trim();
  if (explicit && isExistingFile(explicit, fsSyncImpl)) {
    return explicit;
  }
  const venvCandidates = platform === "win32"
    ? [path.join(projectRoot, ".venv", "Scripts", "python.exe")]
    : [
        path.join(projectRoot, ".venv", "bin", "python"),
        path.join(projectRoot, ".venv", "bin", "python3"),
      ];
  for (const candidate of venvCandidates) {
    if (isExistingFile(candidate, fsSyncImpl)) {
      return candidate;
    }
  }
  return platform === "win32" ? "python.exe" : "python3";
}

function resolveSagCommand(env = process.env, platform = process.platform, fsSyncImpl = fsSync) {
  const explicit = env.KOODO_SAG_BIN?.trim();
  if (explicit && isExistingFile(explicit, fsSyncImpl)) {
    return explicit;
  }
  const pathDirs = (env.PATH || env.Path || "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (platform === "win32" && env.APPDATA) {
    pathDirs.push(path.join(env.APPDATA, "npm"));
  }
  const names = platform === "win32" ? ["sag.cmd", "sag.exe"] : ["sag"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExistingFile(candidate, fsSyncImpl)) {
        return candidate;
      }
    }
  }
  return null;
}

function parseSagAutoStartConfig(env = process.env) {
  const apiKey = env.KOODO_SAG_API_KEY?.trim();
  if (!apiKey || isFlagDisabled(env.KOODO_SAG_AUTO_START)) {
    return null;
  }
  const baseUrl = env.KOODO_SAG_BASE_URL?.trim() || DEFAULT_SAG_BASE_URL;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:") return null;
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    const port = parsePort(parsed.port, DEFAULT_SAG_PORT);
    return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, port };
  } catch {
    return null;
  }
}

function checkPortFree(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

function allocateEphemeralPort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Could not allocate an ephemeral port"));
      });
    });
  });
}

async function pickAvailablePort(preferredPort) {
  if (await checkPortFree(preferredPort)) {
    return preferredPort;
  }
  return allocateEphemeralPort();
}

function isTcpListening(port, host = DEFAULT_HOST, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function readValidToken(dataDir, fsPromisesImpl = fs) {
  try {
    const token = (await fsPromisesImpl.readFile(path.join(dataDir, "token"), "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function probeResearchHealth(port, dataDir, fetchImpl = fetch, fsPromisesImpl = fs) {
  const token = await readValidToken(dataDir, fsPromisesImpl);
  if (!token) return false;
  try {
    const response = await fetchImpl(`http://${DEFAULT_HOST}:${port}/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.ok) return true;
    if (response.status === 404 || response.status === 405) {
      const fallback = await fetchImpl(`http://${DEFAULT_HOST}:${port}/status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        redirect: "error",
        body: "{}",
      });
      return fallback.ok;
    }
    return false;
  } catch {
    return false;
  }
}

function attachProcessLogs(child, tag, logger) {
  const forward = (stream, level) => {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          logger[level](`[${tag}] ${line}`);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  };
  forward(child.stdout, "info");
  forward(child.stderr, "warn");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnSagProcess(sagBin, port, spawnImpl, platform, env) {
  const args = ["api", "start", "--host", DEFAULT_HOST, "--port", String(port)];
  if (platform === "win32" && /\.(cmd|bat)$/i.test(sagBin)) {
    if (/[&|<>^%!"\r\n]/.test(sagBin)) {
      return null;
    }
    const comspec = env.ComSpec || "cmd.exe";
    const commandLine = `"\"${sagBin}\" ${args.join(" ")}"`;
    return spawnImpl(comspec, ["/d", "/s", "/c", commandLine], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  }
  return spawnImpl(sagBin, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

function terminateProcessTree(child, platform, spawnImpl) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      const killer = spawnImpl("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on?.("error", () => {
        try { child.kill(); } catch {}
      });
      killer.unref?.();
      return;
    } catch {
      // Fallback below
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

function createResearchServiceManager(overrides = {}) {
  const spawnImpl = overrides.spawn || spawn;
  const fetchImpl = overrides.fetch || fetch;
  const fsSyncImpl = overrides.fsSync || fsSync;
  const fsPromisesImpl = overrides.fsPromises || fs;
  const platform = overrides.platform || process.platform;
  const logger = overrides.logger || console;
  const getEnv = overrides.getEnv || (() => process.env);
  const projectRootResolver = overrides.resolveProjectRoot || (() => resolveProjectRoot(fsSyncImpl));
  const portPicker = overrides.pickAvailablePort || pickAvailablePort;
  const tcpChecker = overrides.isTcpListening || isTcpListening;
  const healthProber = overrides.probeResearchHealth || ((port, dataDir) => probeResearchHealth(port, dataDir, fetchImpl, fsPromisesImpl));
  const readyTimeoutMs = overrides.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = overrides.pollIntervalMs ?? POLL_INTERVAL_MS;

  let child = null;
  let sagChild = null;
  let activePort = null;
  let isExternal = false;
  let startupPromise = null;
  let sagStartupPromise = null;
  let shuttingDown = false;
  let crashTimestamps = [];

  async function ensureSagServiceStarted(env) {
    if (shuttingDown) return false;
    if (sagChild && sagChild.exitCode === null) return true;
    if (sagStartupPromise) return sagStartupPromise;

    const sagConfig = parseSagAutoStartConfig(env);
    if (!sagConfig) return false;

    sagStartupPromise = (async () => {
      if (await tcpChecker(sagConfig.port)) {
        return true;
      }
      const sagBin = resolveSagCommand(env, platform, fsSyncImpl);
      if (!sagBin) {
        return false;
      }
      let spawned = null;
      try {
        spawned = spawnSagProcess(sagBin, sagConfig.port, spawnImpl, platform, env);
      } catch (error) {
        logger.warn(`[sag-api] Failed to spawn SAG CLI: ${error.message}`);
        return false;
      }
      if (!spawned) return false;
      sagChild = spawned;
      attachProcessLogs(spawned, "sag-api", logger);
      spawned.on("error", (error) => {
        logger.warn(`[sag-api] Process error: ${error.message}`);
        if (sagChild === spawned) sagChild = null;
      });
      spawned.on("exit", (code, signal) => {
        if (sagChild === spawned) sagChild = null;
        if (!shuttingDown) {
          logger.warn(`[sag-api] Exited unexpectedly (code=${code}, signal=${signal})`);
        }
      });
      const deadline = Date.now() + 8000;
      while (!shuttingDown && spawned.exitCode === null && Date.now() < deadline) {
        if (await tcpChecker(sagConfig.port)) {
          return true;
        }
        await delay(pollIntervalMs);
      }
      return spawned.exitCode === null;
    })().finally(() => {
      sagStartupPromise = null;
    });

    return sagStartupPromise;
  }

  function terminateManagedPython(target) {
    if (!target || target.exitCode !== null) return;
    try {
      target.stdin?.end();
    } catch {}
    const killTimer = setTimeout(() => {
      if (target.exitCode === null) {
        terminateProcessTree(target, platform, spawnImpl);
      }
    }, 1500);
    killTimer.unref?.();
  }

  async function startInternal() {
    if (shuttingDown) return null;
    const baseEnv = getEnv();
    const dataDir = getDataDir(baseEnv);
    const env = loadResearchEnv(dataDir, baseEnv, fsSyncImpl, logger);
    const explicitPort = env.KOODO_RESEARCH_PORT?.trim();
    const preferredPort = parsePort(explicitPort, DEFAULT_PORT);

    if (await healthProber(preferredPort, dataDir)) {
      activePort = preferredPort;
      isExternal = true;
      void ensureSagServiceStarted(env);
      return preferredPort;
    }

    if (isFlagDisabled(env.KOODO_RESEARCH_AUTO_START)) {
      return null;
    }

    const now = Date.now();
    crashTimestamps = crashTimestamps.filter((ts) => now - ts < CRASH_WINDOW_MS);
    if (crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      logger.warn("[research-agent] Too many recent crashes; pausing automatic restart.");
      return null;
    }

    const projectRoot = projectRootResolver();
    if (!isExistingFile(path.join(projectRoot, "research_agent", "__main__.py"), fsSyncImpl)) {
      logger.warn("[research-agent] research_agent package not found; skipping automatic startup.");
      return null;
    }

    void ensureSagServiceStarted(env);

    let port = preferredPort;
    if (!explicitPort) {
      try {
        port = await portPicker(preferredPort);
      } catch {
        port = preferredPort;
      }
    }

    const pythonBin = resolvePythonCommand(projectRoot, env, platform, fsSyncImpl);
    const childEnv = {
      ...env,
      KOODO_RESEARCH_DATA_DIR: dataDir,
      KOODO_RESEARCH_PORT: String(port),
      KOODO_RESEARCH_WATCH_STDIN: "1",
      PYTHONUTF8: "1",
    };

    if (child && child.exitCode === null) {
      terminateManagedPython(child);
      child = null;
    }

    let spawned;
    try {
      spawned = spawnImpl(pythonBin, ["-m", "research_agent"], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (error) {
      logger.warn(`[research-agent] Failed to spawn local service: ${error.message}`);
      return null;
    }

    child = spawned;
    let exitedEarly = false;
    spawned.stdin?.on("error", () => {});
    attachProcessLogs(spawned, "research-agent", logger);
    spawned.on("error", (error) => {
      exitedEarly = true;
      logger.warn(`[research-agent] Failed to launch Python service: ${error.message}`);
      if (child === spawned) {
        child = null;
        activePort = null;
      }
    });
    spawned.on("exit", (code, signal) => {
      exitedEarly = true;
      if (child === spawned) {
        child = null;
        activePort = null;
      }
      if (!shuttingDown) {
        crashTimestamps.push(Date.now());
        logger.warn(`[research-agent] Local service exited (code=${code}, signal=${signal})`);
      }
    });

    const deadline = Date.now() + readyTimeoutMs;
    while (!shuttingDown && !exitedEarly && Date.now() < deadline) {
      if (await healthProber(port, dataDir)) {
        if (shuttingDown) {
          terminateManagedPython(spawned);
          return null;
        }
        activePort = port;
        isExternal = false;
        return port;
      }
      await delay(pollIntervalMs);
    }

    if (spawned.exitCode === null) {
      terminateManagedPython(spawned);
    }
    if (child === spawned) {
      child = null;
      activePort = null;
    }
    return null;
  }

  async function ensureResearchServiceReady() {
    if (shuttingDown) return null;
    if (activePort !== null) {
      if (isExternal || (child && child.exitCode === null)) {
        return activePort;
      }
      activePort = null;
    }
    if (!startupPromise) {
      startupPromise = startInternal().finally(() => {
        startupPromise = null;
      });
    }
    return startupPromise;
  }

  function startResearchServices() {
    shuttingDown = false;
    return ensureResearchServiceReady();
  }

  function stopResearchServices() {
    shuttingDown = true;
    const managedPython = child;
    const managedSag = sagChild;
    child = null;
    sagChild = null;
    activePort = null;
    isExternal = false;
    terminateManagedPython(managedPython);
    terminateProcessTree(managedSag, platform, spawnImpl);
  }

  async function postOperation(port, dataDir, operation, body) {
    const token = await readValidToken(dataDir, fsPromisesImpl);
    if (!token) {
      return { retry: false, result: { error: "RESEARCH_UNAVAILABLE" } };
    }
    let response;
    try {
      response = await fetchImpl(`http://${DEFAULT_HOST}:${port}/${operation}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
        body,
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { retry: !timedOut, result: { error: "RESEARCH_UNAVAILABLE" } };
    }
    try {
      const data = await response.json();
      if (response.ok) return { retry: false, result: { data } };
      return {
        retry: false,
        result: {
          error: typeof data.detail === "string" && /^[A-Z_]+$/.test(data.detail)
            ? data.detail
            : "RESEARCH_INVALID_REQUEST",
        },
      };
    } catch {
      return { retry: false, result: { error: "RESEARCH_UNAVAILABLE" } };
    }
  }

  async function runResearchOperation(operation, payload) {
    if (
      !operations.has(operation) ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return { error: "RESEARCH_INVALID_REQUEST" };
    }
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      return { error: "RESEARCH_INVALID_REQUEST" };
    }
    if (Buffer.byteLength(body) > 750000) {
      return { error: "RESEARCH_INVALID_REQUEST" };
    }

    const needsSag =
      operation === "status" ||
      (operation === "search" && payload.mode !== "web") ||
      (operation === "ask" && (payload.mode === "fast" || payload.mode === "rerank"));
    const dataDir = getDataDir(getEnv());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const port = await ensureResearchServiceReady();
      if (!port) {
        return { error: "RESEARCH_UNAVAILABLE" };
      }
      if (needsSag && sagStartupPromise) {
        await sagStartupPromise;
      }
      const outcome = await postOperation(port, dataDir, operation, body);
      if (outcome.retry && attempt === 0 && !shuttingDown) {
        activePort = null;
        isExternal = false;
        continue;
      }
      return outcome.result;
    }
    return { error: "RESEARCH_UNAVAILABLE" };
  }

  return {
    startResearchServices,
    stopResearchServices,
    ensureResearchServiceReady,
    runResearchOperation,
    getState: () => ({ activePort, isExternal, hasChild: !!child, hasSagChild: !!sagChild }),
  };
}

const defaultManager = createResearchServiceManager();

module.exports = {
  runResearchOperation: defaultManager.runResearchOperation,
  startResearchServices: defaultManager.startResearchServices,
  stopResearchServices: defaultManager.stopResearchServices,
  createResearchServiceManager,
  loadResearchEnv,
  parsePort,
  parseSagAutoStartConfig,
  resolvePythonCommand,
  resolveSagCommand,
};
