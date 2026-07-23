import { createRoot } from "react-dom/client";
import { createElement, useState } from "react";

import type { HostReadinessReport } from "../../../shared/host-readiness";
import { HostReadinessPanel } from "./HostReadinessPanel";

const baseReport: HostReadinessReport = {
  demoMode: true,
  checkedAt: "2026-07-20T12:00:00.000Z",
  blocksLiveStart: false,
  components: [
    {
      id: "provider",
      status: "not_configured",
      code: "provider_missing",
      checkedAt: "2026-07-20T12:00:00.000Z",
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

function Harness() {
  const [refreshCount, setRefreshCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState(baseReport);

  return createElement(
    "div",
    null,
    createElement(HostReadinessPanel, {
      report,
      loading: false,
      refreshing,
      onRefresh: () => {
        setRefreshing(true);
        setRefreshCount((count) => count + 1);
        // Simulate refetch completing with a new checkedAt (console refetch contract).
        setReport({
          ...baseReport,
          checkedAt: "2026-07-20T12:05:00.000Z",
          demoMode: true,
        });
        setRefreshing(false);
      },
    }),
    createElement(
      "div",
      {
        "data-testid": "refresh-count",
      },
      String(refreshCount),
    ),
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(createElement(Harness));
