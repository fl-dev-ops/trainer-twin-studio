import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// The copilot's shell/file tools are disabled; it only needs a filesystem for attachments.
export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
