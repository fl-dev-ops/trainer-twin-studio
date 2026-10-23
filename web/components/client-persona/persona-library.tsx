import Link from "next/link";
import { Plus, UserRoundCog } from "lucide-react";
import { VoicePlayButton } from "@/components/client-persona/voice-play-button";
import { Button } from "@/components/ui/button";
import { formFromPersonaData, speakingTags } from "@/lib/client-persona";
import type { PersonaVoiceOption } from "@/lib/client-persona-data";

export type LibraryPersona = { slug: string; data: unknown };

function Tags({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground/80">{item}</span>
      ))}
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <p className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{children}</p>;
}

/** Client personas as cards: photo, role, behaviour, speaking style and voice. */
export function PersonaLibrary({ personas, voices }: { personas: LibraryPersona[]; voices: PersonaVoiceOption[] }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="flex items-center gap-2.5 text-base font-medium">
          <UserRoundCog className="size-5 text-muted-foreground" aria-hidden /> Persona
        </h1>
        <Button className="h-10 rounded-full px-5" nativeButton={false} render={<Link href="/personas/new" />}>
          <Plus data-icon="inline-start" /> Create persona
        </Button>
      </header>

      <section className="mt-9 flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-[-0.01em]">Real estate sales personas</h2>
        <p className="text-sm text-muted-foreground">Practise sales conversations with clients in real estate. Pick a default, or create your own.</p>
      </section>

      {personas.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed px-6 py-16 text-center">
          <p className="text-sm font-medium">No personas yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Create the first person your learners will speak with.</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {personas.map(({ slug, data }) => {
            const form = formFromPersonaData(data);
            const avatar = (data as { avatar?: unknown })?.avatar;
            const voice = voices.find((item) => item.id === form.voiceId);
            return (
              <Link
                key={slug}
                href={`/personas/${encodeURIComponent(slug)}`}
                className="relative flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-2xs transition-shadow hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="absolute top-4 right-4 rounded-full border bg-background px-3 py-1 text-xs">{form.role}</span>
                {typeof avatar === "string" && avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element -- persona photos are static or uploaded URLs
                  <img src={avatar} alt="" className="size-[72px] rounded-full object-cover" />
                ) : (
                  <span className="grid size-[72px] place-items-center rounded-full bg-muted text-2xl font-semibold">{form.name.charAt(0)}</span>
                )}
                <h3 className="text-xl font-semibold tracking-[-0.01em]">{form.name}</h3>
                <div className="flex flex-col gap-2"><Label>Behaviour</Label><Tags items={form.behaviours.length ? form.behaviours : ["Not set"]} /></div>
                <div className="flex flex-col gap-2"><Label>Speaking</Label><Tags items={speakingTags(form)} /></div>
                {voice ? (
                  <div className="flex flex-col gap-1.5">
                    <Label>Voice</Label>
                    <span className="flex items-center gap-1.5 text-[15px]">{voice.name}<VoicePlayButton voiceId={voice.id} name={voice.name} /></span>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
