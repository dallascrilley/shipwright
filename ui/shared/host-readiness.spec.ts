import { describe, expect, test } from "vitest";

import {
  buildHostReadinessReport,
  labelForReadinessCode,
  resolveBlocksLiveStart,
  type HostReadinessComponent,
} from "./host-readiness";

function component(
  overrides: Partial<HostReadinessComponent> &
    Pick<HostReadinessComponent, "id" | "status" | "code">,
): HostReadinessComponent {
  return {
    checkedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("host readiness contract", () => {
  test("labels are fixed non-secret strings", () => {
    expect(labelForReadinessCode("provider_missing")).toMatch(/provider/i);
    expect(labelForReadinessCode("provider_missing")).not.toMatch(/sk-|key=/i);
  });

  test("demo mode never blocks live start from readiness alone", () => {
    expect(
      resolveBlocksLiveStart(true, [
        component({
          id: "provider",
          status: "not_configured",
          code: "provider_missing",
        }),
      ]),
    ).toBe(false);
  });

  test("live mode blocks when any component is not ready", () => {
    const components = [
      component({
        id: "provider",
        status: "ready",
        code: "provider_configured",
      }),
      component({
        id: "github_app",
        status: "not_configured",
        code: "github_app_missing",
      }),
      component({
        id: "docker",
        status: "ready",
        code: "docker_socket_ready",
      }),
      component({
        id: "state_store",
        status: "ready",
        code: "state_store_ready",
      }),
    ];
    expect(resolveBlocksLiveStart(false, components)).toBe(true);
    expect(
      buildHostReadinessReport({
        demoMode: false,
        checkedAt: "2026-07-20T12:00:00.000Z",
        components,
      }).blocksLiveStart,
    ).toBe(true);
  });

  test("all ready components do not block", () => {
    const components: HostReadinessComponent[] = [
      component({
        id: "provider",
        status: "ready",
        code: "provider_configured",
        detail: "kimi",
      }),
      component({
        id: "github_app",
        status: "ready",
        code: "github_app_configured",
      }),
      component({
        id: "docker",
        status: "ready",
        code: "docker_socket_ready",
      }),
      component({
        id: "state_store",
        status: "ready",
        code: "state_store_ready",
      }),
    ];
    expect(resolveBlocksLiveStart(false, components)).toBe(false);
  });
});
