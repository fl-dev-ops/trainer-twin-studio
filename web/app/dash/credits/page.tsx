import { redirect } from "next/navigation";

/** The Credits page became Usage; old links (e.g. "credits added" emails) land there. */
export default function CreditsRoute() {
  redirect("/usage");
}
