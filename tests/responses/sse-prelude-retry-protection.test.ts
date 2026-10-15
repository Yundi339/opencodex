/**
 * The screening gate's "not now" rides the same prelude-decline ladder as an overload.
 *
 * Measured 2026-10-11 15:40-15:43 (+08): a 200 SSE held the prelude ~29s and then errored with
 * "response protection is unavailable" -- nothing had run, but the matcher only knew the
 * overload wording, so every turn landed on the client as a synthetic 502 with sendCount 1.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { withSsePreludeDeclineRetry } from "../../src/lib/sse-prelude-retry";
import { fetchWithTransientRetry } from "../../src/lib/upstream-retry";

const PRELUDE = 'data: {"type":"response.created"}\n\n';
const PROTECTION_ERROR = 'data: {"type":"error","code":"screening_unavailable","message":"response protection is unavailable"}\n\n';
const DELTA = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
const OK_DONE = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
const encoder = new TextEncoder();
const SERVER_ERROR = 'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"An error occurred while processing your request."}}}\n\n';

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

describe("sse prelude decline: screening-gate verdict", () => {
  test("a physical-send reporter remains open through asynchronous prelude retries", async () => {
    silenceWarn();
    let closed = false, sent = 0, reported = 0, reserved = 0, closes = 0;
    const reporter = Object.assign((count: number) => { expect(closed).toBe(false); reported += count; }, {
      beforeSend: () => { if (closed) return false; reserved++; return true; },
      close: () => { closed = true; closes++; },
    });
    const response = await fetchWithTransientRetry(async () => {
      sent++;
      return sseResponse(sent === 1 ? [PRELUDE, SERVER_ERROR] : [DELTA, OK_DONE]);
    }, { attempts: 1, retrySsePreludeDecline: true, retryCapacityDeferralsMs: [1], onSendsConsumed: reporter });
    expect(closed).toBe(false);
    expect(await response.text()).toBe(DELTA + OK_DONE);
    expect({ sent, reported, reserved, closes }).toEqual({ sent: 2, reported: 2, reserved: 2, closes: 1 });
  });

  test("the native opt-in retries inside HTTP 200 and accounts for physical sends", async () => {
    silenceWarn();
    let sends = 0, charged = 0;
    const response = await fetchWithTransientRetry(async () => {
      sends++;
      return sseResponse(sends === 1 ? [PRELUDE, SERVER_ERROR] : [PRELUDE, DELTA, OK_DONE]);
    }, {
      attempts: 1, retrySsePreludeDecline: true, retryCapacityDeferralsMs: [1],
      onSendsConsumed: count => { charged += count; },
    });
    expect(await response.text()).toBe(PRELUDE + DELTA + OK_DONE);
    expect(sends).toBe(2);
    expect(charged).toBe(2);
  });

  test.each([
    SERVER_ERROR,
    'data: {"type":"error","code":"server_error","message":"temporary failure"}\n\n',
    'data: {"type":"error","message":"An error occurred while processing your request."}\n\n',
    SERVER_ERROR.trimEnd(),
  ])("absorbs an explicit server failure before content: %s", async error => {
    silenceWarn();
    let sends = 0;
    const out = await withSsePreludeDeclineRetry(sseResponse([PRELUDE, error]), {
      delaysMs: [1], stallMs: 0,
      resend: async () => { sends++; return sseResponse([PRELUDE, DELTA, OK_DONE]); },
    }).text();
    expect(sends).toBe(1);
    expect(out).toBe(PRELUDE + DELTA + OK_DONE);
  });

  test.each([SERVER_ERROR, SERVER_ERROR.trimEnd()])("exhaustion preserves the terminal failure: %s", async error => {
    silenceWarn();
    let sends = 0;
    const out = await withSsePreludeDeclineRetry(sseResponse([PRELUDE, error]), {
      delaysMs: [1, 1], stallMs: 0,
      resend: async () => { sends++; return sseResponse([error]); },
    }).text();
    expect(sends).toBe(2);
    expect(out).toBe(error);
  });

  test.each([
    DELTA + SERVER_ERROR,
    'data: {"type":"error","code":"insufficient_quota","message":"An error occurred while processing your request."}\n\n',
    'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_request_error"}}}\n\n',
    'data: {"type":"response.failed","response":{"error":{"code":"server_error"},"output":[{"type":"function_call","arguments":"{}"}]}}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output_text":"server_error: An error occurred while processing your request."}}\n\n',
  ])("does not replay output or non-server failures: %s", async frames => {
    let sends = 0;
    const out = await withSsePreludeDeclineRetry(sseResponse([PRELUDE, frames]), {
      delaysMs: [1], stallMs: 0,
      resend: async () => { sends++; return sseResponse([OK_DONE]); },
    }).text();
    expect(sends).toBe(0);
    expect(out).toBe(PRELUDE + frames);
  });

  test("a protection decline before any content is absorbed and the turn re-dialled", async () => {
    silenceWarn();
    let sends = 0;
    const wrapped = withSsePreludeDeclineRetry(sseResponse([PRELUDE, PROTECTION_ERROR]), {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([PRELUDE, OK_DONE]);
      },
      acceptAnyContentType: true,
      label: "protection",
    });
    const out = await wrapped.text();
    expect(sends).toBe(1);
    expect(out).toContain("response.completed");
    expect(out).not.toContain("response protection is unavailable");
  });

  test("an unframed protection refusal (whole-JSON body) is retried once", async () => {
    silenceWarn();
    let sends = 0;
    const declined = new Response('{"error":{"message":"response protection is unavailable"}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const wrapped = withSsePreludeDeclineRetry(declined, {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([OK_DONE]);
      },
      acceptAnyContentType: true,
    });
    const out = await wrapped.text();
    expect(sends).toBe(1);
    expect(out).toContain("response.completed");
  });

  test("a protection error after real content is delivered, never retried", async () => {
    silenceWarn();
    let sends = 0;
    const wrapped = withSsePreludeDeclineRetry(sseResponse([PRELUDE, DELTA, PROTECTION_ERROR]), {
      delaysMs: [1],
      resend: async () => {
        sends += 1;
        return sseResponse([OK_DONE]);
      },
      acceptAnyContentType: true,
    });
    const out = await wrapped.text();
    expect(sends).toBe(0);
    expect(out).toContain("response.output_text.delta");
    expect(out).toContain("response protection is unavailable");
  });
});
