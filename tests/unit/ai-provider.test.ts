import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/server/ai/provider.ts";

describe("OpenAI-compatible provider transport", () => {
  it("calls a private local endpoint only when explicitly enabled", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-small",
      apiKey: "local-test-key",
      allowPrivateNetwork: true,
      fetchImplementation: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Local model answer", tool_calls: [] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(provider.complete([{ role: "user", content: "Hello" }], [])).resolves.toEqual({
      content: "Local model answer",
      toolCalls: [],
    });
    expect(requestUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer local-test-key");
    expect(String(requestInit?.body)).not.toContain("local-test-key");
    expect(requestInit?.redirect).toBe("error");
  });

  it("blocks private endpoints by default and metadata addresses even when private access is enabled", async () => {
    const disabled = new OpenAiCompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-small",
      fetchImplementation: async () => new Response("{}"),
    });
    await expect(disabled.complete([{ role: "user", content: "Hello" }], [])).rejects.toMatchObject(
      { code: "private_ai_disabled" },
    );

    const metadata = new OpenAiCompatibleProvider({
      baseUrl: "http://169.254.169.254/v1",
      modelId: "qwen-small",
      allowPrivateNetwork: true,
      fetchImplementation: async () => new Response("{}"),
    });
    await expect(metadata.complete([{ role: "user", content: "Hello" }], [])).rejects.toMatchObject(
      { code: "blocked_ai_address" },
    );
  });

  it("rejects malformed tool arguments without executing anything", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-small",
      allowPrivateNetwork: true,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "bad", function: { name: "cap__apps__list", arguments: "not-json" } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    await expect(
      provider.complete([{ role: "user", content: "List apps" }], []),
    ).rejects.toMatchObject({ code: "invalid_tool_input" });
  });

  it("rejects a chunked provider response that exceeds the byte limit", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-small",
      allowPrivateNetwork: true,
      fetchImplementation: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.alloc(700 * 1024, 65));
              controller.enqueue(Buffer.alloc(700 * 1024, 66));
            },
          }),
          { status: 200 },
        ),
    });

    await expect(provider.complete([{ role: "user", content: "Hello" }], [])).rejects.toMatchObject(
      { code: "ai_response_too_large" },
    );
  });
});
