import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  "Highlight one exact visible component label on the candidate's whiteboard, then ask one targeted follow-up about that component's responsibility, connection, bottleneck, failure mode, scale, or trade-off. Only call when the whiteboard diagram is relevant to the active system-design question. Never call to highlight components of an off-topic or irrelevant diagram. The label must match text the candidate actually wrote on the whiteboard; never invent a label.",
  z.object({ component_label: z.string().trim().min(1) }),
);
