import { writeTool } from "../lib/files";

// The only write into the sandbox: the requirement spec and the final report. Build tools write everything else.
export default writeTool(/^(specs\/[a-z0-9-]+\.md|report\.md)$/, "specs/<id>.md or report.md");
