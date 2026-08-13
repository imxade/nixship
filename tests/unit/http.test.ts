import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { readBoundedText, readFormUrlEncoded } from "../../src/server/http.ts";

describe("URL-encoded form parsing", () => {
  it("decodes form fields without placing them in a URL", async () => {
    const request = formRequest("username=owner&password=correct+horse+battery+staple");

    await expect(readFormUrlEncoded(request)).resolves.toEqual({
      username: "owner",
      password: "correct horse battery staple",
    });
  });

  it("rejects duplicate form fields", async () => {
    const request = formRequest("username=owner&username=other");

    await expect(readFormUrlEncoded(request)).rejects.toMatchObject({
      status: 400,
      code: "duplicate_field",
    });
  });
});

describe("bounded request bodies", () => {
  it("cancels a chunked body as soon as it exceeds the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("1234"));
        controller.enqueue(Buffer.from("5678"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new NextRequest(
      new Request("http://platform.test/api/auth/login", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );

    await expect(readBoundedText(request, 5)).rejects.toMatchObject({
      status: 413,
      code: "body_too_large",
    });
    expect(cancelled).toBe(true);
  });
});

function formRequest(body: string): NextRequest {
  return new NextRequest("http://platform.test/api/setup/complete", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
}
