import { describe, it, expect, afterEach, vi } from "vitest";
import { loft } from "../src/index";
import { mockFetch, jsonResponse, sseResponse, erroringSseResponse, sseFrame } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ask = [{ role: "user" as const, content: "hi" }];

describe("loft.ai.chat", () => {
  it("returns the assistant reply without streaming", async () => {
    mockFetch((_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ stream: false });
      return jsonResponse({ choices: [{ message: { content: "hello" } }] });
    });
    expect(await loft.ai.chat(ask)).toBe("hello");
  });

  it("streams tokens and resolves to the full text", async () => {
    mockFetch(() =>
      sseResponse([
        sseFrame({ choices: [{ delta: { content: "He" } }] }),
        sseFrame({ choices: [{ delta: { content: "llo" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const tokens: string[] = [];
    const reply = await loft.ai.chat(ask, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(["He", "llo"]);
    expect(reply).toBe("Hello");
  });

  it("ignores malformed SSE frames", async () => {
    mockFetch(() =>
      sseResponse([
        "data: not json\n\n",
        sseFrame({ choices: [{ delta: { content: "ok" } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await loft.ai.chat(ask, { onToken: () => undefined })).toBe("ok");
  });

  it("throws kind stream when the stream ends without [DONE]", async () => {
    mockFetch(() => sseResponse([sseFrame({ choices: [{ delta: { content: "Hi" } }] })]));
    await expect(loft.ai.chat(ask, { onToken: () => undefined })).rejects.toMatchObject({ kind: "stream" });
  });

  it("maps a mid-stream abort to kind aborted", async () => {
    mockFetch(() => erroringSseResponse(new DOMException("stop", "AbortError")));
    await expect(loft.ai.chat(ask, { onToken: () => undefined })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("surfaces a non-2xx response as a LoftError", async () => {
    mockFetch(() => new Response("overloaded", { status: 503 }));
    await expect(loft.ai.chat(ask)).rejects.toMatchObject({ kind: "http", status: 503 });
  });
});
