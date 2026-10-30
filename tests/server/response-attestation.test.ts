import { describe, expect, test } from "bun:test";
import { withResponseAttestation } from "../../src/lib/response-attestation";

function sse(model: string): Response {
  const payload = JSON.stringify({ type: "response.completed", response: { model, status: "completed" } });
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("response model attestation", () => {
  test.each(["grok-4.7-build", "grok-4.7-build-fast"])("accepts xAI wire alias %s", async reported => {
    const findings: unknown[] = [];
    const response = withResponseAttestation(sse(reported), {
      requestedModel: "grok-4.7",
      onFinding: finding => findings.push(finding),
    });
    await response.text();
    expect(findings).toEqual([]);
  });
});
