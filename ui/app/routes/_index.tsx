import { OperatorConsole } from "@/components/operator/OperatorConsole";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [
    { title: `${APP_TITLE} — GitHub issue operator` },
    {
      name: "description",
      content:
        "Run, verify, and publish GitHub issue fixes from a local agent-native console.",
    },
  ];
}

export default function OperatorRoute() {
  return <OperatorConsole />;
}
