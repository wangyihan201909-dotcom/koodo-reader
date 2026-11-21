const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const operations = new Set([
  "status", "workspace", "search", "ask", "topic", "topic-book", "note", "suggest", "link",
]);

async function runResearchOperation(operation, payload) {
  if (
    !operations.has(operation) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { error: "RESEARCH_INVALID_REQUEST" };
  }
  try {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 750000) {
      return { error: "RESEARCH_INVALID_REQUEST" };
    }
    const directory = process.env.KOODO_RESEARCH_DATA_DIR?.trim() || path.join(os.homedir(), ".koodo-research");
    const token = (await fs.readFile(path.join(directory, "token"), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return { error: "RESEARCH_UNAVAILABLE" };
    }
    const response = await fetch(`http://127.0.0.1:18756/${operation}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(240000),
      redirect: "error",
      body,
    });
    const data = await response.json();
    if (response.ok) return { data };
    return {
      error: typeof data.detail === "string" && /^[A-Z_]+$/.test(data.detail)
        ? data.detail
        : "RESEARCH_INVALID_REQUEST",
    };
  } catch {
    return { error: "RESEARCH_UNAVAILABLE" };
  }
}

module.exports = { runResearchOperation };
