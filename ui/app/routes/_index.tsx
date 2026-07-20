import { OperatorConsole } from "@/components/operator/OperatorConsole";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [
    { title: `${APP_TITLE} — GitHub issue operator` },
    {
      name: "description",
      content:
        "Run, verify, and publish GitHub issue fixes from the private Shipwright operator console.",
    },
  ];
}

export default function OperatorRoute() {
  return <OperatorConsole />;
}
