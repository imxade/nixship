import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { readFormUrlEncoded } from "../../src/server/http.ts";

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
