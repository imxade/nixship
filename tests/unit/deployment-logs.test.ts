import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deploymentLogSize,
  readDeploymentLogRange,
  readDeploymentLogTail,
} from "../../src/server/deployment-logs.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("deployment log reads", () => {
  it("reads bounded ranges and tails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-log-"));
    directories.push(directory);
    const file = path.join(directory, "deployment.log");
    fs.writeFileSync(file, "0123456789");

    expect(deploymentLogSize(file)).toBe(10);
    expect(readDeploymentLogRange(file, 3, 4)).toEqual({
      text: "3456",
      nextOffset: 7,
      size: 10,
    });
    expect(readDeploymentLogTail(file, 3)).toBe("789");
  });

  it("refuses symbolic links where O_NOFOLLOW is available", () => {
    if (typeof fs.constants.O_NOFOLLOW !== "number") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platform-log-"));
    directories.push(directory);
    const target = path.join(directory, "target.log");
    const link = path.join(directory, "link.log");
    fs.writeFileSync(target, "secret");
    fs.symlinkSync(target, link);

    expect(deploymentLogSize(link)).toBe(0);
    expect(readDeploymentLogTail(link, 100)).toBe("");
  });
});
