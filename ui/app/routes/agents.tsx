import { AgentManagementConsole } from "@/components/operator/AgentManagementConsole";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [
    { title: `Agents - ${APP_TITLE}` },
    {
      name: "description",
      content:
        "Create, validate, and explicitly enable revision-pinned Shipwright agents.",
    },
  ];
}

export default function AgentsRoute() {
  return <AgentManagementConsole />;
}
