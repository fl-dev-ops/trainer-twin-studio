export const PROTOCOL_VERSION = 1;

export type WidgetMessage =
  | { source: "trainertwin-widget"; version: 1; type: "ready" }
  | { source: "trainertwin-widget"; version: 1; type: "close" }
  | { source: "trainertwin-widget"; version: 1; type: "interaction"; editing: boolean }
  | { source: "trainertwin-widget"; version: 1; type: "status"; active: boolean };

export type HostMessage = {
  source: "trainertwin-host";
  version: 1;
  type: "init" | "destroy";
};

export function isWidgetMessage(value: unknown): value is WidgetMessage {
  if (!value || typeof value !== "object") return false;
  if (!("source" in value) || value.source !== "trainertwin-widget") return false;
  if (!("version" in value) || value.version !== PROTOCOL_VERSION) return false;
  if (!("type" in value)) return false;
  if (value.type === "ready" || value.type === "close") return true;
  if (value.type === "interaction") return "editing" in value && typeof value.editing === "boolean";
  return value.type === "status" && "active" in value && typeof value.active === "boolean";
}

export function isHostMessage(value: unknown): value is HostMessage {
  return !!value && typeof value === "object"
    && "source" in value && value.source === "trainertwin-host"
    && "version" in value && value.version === PROTOCOL_VERSION
    && "type" in value && (value.type === "init" || value.type === "destroy");
}

export function httpOrigin(input: string): string {
  const url = new URL(input);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("TrainerTwin widgets require an HTTP(S) URL without credentials.");
  }
  return url.origin;
}

export function embedUrl(scriptSrc: string, twinId: string, parentOrigin: string): URL {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(twinId)) {
    throw new Error("TrainerTwin requires a valid data-twin-id.");
  }
  if (httpOrigin(parentOrigin) !== parentOrigin) {
    throw new Error("TrainerTwin requires an exact parent origin.");
  }
  const url = new URL(`/embed/${encodeURIComponent(twinId)}`, httpOrigin(scriptSrc));
  url.searchParams.set("parentOrigin", parentOrigin);
  return url;
}
