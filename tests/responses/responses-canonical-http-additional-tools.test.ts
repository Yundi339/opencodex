import { describe, expect, test } from "bun:test";
import {
  CODEX_RESPONSES_HTTP_URL,
  prepareCodexHttpInit,
  prepareCodexWsRequest,
} from "../../src/server/responses/codex-ws-request";
import { stripUnsupportedResponsesIncludes } from "../../src/adapters/openai-responses/canonical-forward";

const tool = { type: "function", name: "shell", parameters: { type: "object" } };

describe("canonical HTTP additional_tools", () => {
  test("drops the private encrypted-content include for routed gateways", () => {
    expect(stripUnsupportedResponsesIncludes({ include: ["output.encrypted_content", "web_search_call.action.sources"] })).toEqual({
      include: ["web_search_call.action.sources"],
    });
  });
  test("rewrites a noncanonical Responses HTTP endpoint too", () => {
    const prepared = prepareCodexHttpInit("https://api.x.ai/v1/responses", {
      body: JSON.stringify({ input: [{ type: "additional_tools", tools: [tool] }] }),
    });
    const body = JSON.parse(String(prepared.body)) as { input: unknown[]; tools: unknown[] };
    expect(body.input).toEqual([]);
    expect(body.tools).toEqual([tool]);
  });

  test("moves the private input item onto tools for the HTTP body", () => {
    const prepared = prepareCodexHttpInit(CODEX_RESPONSES_HTTP_URL, {
      body: JSON.stringify({
        model: "gpt-6.1-sol",
        stream: true,
        input: [
          { type: "message", role: "user", content: "hello" },
          { type: "additional_tools", role: "developer", tools: [tool] },
        ],
      }),
    });
    const body = JSON.parse(String(prepared.body)) as {
      input: Array<{ type: string }>;
      tools: unknown[];
    };
    expect(body.input.map(item => item.type)).toEqual(["message"]);
    expect(body.tools).toEqual([tool]);
  });

  test("keeps the WebSocket frame unchanged while the HTTP fallback is rewritten", () => {
    const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, {
      body: JSON.stringify({
        model: "gpt-6.1-sol",
        stream: true,
        tools: [tool],
        input: [{ type: "additional_tools", role: "developer", tools: [tool] }],
      }),
    })!;
    const frame = JSON.parse(prepared.frameText) as { input: Array<{ type: string }> };
    const httpBody = JSON.parse(String(prepared.httpInit.body)) as {
      input: Array<{ type: string }>;
      tools: unknown[];
    };
    expect(frame.input.map(item => item.type)).toEqual(["additional_tools"]);
    expect(httpBody.input).toEqual([]);
    expect(httpBody.tools).toEqual([tool]);
  });
});
