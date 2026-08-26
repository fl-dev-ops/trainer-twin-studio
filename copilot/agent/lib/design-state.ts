import { defineState } from "eve/context";

export const designState = defineState("trainertwin.spec-design", () => ({
  draftSlug: null as string | null,
}));
