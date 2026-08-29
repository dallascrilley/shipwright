import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");

function renderService(mode: string, uid?: string) {
  return spawnSync(
    "bash",
    [resolve(repoRoot, "deploy", "render-service.sh"), mode, ...(uid ? [uid] : [])],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

describe("Shipwright Docker deployment modes", () => {
  test("keeps the dedicated-host rootful unit", () => {
    const result = renderService("rootful");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Requires=docker.service");
    expect(result.stdout).toContain("SupplementaryGroups=docker");
    expect(result.stdout).not.toContain("BindReadOnlyPaths=");
  });

  test("renders a rootless unit bound only to the Shipwright socket", () => {
    const result = renderService("rootless", "1001");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Requires=shipwright-docker.service");
    expect(result.stdout).toContain("After=shipwright-docker.service");
    expect(result.stdout).toContain(
      "BindReadOnlyPaths=/run/user/1001/docker.sock:/var/run/docker.sock",
    );
    expect(result.stdout).not.toContain("Requires=docker.service");
    expect(result.stdout).not.toContain("SupplementaryGroups=docker");
    expect(result.stdout).not.toContain("%%SHIPWRIGHT_UID%%");
  });

  test("renders a root wrapper for the Shipwright user Docker service", () => {
    const result = renderService("rootless-docker", "1001");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Requires=user@1001.service");
    expect(result.stdout).toContain(
      "systemctl --user --machine=shipwright@ start docker.service",
    );
    expect(result.stdout).toContain("test -S /run/user/1001/docker.sock");
    expect(result.stdout).not.toContain("%%SHIPWRIGHT_UID%%");
  });

  test("rejects an invalid mode and a missing rootless UID", () => {
    expect(renderService("shared").status).not.toBe(0);
    expect(renderService("rootless").status).not.toBe(0);
  });

  test("bootstraps and deploys rootless Docker without host daemon membership", () => {
    const bootstrap = readFileSync(resolve(repoRoot, "deploy", "bootstrap-host.sh"), "utf8");
    const deploy = readFileSync(resolve(repoRoot, "deploy", "deploy.sh"), "utf8");
    const example = readFileSync(resolve(repoRoot, "deploy", "shipwright.env.example"), "utf8");

    expect(bootstrap).toContain("dockerd-rootless-setuptool.sh");
    expect(bootstrap).toContain("loginctl enable-linger shipwright");
    expect(deploy).toContain("SHIPWRIGHT_DOCKER_MODE");
    expect(deploy).toContain('DOCKER_HOST="unix://$docker_socket"');
    expect(example).toContain("SHIPWRIGHT_DOCKER_MODE=rootful");
  });
});
