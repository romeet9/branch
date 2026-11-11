import { Studio } from "@/components/studio";
import { readDsConfig } from "@/lib/ds-config";

export default function Home() {
  return <Studio ds={readDsConfig()} />;
}
