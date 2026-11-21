import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import researchAgentModule from "./research-agent";

interface MinimalFsSync {
  statSync: (target: string) => { isFile: () => boolean };
  readFileSync: (target: string, encoding?: string) => string;
}

interface MinimalLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ResearchManager {
  startResearchServices: () => Promise<number | null>;
  stopResearchServices: () => void;
  runResearchOperation: (
    operation: string,
    payload: object
  ) => Promise<{ data: unknown } | { error: string }>;
  getState: () => {
    activePort: number | null;
    isExternal: boolean;
    hasChild: boolean;
    hasSagChild: boolean;
  };
}

interface ResearchAgentModule {
  createResearchServiceManager: (overrides?: Record<string, unknown>) => ResearchManager;
  loadResearchEnv: (
    dataDir: string,
    baseEnv?: Record<string, string | undefined>,
    fsSyncImpl?: MinimalFsSync,
    logger?: MinimalLogger
  ) => Record<string, string | undefined>;
  parseSagAutoStartConfig: (
    env?: Record<string, string | undefined>
  ) => { baseUrl: string; apiKey: string; port: number } | null;
}

const {
  createResearchServiceManager,
  loadResearchEnv,
  parseSagAutoStartConfig,
} = researchAgentModule as unknown as ResearchAgentModule;

const VALID_TOKEN = "a".repeat(64);

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdin = Object.assign(new EventEmitter(), {
    ended: false,
    end() {
      this.ended = true;
    },
  });
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  killed = false;

  kill() {
    this.killed = true;
    if (this.exitCode === null) {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    }
    return true;
  }
}

function makeFsSync(files: Record<string, string>) {
  const normalized = new Map(
    Object.entries(files).map(([filePath, content]) => [
      path.normalize(filePath).toLowerCase(),
      content,
    ])
  );
  return {
    statSync(target: string) {
      if (!normalized.has(path.normalize(target).toLowerCase())) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true };
    },
    readFileSync(target: string) {
      const value = normalized.get(path.normalize(target).toLowerCase());
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
  };
}

describe("loadResearchEnv", () => {
  it("loads allowlisted keys from config.json without overriding process env", () => {
    const dataDir = "C:\\data\\.koodo-research";
    const fsSync = makeFsSync({
      [path.join(dataDir, "config.json")]: JSON.stringify({
        KOODO_SAG_API_KEY: "file-sag-key",
        KOODO_SAG_PATHS: ["D:\\docs", "D:\\papers"],
        KOODO_SAG_AUTO_START: true,
        KOODO_BRAVE_API_KEY: "brave-from-file",
        UNRELATED_SECRET: "should-ignore",
      }),
    });
    const env = loadResearchEnv(
      dataDir,
      { KOODO_BRAVE_API_KEY: "brave-from-env" },
      fsSync,
      { warn: vi.fn(), info: vi.fn() }
    );
    expect(env.KOODO_SAG_API_KEY).toBe("file-sag-key");
    expect(env.KOODO_SAG_PATHS).toBe(`D:\\docs${path.delimiter}D:\\papers`);
    expect(env.KOODO_SAG_AUTO_START).toBe("1");
    expect(env.KOODO_BRAVE_API_KEY).toBe("brave-from-env");
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });
});

describe("parseSagAutoStartConfig", () => {
  it("enables local SAG auto-start only when API key is configured and local URL is used", () => {
    expect(parseSagAutoStartConfig({})).toBeNull();
    expect(
      parseSagAutoStartConfig({
        KOODO_SAG_API_KEY: "k",
        KOODO_SAG_AUTO_START: "false",
      })
    ).toBeNull();
    expect(
      parseSagAutoStartConfig({
        KOODO_SAG_API_KEY: "k",
        KOODO_SAG_BASE_URL: "https://remote.example.com/v1",
      })
    ).toBeNull();
    expect(
      parseSagAutoStartConfig({
        KOODO_SAG_API_KEY: "k",
        KOODO_SAG_BASE_URL: "http://127.0.0.1:24699/v1/",
      })
    ).toEqual({
      baseUrl: "http://127.0.0.1:24699/v1",
      apiKey: "k",
      port: 24699,
    });
  });
});

describe("createResearchServiceManager", () => {
  const projectRoot = "C:\\repo";
  const baseFiles = {
    [path.join(projectRoot, "research_agent", "__main__.py")]: "",
    [path.join(projectRoot, ".venv", "Scripts", "python.exe")]: "",
  };

  it("reuses a healthy external service without spawning or killing it", async () => {
    const spawn = vi.fn();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ topics: [] }),
    }));
    const manager = createResearchServiceManager({
      spawn,
      fetch,
      fsSync: makeFsSync(baseFiles),
      fsPromises: { readFile: async () => VALID_TOKEN },
      platform: "win32",
      getEnv: () => ({ KOODO_RESEARCH_DATA_DIR: "C:\\data" }),
      resolveProjectRoot: () => projectRoot,
      probeResearchHealth: async () => true,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const result = await manager.runResearchOperation("workspace", {});
    expect(result).toEqual({ data: { topics: [] } });
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({
      activePort: 18756,
      isExternal: true,
      hasChild: false,
    });
    manager.stopResearchServices();
  });

  it("spawns once for concurrent requests, forwards answer_model, and closes stdin on stop", async () => {
    const fakeChild = new FakeChild();
    let healthy = false;
    const spawn = vi.fn(() => {
      setTimeout(() => {
        healthy = true;
      }, 20);
      return fakeChild;
    });
    const fetch = vi.fn(async (_url: string, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ echo: JSON.parse(init.body) }),
    }));

    const manager = createResearchServiceManager({
      spawn,
      fetch,
      fsSync: makeFsSync(baseFiles),
      fsPromises: { readFile: async () => VALID_TOKEN },
      platform: "win32",
      getEnv: () => ({ KOODO_RESEARCH_DATA_DIR: "C:\\data" }),
      resolveProjectRoot: () => projectRoot,
      pickAvailablePort: async () => 19123,
      probeResearchHealth: async (port: number) => healthy && port === 19123,
      pollIntervalMs: 10,
      readyTimeoutMs: 1000,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const [r1, r2] = await Promise.all([
      manager.runResearchOperation("workspace", {}),
      manager.runResearchOperation("status", {
        answer_model: { base_url: "https://api.deepseek.com", model: "deepseek-chat" },
      }),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ data: { echo: {} } });
    expect(r2).toEqual({
      data: {
        echo: {
          answer_model: { base_url: "https://api.deepseek.com", model: "deepseek-chat" },
        },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:19123/status",
      expect.objectContaining({ method: "POST" })
    );

    manager.stopResearchServices();
    expect(fakeChild.stdin.ended).toBe(true);
  });

  it("self-heals once on connection drop, but does not retry timeouts", async () => {
    let spawnCount = 0;
    let healthy = false;
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      spawnCount += 1;
      healthy = true;
      const proc = new FakeChild();
      children.push(proc);
      return proc;
    });
    let fetchAttempt = 0;
    const fetch = vi.fn(async () => {
      fetchAttempt += 1;
      if (fetchAttempt === 1) {
        healthy = false;
        children[0]?.kill();
        throw new Error("ECONNREFUSED");
      }
      if (fetchAttempt === 2) {
        return { ok: true, status: 200, json: async () => ({ recovered: true }) };
      }
      const timeoutError = new Error("timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    });

    const manager = createResearchServiceManager({
      spawn,
      fetch,
      fsSync: makeFsSync(baseFiles),
      fsPromises: { readFile: async () => VALID_TOKEN },
      platform: "win32",
      getEnv: () => ({ KOODO_RESEARCH_DATA_DIR: "C:\\data" }),
      resolveProjectRoot: () => projectRoot,
      pickAvailablePort: async () => 18756,
      probeResearchHealth: async () => healthy,
      pollIntervalMs: 10,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const recovered = await manager.runResearchOperation("workspace", {});
    expect(recovered).toEqual({ data: { recovered: true } });
    expect(spawnCount).toBe(2);

    const timedOut = await manager.runResearchOperation("ask", { question: "hi" });
    expect(timedOut).toEqual({ error: "RESEARCH_UNAVAILABLE" });
    expect(spawnCount).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
    manager.stopResearchServices();
  });

  it("optionally auto-starts local SAG CLI when configured and not already listening", async () => {
    const sagBin = "C:\\tools\\sag.exe";
    const spawnedCommands: string[] = [];
    let sagListening = false;
    let pythonSpawned = false;
    const spawn = vi.fn((cmd: string) => {
      spawnedCommands.push(cmd);
      const child = new FakeChild();
      if (cmd === sagBin) {
        setTimeout(() => {
          sagListening = true;
        }, 15);
      } else {
        pythonSpawned = true;
      }
      return child;
    });

    const manager = createResearchServiceManager({
      spawn,
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
      fsSync: makeFsSync({ ...baseFiles, [sagBin]: "" }),
      fsPromises: { readFile: async () => VALID_TOKEN },
      platform: "win32",
      getEnv: () => ({
        KOODO_RESEARCH_DATA_DIR: "C:\\data",
        KOODO_SAG_API_KEY: "sag-secret",
        KOODO_SAG_BIN: sagBin,
      }),
      resolveProjectRoot: () => projectRoot,
      pickAvailablePort: async () => 18756,
      isTcpListening: async () => sagListening,
      probeResearchHealth: async () => pythonSpawned,
      pollIntervalMs: 10,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const port = await manager.startResearchServices();
    expect(port).toBe(18756);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawnedCommands).toContain(sagBin);
    expect(manager.getState().hasSagChild).toBe(true);
    manager.stopResearchServices();
  });
});
