import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker } from "sandbox-agent/docker";

test("sandbox-agent honors a configured rootless Docker socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "shipwright-docker-provider-"));
  const socketPath = join(root, "docker.sock");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.method === "POST" && request.url?.startsWith("/containers/create?")) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"Id":"sandbox-fixture"}');
      return;
    }
    if (request.method === "POST" && request.url === "/containers/sandbox-fixture/start") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const previousDockerHost = process.env.DOCKER_HOST;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    process.env.DOCKER_HOST = `unix://${socketPath}`;

    const sandboxId = await docker({ image: "sandbox-fixture:latest" }).create();

    expect(sandboxId).toBe("sandbox-fixture");
    expect(requests).toEqual([
      expect.stringMatching(/^POST \/containers\/create\?/),
      "POST /containers/sandbox-fixture/start",
    ]);
  } finally {
    if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousDockerHost;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});
