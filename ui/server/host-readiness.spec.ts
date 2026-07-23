import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  evaluateDockerReadiness,
  evaluateGitHubAppReadiness,
  evaluateHostReadiness,
  evaluateProviderReadiness,
  evaluateStateStoreReadiness,
  getHostReadiness,
  loadHostReadinessProbeInputs,
  type HostReadinessProbeInputs,
} from "./host-readiness";

const checkedAt = "2026-07-20T12:00:00.000Z";

describe("host readiness evaluators", () => {
  test("provider states", () => {
    expect(
      evaluateProviderReadiness({ hasCredential: false }, checkedAt),
    ).toMatchObject({ status: "not_configured", code: "provider_missing" });
    expect(
      evaluateProviderReadiness(
        { hasCredential: true, providerName: "kimi" },
        checkedAt,
      ),
    ).toMatchObject({
      status: "ready",
      code: "provider_configured",
      detail: "kimi",
    });
  });

  test("github app states", () => {
    expect(
      evaluateGitHubAppReadiness(
        {
          hasAppId: false,
          hasInlinePrivateKey: false,
          hasPrivateKeyPath: false,
        },
        checkedAt,
      ).code,
    ).toBe("github_app_missing");
    expect(
      evaluateGitHubAppReadiness(
        {
          hasAppId: true,
          hasInlinePrivateKey: true,
          hasPrivateKeyPath: true,
        },
        checkedAt,
      ).code,
    ).toBe("github_app_missing");
    expect(
      evaluateGitHubAppReadiness(
        {
          hasAppId: true,
          hasInlinePrivateKey: false,
          hasPrivateKeyPath: true,
          privateKeyPathReadable: false,
        },
        checkedAt,
      ),
    ).toMatchObject({ status: "unavailable", code: "github_app_key_unreadable" });
    expect(
      evaluateGitHubAppReadiness(
        {
          hasAppId: true,
          hasInlinePrivateKey: true,
          hasPrivateKeyPath: false,
        },
        checkedAt,
      ).status,
    ).toBe("ready");
  });

  test("docker and state store states", () => {
    expect(
      evaluateDockerReadiness(
        { socketPath: "/tmp/x.sock", exists: false, readable: false },
        checkedAt,
      ).code,
    ).toBe("docker_socket_missing");
    expect(
      evaluateDockerReadiness(
        { socketPath: "/tmp/x.sock", exists: true, readable: false },
        checkedAt,
      ).code,
    ).toBe("docker_socket_unreadable");
    expect(
      evaluateStateStoreReadiness(
        { path: "/tmp/state", exists: false, readable: false },
        checkedAt,
      ).code,
    ).toBe("state_store_missing");
    expect(
      evaluateStateStoreReadiness(
        { path: "/tmp/state", exists: true, readable: false },
        checkedAt,
      ).code,
    ).toBe("state_store_unreadable");
  });

  test("demo mode is explicit on aggregate report", () => {
    const report = evaluateHostReadiness({
      demoMode: true,
      checkedAt,
      provider: { hasCredential: false },
      githubApp: {
        hasAppId: false,
        hasInlinePrivateKey: false,
        hasPrivateKeyPath: false,
      },
      docker: { socketPath: "/var/run/docker.sock", exists: false, readable: false },
      stateStore: { path: "/tmp/state", exists: false, readable: false },
    });
    expect(report.demoMode).toBe(true);
    expect(report.blocksLiveStart).toBe(false);
  });
});

describe("loadHostReadinessProbeInputs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns only redacted booleans and never credential values", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipwright-ready-"));
    dirs.push(dir);
    const keyPath = join(dir, "app.pem");
    writeFileSync(keyPath, "PRIVATE-KEY-MATERIAL-SHOULD-NOT-LEAK", "utf8");
    const socket = join(dir, "docker.sock");
    writeFileSync(socket, "");
    const state = join(dir, "state");
    mkdirSync(state);
    writeFileSync(join(state, "operator-runs.json"), "[]\n", "utf8");

    const env = {
      ANTHROPIC_API_KEY: "sk-secret-anthropic-value",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_APP_PRIVATE_KEY: undefined,
      AGENTOS_PROVIDER: "anthropic",
      DOCKER_HOST: `unix://${socket}`,
      SHIPWRIGHT_UI_DEMO: undefined,
    } as NodeJS.ProcessEnv;

    const inputs = loadHostReadinessProbeInputs(env, {
      now: () => checkedAt,
      stateDirectory: state,
    });

    const serialized = JSON.stringify(inputs);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(inputs.provider).toEqual({
      hasCredential: true,
      providerName: "anthropic",
    });
    expect(inputs.githubApp).toEqual({
      hasAppId: true,
      hasInlinePrivateKey: false,
      hasPrivateKeyPath: true,
      privateKeyPathReadable: true,
    });
    expect(inputs.docker.exists).toBe(true);
    expect(inputs.docker.readable).toBe(true);
    expect(inputs.stateStore).toMatchObject({
      path: join(state, "operator-runs.json"),
      exists: true,
      readable: true,
    });
  });

  test("injected loader arguments stay redacted for getHostReadiness", () => {
    const seen: HostReadinessProbeInputs[] = [];
    const report = getHostReadiness(() => {
      const inputs: HostReadinessProbeInputs = {
        demoMode: false,
        checkedAt,
        provider: { hasCredential: true, providerName: "kimi" },
        githubApp: {
          hasAppId: true,
          hasInlinePrivateKey: true,
          hasPrivateKeyPath: false,
        },
        docker: {
          socketPath: "/var/run/docker.sock",
          exists: true,
          readable: true,
        },
        stateStore: {
          path: "/tmp/state",
          exists: true,
          readable: true,
        },
      };
      seen.push(inputs);
      return inputs;
    });
    expect(report.components.every((c) => c.status === "ready")).toBe(true);
    const payload = JSON.stringify(seen);
    // Boolean flag field names may include "PrivateKey"; values must stay non-secret.
    expect(payload).not.toMatch(/sk-|BEGIN |token=|api_key=/i);
    expect(seen[0]).toEqual({
      demoMode: false,
      checkedAt,
      provider: { hasCredential: true, providerName: "kimi" },
      githubApp: {
        hasAppId: true,
        hasInlinePrivateKey: true,
        hasPrivateKeyPath: false,
      },
      docker: {
        socketPath: "/var/run/docker.sock",
        exists: true,
        readable: true,
      },
      stateStore: {
        path: "/tmp/state",
        exists: true,
        readable: true,
      },
    });
  });
});
