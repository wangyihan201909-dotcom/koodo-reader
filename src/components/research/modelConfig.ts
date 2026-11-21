import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

export interface ResearchAnswerModel {
  base_url: string;
  model: string;
  api_key?: string;
  provider_id?: string;
}

interface StoredAIModelConfig {
  endpoint?: unknown;
  modelName?: unknown;
  modelId?: unknown;
  apiKey?: unknown;
  providerId?: unknown;
}

interface StoredAIModelEntry {
  key?: unknown;
  displayName?: unknown;
  config?: unknown;
}

const ASSIGNMENT_PRIORITY = [
  "aiAssistanceModel",
  "aiTranslateModel",
  "aiDictModel",
] as const;

export function normalizeModelEndpoint(endpoint: string): string {
  let cleaned = endpoint.trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/chat/completions")) {
    cleaned = cleaned.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  }
  if (!/^https?:\/\/[^/\s]+/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function parseEntryConfig(raw: unknown): StoredAIModelConfig | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as StoredAIModelConfig)
        : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as StoredAIModelConfig;
  }
  return null;
}

export function extractResearchAnswerModel(
  entry: unknown
): ResearchAnswerModel | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as StoredAIModelEntry;
  const config = parseEntryConfig(record.config);
  if (!config) {
    return null;
  }
  const baseUrl =
    typeof config.endpoint === "string"
      ? normalizeModelEndpoint(config.endpoint)
      : "";
  const modelId =
    typeof config.modelId === "string" ? config.modelId.trim() : "";
  const modelName =
    typeof config.modelName === "string" ? config.modelName.trim() : "";
  const model = modelId || modelName;
  if (!baseUrl || !model) {
    return null;
  }
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const providerId =
    typeof config.providerId === "string" ? config.providerId.trim() : "";
  const result: ResearchAnswerModel = { base_url: baseUrl, model };
  if (apiKey) result.api_key = apiKey;
  if (providerId) result.provider_id = providerId;
  return result;
}

export function resolveResearchAnswerModel(
  getReaderConfig: (key: string) => string | null | undefined,
  allModels: Record<string, unknown> | null | undefined
): ResearchAnswerModel | null {
  if (!allModels || typeof allModels !== "object" || Array.isArray(allModels)) {
    return null;
  }
  const entries = Object.values(allModels);
  for (const configKey of ASSIGNMENT_PRIORITY) {
    const selectedKey = getReaderConfig(configKey)?.trim();
    if (!selectedKey) continue;
    const direct = extractResearchAnswerModel(allModels[selectedKey]);
    if (direct) return direct;
    const matched = entries.find(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as StoredAIModelEntry).key === selectedKey
    );
    const resolved = extractResearchAnswerModel(matched);
    if (resolved) return resolved;
  }
  for (const entry of entries) {
    const resolved = extractResearchAnswerModel(entry);
    if (resolved) return resolved;
  }
  return null;
}

export function getConfiguredResearchModel(): ResearchAnswerModel | null {
  try {
    return resolveResearchAnswerModel(
      (key) => ConfigService.getReaderConfig(key),
      ConfigService.getAllObjectConfig("aiModelConfig")
    );
  } catch {
    return null;
  }
}
