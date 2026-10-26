import { writeTool } from "../lib/files";

// The main agent writes only the requirement specs and the final report.
export default writeTool(/^(specs\/[a-z0-9-]+\.md|report\.md)$/, "specs/<id>.md or report.md");
