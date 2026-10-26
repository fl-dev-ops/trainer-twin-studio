import { TwinEditPage } from "@/components/twin/twin-edit-page";

export default async function TwinAssignRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TwinEditPage id={id} />;
}
