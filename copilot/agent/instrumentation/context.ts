import { otelIntegration } from "eve/instrumentation/otel";

/** Exposes org/user on each model call's runtimeContext; read by ./usage.ts. No exporter configured. */
export default otelIntegration({
  runtimeContext(input) {
    const attributes = input.session.auth.current?.attributes ?? {};
    if (typeof attributes.orgId !== "string") return undefined;
    return {
      "trainertwin.org.id": attributes.orgId,
      ...(typeof attributes.userId === "string" ? { "trainertwin.user.id": attributes.userId } : {}),
    };
  },
});
