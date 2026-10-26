import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox when built and run on Vercel; just-bash locally. Build and runtime share a host in both cases,
// which is what docs/sandbox/troubleshooting requires when the provider is chosen from the host.
export const environment = process.env.VERCEL ? VercelSandbox.environment() : JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
