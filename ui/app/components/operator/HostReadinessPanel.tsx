import { IconLoader2 } from "@tabler/icons-react";

import {
  labelForReadinessCode,
  type HostReadinessReport,
  type HostReadinessStatus,
} from "../../../shared/host-readiness";

function readinessDotClass(status: HostReadinessStatus): string {
  if (status === "ready") return "bg-emerald-500";
  if (status === "not_configured") return "bg-amber-500";
  return "bg-red-500";
}

export function HostReadinessPanel({
  report,
  loading,
  onRefresh,
  refreshing,
}: {
  report?: HostReadinessReport;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/10 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Host readiness</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Non-secret checks only. Ready does not skip start-time authorization.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? <IconLoader2 className="size-3.5 animate-spin" /> : null}
          Refresh
        </button>
      </div>
      {loading && !report ? (
        <p className="mt-3 text-xs text-muted-foreground">Checking host…</p>
      ) : report ? (
        <div className="mt-3 space-y-2">
          {report.demoMode ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Demo mode — live host readiness is advisory; dry-run stays available.
            </p>
          ) : null}
          <ul className="flex flex-wrap gap-2">
            {report.components.map((component) => (
              <li
                key={component.id}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 text-[11px]"
                title={labelForReadinessCode(component.code)}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${readinessDotClass(component.status)}`}
                />
                <span className="font-medium capitalize">
                  {component.id.split("_").join(" ")}
                </span>
                <span className="text-muted-foreground">
                  {component.status.split("_").join(" ")}
                  {component.detail ? ` · ${component.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {report.components.map((component) => (
              <li key={`${component.id}-explain`}>
                <span className="font-medium text-foreground/80">
                  {component.id.split("_").join(" ")}:
                </span>{" "}
                {labelForReadinessCode(component.code)}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted-foreground">
            Checked {new Date(report.checkedAt).toLocaleString()}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Readiness unavailable.
        </p>
      )}
    </div>
  );
}
