import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import type { HostReadinessReport } from "../../../shared/host-readiness";
import { HostReadinessPanel } from "./HostReadinessPanel";

const liveReport: HostReadinessReport = {
  demoMode: false,
  checkedAt: "2026-07-20T12:00:00.000Z",
  blocksLiveStart: false,
  components: [
    {
      id: "provider",
      status: "ready",
      code: "provider_configured",
      checkedAt: "2026-07-20T12:00:00.000Z",
      detail: "kimi",
    },
    {
      id: "github_app",
      status: "ready",
      code: "github_app_configured",
      checkedAt: "2026-07-20T12:00:00.000Z",
    },
    {
      id: "docker",
      status: "ready",
      code: "docker_socket_ready",
      checkedAt: "2026-07-20T12:00:00.000Z",
    },
    {
      id: "state_store",
      status: "ready",
      code: "state_store_ready",
      checkedAt: "2026-07-20T12:00:00.000Z",
    },
  ],
};

const demoReport: HostReadinessReport = {
  ...liveReport,
  demoMode: true,
  blocksLiveStart: false,
  components: [
    {
      id: "provider",
      status: "not_configured",
      code: "provider_missing",
      checkedAt: "2026-07-20T12:00:00.000Z",
    },
    ...liveReport.components.slice(1),
  ],
};

describe("HostReadinessPanel", () => {
  test("renders live component chips and fixed explanations", () => {
    const html = renderToStaticMarkup(
      createElement(HostReadinessPanel, {
        report: liveReport,
        loading: false,
        refreshing: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toContain("Host readiness");
    expect(html).toContain("provider");
    expect(html).toContain("kimi");
    expect(html).toContain("github app");
    expect(html).toContain("docker");
    expect(html).toContain("state store");
    expect(html).toContain("Model provider credentials are configured");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("sk-");
    expect(html).not.toContain("BEGIN ");
  });

  test("renders demo advisory copy", () => {
    const html = renderToStaticMarkup(
      createElement(HostReadinessPanel, {
        report: demoReport,
        loading: false,
        refreshing: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toContain("Demo mode");
    expect(html).toContain("advisory");
    expect(html).toContain("dry-run stays available");
  });

  test("shows loading state before first report", () => {
    const html = renderToStaticMarkup(
      createElement(HostReadinessPanel, {
        loading: true,
        refreshing: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toContain("Checking host");
  });

  test("refresh control is enabled and wired to onRefresh prop", () => {
    const onRefresh = vi.fn();
    const element = createElement(HostReadinessPanel, {
      report: liveReport,
      loading: false,
      refreshing: false,
      onRefresh,
    });
    expect(element.props.onRefresh).toBe(onRefresh);
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Refresh");
    // className may include Tailwind "disabled:" variants; assert attribute absence.
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled(?:=|>|\s)/i);
  });

  test("refreshing disables the refresh control", () => {
    const html = renderToStaticMarkup(
      createElement(HostReadinessPanel, {
        report: liveReport,
        loading: false,
        refreshing: true,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toMatch(/<button\b[^>]*\sdisabled(?:=|>|\s)/i);
  });
});
