/** The copilot panel's remembered state (components/copilot/panel.tsx), read by app/dash/layout.tsx on the server. */
export const COPILOT_OPEN_COOKIE = "copilot_panel";
export const COPILOT_WIDTH_COOKIE = "copilot_panel_width";
export const COPILOT_LAYOUT_COOKIE = "copilot_layout";

/** Docked beside the page (it pushes the page over), or floating over it from the corner. */
export type CopilotLayout = "docked" | "floating";
export const isCopilotLayout = (value: unknown): value is CopilotLayout => value === "docked" || value === "floating";
