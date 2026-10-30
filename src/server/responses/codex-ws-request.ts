import {
  applyCodexRoutingHint,
  CODEX_RESPONSES_LITE_HEADER,
  CODEX_RESPONSES_LITE_METADATA_KEY,
} from "../../codex/forward-transport-headers";
import { conversationKeyFromHeaders, threadAffinityResetActive } from "../ws-thread-transport";

/** Per-turn headers the WebSocket carries in `client_metadata` of each frame, not in the upgrade. */
export const CODEX_WS_FRAME_HEADERS = ["x-codex-turn-state", "x-codex-turn-metadata"] as const;

export const CODEX_RESPONSES_HTTP_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
export const WS_BETA = "responses_websockets=2026-02-06";

export interface PreparedCodexWsRequest {
  /** Fully synthesized frame; the transport measures this exact text before dialing. */
  frameText: string;
  headers: Record<string, string>;
  /** Original HTTP body/framing/options with only the canonical routing hint re-derived. */
  httpInit: RequestInit;
  canonical: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** ChatGPT's HTTP Responses parser rejects Codex's private `additional_tools` input item. */
export function hoistCanonicalHttpAdditionalTools(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const item of body.input) {
    if (isRecord(item) && item.type === "additional_tools") {
      changed = true;
      if (Array.isArray(item.tools)) promoted.push(...item.tools);
      continue;
    }
    input.push(item);
  }
  if (!changed) return body;
  if (body.tools !== undefined && !Array.isArray(body.tools)) return { ...body, input };
  const existing = Array.isArray(body.tools) ? body.tools : [];
  const seen = new Set(existing.map(tool => JSON.stringify(tool)));
  const tools = [...existing];
  for (const tool of promoted) {
    const key = JSON.stringify(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push(tool);
  }
  return tools.length > 0 ? { ...body, input, tools } : { ...body, input };
}

/** Public Responses gateways reject Codex's private additional_tools input wrapper. */
export function hoistHttpAdditionalTools(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  const input: unknown[] = [];
  const promoted: unknown[] = [];
  let changed = false;
  for (const item of body.input) {
    if (isRecord(item) && item.type === "additional_tools") {
      changed = true;
      if (Array.isArray(item.tools)) promoted.push(...item.tools);
      continue;
    }
    input.push(item);
  }
  if (!changed) return body;
  if (body.tools !== undefined && !Array.isArray(body.tools)) return { ...body, input };
  const existing = Array.isArray(body.tools) ? body.tools : [];
  const seen = new Set(existing.map(tool => JSON.stringify(tool)));
  const tools = [...existing];
  for (const tool of promoted) {
    const key = JSON.stringify(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push(tool);
  }
  return { ...body, input, ...(tools.length > 0 ? { tools } : {}) };
}

function isResponsesHttpUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/responses");
  } catch {
    return false;
  }
}


function applyLiteMetadata(body: Record<string, unknown>, headers: Headers): boolean {
  const metadata = body.client_metadata;
  // Native client metadata is a string map. Do not spread malformed input or
  // turn boolean/number values into plausible but invented protocol strings.
  if (metadata !== undefined && (!isRecord(metadata)
    || Object.values(metadata).some(value => typeof value !== "string"))) return false;
  const lite = headers.get(CODEX_RESPONSES_LITE_HEADER);
  if (lite === "true" || lite === "false") {
    body.client_metadata = { ...(metadata as Record<string, string> | undefined),
      [CODEX_RESPONSES_LITE_METADATA_KEY]: lite };
  }
  for (const name of CODEX_WS_FRAME_HEADERS) {
    const value = headers.get(name);
    const current = body.client_metadata as Record<string, string> | undefined;
    if (value !== null && !Object.hasOwn(current ?? {}, name)) {
      body.client_metadata = { ...current, [name]: value };
    }
  }
  // The affinity re-roll drops this conversation's identity hints, and this function is the one
  // place the canonical WS path copies a header into the JSON frame: without the check, a header
  // the forward builder already removed would come straight back through client_metadata.
  const affinityKey = conversationKeyFromHeaders(headers);
  if (affinityKey && threadAffinityResetActive(affinityKey)) {
    const current = body.client_metadata as Record<string, string> | undefined;
    if (current && Object.hasOwn(current, "x-codex-turn-state")) {
      const next = { ...current };
      delete next["x-codex-turn-state"];
      body.client_metadata = next;
    }
  }
  return true;
}

/** Prepare an HTTP Responses request for a public upstream; malformed bodies stay untouched. */
export function prepareCodexHttpInit(url: string, init: RequestInit): RequestInit {
  if (!isResponsesHttpUrl(url) || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  let body: unknown;
  try { body = JSON.parse(init.body); } catch { /* malformed body cannot authorize a hint */ }
  if (url === CODEX_RESPONSES_HTTP_URL) applyCodexRoutingHint(headers, body);
  const hoisted = hoistHttpAdditionalTools(body);
  if (hoisted === body) return { ...init, headers };
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify(hoisted) };
}

/** Null refuses only WS conversion; canonical HTTP normalization is independently reusable. */
export function prepareCodexWsRequest(url: string, init: RequestInit): PreparedCodexWsRequest | null {
  if (typeof init.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (!isRecord(parsed)) return null;
    const body = { ...parsed };
    const canonical = url === CODEX_RESPONSES_HTTP_URL;
    const httpHeaders = new Headers(init.headers);
    if (canonical) {
      if (!applyLiteMetadata(body, httpHeaders)) return null;
      applyCodexRoutingHint(httpHeaders, body);
    }
    const httpInit = prepareCodexHttpInit(url, { ...init, headers: httpHeaders });
    // WS is implicitly streaming; retain every other caller field except type.
    delete body.stream;
    const frameText = JSON.stringify({ ...body, type: "response.create" });
    const headers: Record<string, string> = {};
    httpHeaders.forEach((value, key) => {
      if (key === "content-type" || key === "content-length" || key === "accept" || key === "accept-encoding") return;
      headers[key] = value;
    });
    // Preserve the existing beta composition for both canonical and opted-in gateways.
    headers["openai-beta"] = headers["openai-beta"]
      ? headers["openai-beta"].includes("responses_websockets")
        ? headers["openai-beta"]
        : `${headers["openai-beta"]}, ${WS_BETA}`
      : WS_BETA;
    return { frameText, headers, httpInit, canonical };
  } catch {
    return null;
  }
}
