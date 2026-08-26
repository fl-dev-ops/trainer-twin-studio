import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Learner portal: public agents for the org that owns this subdomain. */
export default async function LearnerHome() {
  const host = (await headers()).get("host") ?? "";
  const slug = host.split(":")[0].split(".")[0];
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });
  if (!org) redirect("/auth/sign-in");

  // Signed-in learners skip the catalog gate; anonymous visitors can browse too.
  const agents = await db.agent.findMany({
    where: { orgId: org.id, visibility: "public" },
    orderBy: { name: "asc" },
    select: { slug: true, name: true, version: true },
  });

  return (
    <main className="min-h-svh">
      <header className="border-b px-6 py-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-muted-foreground mt-2">Pick an agent and start practicing.</p>
      </header>
      <section className="mx-auto grid max-w-3xl gap-4 p-6 sm:grid-cols-2">
        {agents.length === 0 ? (
          <p className="text-muted-foreground col-span-full py-16 text-center">
            No agents are available yet — check back soon.
          </p>
        ) : (
          agents.map((agent) => (
            <article
              key={agent.slug}
              className="rounded-xl border p-5 transition-shadow hover:shadow-md"
            >
              <h2 className="text-lg font-semibold">{agent.name}</h2>
              <p className="text-muted-foreground mt-1 text-sm">Practice interview · v{agent.version}</p>
              <a
                href={`/session/${agent.slug}`}
                className="text-primary mt-4 inline-block text-sm font-medium underline-offset-4 hover:underline"
              >
                Start session →
              </a>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
