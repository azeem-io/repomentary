import { notFound } from "next/navigation";
import InsightsView from "@/components/InsightsView";
import { REPO_DATASETS } from "@/lib/realHistory";

export function generateStaticParams() {
  return REPO_DATASETS.map((d) => ({ id: d.id }));
}

export const dynamicParams = false;

export default async function InsightsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!REPO_DATASETS.some((d) => d.id === id)) notFound();
  return <InsightsView id={id} />;
}
