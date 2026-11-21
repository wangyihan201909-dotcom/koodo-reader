import { describe, expect, it, vi } from "vitest";

vi.mock("../../assets/lib/kookit-extra-browser.min", () => ({
  ConfigService: {
    getReaderConfig: () => "",
    getAllObjectConfig: () => ({}),
  },
}));

import {
  extractResearchAnswerModel,
  normalizeModelEndpoint,
  resolveResearchAnswerModel,
} from "./modelConfig";

describe("normalizeModelEndpoint", () => {
  it("strips trailing slashes and /chat/completions suffix", () => {
    expect(normalizeModelEndpoint("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1"
    );
    expect(
      normalizeModelEndpoint("https://api.deepseek.com/v1/chat/completions/")
    ).toBe("https://api.deepseek.com/v1");
    expect(normalizeModelEndpoint("http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/v1"
    );
  });

  it("rejects non-http endpoints", () => {
    expect(normalizeModelEndpoint("file:///etc/passwd")).toBe("");
    expect(normalizeModelEndpoint("not-a-url")).toBe("");
  });
});

describe("extractResearchAnswerModel", () => {
  it("reads modelId, endpoint, and apiKey from object or JSON string config", () => {
    expect(
      extractResearchAnswerModel({
        key: "1",
        displayName: "deepseek-flash",
        config: {
          endpoint: "https://api.deepseek.com/v1/",
          modelName: "deepseek-flash",
          modelId: "deepseek-chat",
          apiKey: "sk-test",
        },
      })
    ).toEqual({
      base_url: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      api_key: "sk-test",
    });

    expect(
      extractResearchAnswerModel({
        key: "2",
        displayName: "local-llama",
        config: JSON.stringify({
          endpoint: "http://127.0.0.1:11434/v1",
          modelName: "llama3.2",
          modelId: "",
          apiKey: "",
        }),
      })
    ).toEqual({
      base_url: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
    });
  });
});

describe("resolveResearchAnswerModel", () => {
  const models = {
    m1: {
      key: "m1",
      displayName: "translate-model",
      config: {
        endpoint: "https://api.example.com/v1",
        modelId: "model-trans",
        apiKey: "key-1",
      },
    },
    m2: {
      key: "m2",
      displayName: "deepseek-flash",
      config: {
        endpoint: "https://api.deepseek.com",
        modelId: "deepseek-chat",
        apiKey: "key-2",
      },
    },
  };

  it("prefers aiAssistanceModel over translate/dict assignments", () => {
    const readerConfig: Record<string, string> = {
      aiTranslateModel: "m1",
      aiAssistanceModel: "m2",
    };
    expect(
      resolveResearchAnswerModel((key) => readerConfig[key], models)
    ).toEqual({
      base_url: "https://api.deepseek.com",
      model: "deepseek-chat",
      api_key: "key-2",
    });
  });

  it("falls back to translate/dict or first valid added model when assistance is unset", () => {
    const readerConfig: Record<string, string> = {
      aiTranslateModel: "m1",
    };
    expect(
      resolveResearchAnswerModel((key) => readerConfig[key], models)
    ).toEqual({
      base_url: "https://api.example.com/v1",
      model: "model-trans",
      api_key: "key-1",
    });

    expect(resolveResearchAnswerModel(() => "", models)).toEqual({
      base_url: "https://api.example.com/v1",
      model: "model-trans",
      api_key: "key-1",
    });
  });

  it("returns null when no valid models exist", () => {
    expect(resolveResearchAnswerModel(() => "", {})).toBeNull();
    expect(resolveResearchAnswerModel(() => "missing", null)).toBeNull();
  });
});
