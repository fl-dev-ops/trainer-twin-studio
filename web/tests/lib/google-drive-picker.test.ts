import { afterEach, expect, test } from "bun:test";
import { chooseDriveFiles } from "@/lib/google-drive-picker";

const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "window", previous);
  else Reflect.deleteProperty(globalThis, "window");
});

for (const action of ["picked", "cancel"]) {
  test(`Google picker handles ${action}, multi-select and disposal`, async () => {
    const settings: Record<string, unknown> = {};
    let callback: (data: { action: string; docs?: { id: string; name: string }[] }) => void;
    let disposed = false;
    class Builder {
      setAppId(value: string) { settings.appId = value; return this; }
      setDeveloperKey(value: string) { settings.apiKey = value; return this; }
      setOAuthToken(value: string) { settings.token = value; return this; }
      setOrigin(value: string) { settings.origin = value; return this; }
      enableFeature(value: string) { settings.feature = value; return this; }
      addView(value: string) { settings.view = value; return this; }
      setCallback(value: typeof callback) { callback = value; return this; }
      build() {
        return {
          setVisible: () => callback({ action, docs: [{ id: "one", name: "First" }, { id: "two", name: "Second" }] }),
          dispose: () => { disposed = true; },
        };
      }
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { origin: "https://dash.test" },
      google: { picker: { PickerBuilder: Builder, Feature: { MULTISELECT_ENABLED: "multi" }, ViewId: { DOCS: "docs" } } },
    } });
    let opened = false;
    const files = await chooseDriveFiles({ accessToken: "short-lived-token", apiKey: "browser-key", appId: "123" }, () => { opened = true; });
    expect(opened).toBe(true);
    expect(disposed).toBe(true);
    expect(settings).toEqual({ appId: "123", apiKey: "browser-key", token: "short-lived-token", origin: "https://dash.test", feature: "multi", view: "docs" });
    expect(files).toEqual(action === "picked" ? [{ id: "one", name: "First" }, { id: "two", name: "Second" }] : []);
  });
}
