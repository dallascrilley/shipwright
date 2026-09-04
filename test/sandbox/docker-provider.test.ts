import { describe, expect, test } from "bun:test";
import { resolveDockerSocketPath } from "sandbox-agent/docker";

describe("sandbox-agent Docker socket selection", () => {
  test("uses Docker's conventional root socket when DOCKER_HOST is unset", () => {
    expect(resolveDockerSocketPath()).toBe("/var/run/docker.sock");
  });

  test("uses a configured rootless Unix socket", () => {
    expect(resolveDockerSocketPath("unix:///run/user/1001/docker.sock"))
      .toBe("/run/user/1001/docker.sock");
  });

  test("rejects unsupported and empty Docker hosts without echoing them", () => {
    expect(() => resolveDockerSocketPath("tcp://secret.example:2376"))
      .toThrow("DOCKER_HOST must name a non-empty unix:// socket");
    expect(() => resolveDockerSocketPath("unix://"))
      .toThrow("DOCKER_HOST must name a non-empty unix:// socket");
  });
});
