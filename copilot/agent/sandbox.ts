import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// The copilot's shell/file tools are disabled; it only needs a filesystem for attachments.
export default defineSandbox({
  backend: justbash({ autoInstall: false }),
});
