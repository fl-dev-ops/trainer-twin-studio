type PickerDoc = { id: string; name: string };
type PickerResponse = { action: string; docs?: PickerDoc[] };
type Picker = { setVisible(visible: boolean): void; dispose(): void };
type PickerBuilder = {
  setAppId(id: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  addView(view: string): PickerBuilder;
  build(): Picker;
};

declare global {
  interface Window {
    gapi?: { load(name: string, options: { callback(): void; onerror(): void; timeout: number; ontimeout(): void }): void };
    google?: { picker?: { PickerBuilder: new () => PickerBuilder; Feature: { MULTISELECT_ENABLED: string }; ViewId: { DOCS: string } } };
  }
}

let loading: Promise<void> | undefined;
function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const load = () => {
      if (!window.gapi) return reject(new Error("Google picker could not load. Try again."));
      window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google picker could not load.")), timeout: 15_000, ontimeout: () => reject(new Error("Google picker timed out. Try again.")) });
    };
    if (window.gapi) return load();
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = load;
    script.onerror = () => { script.remove(); reject(new Error("Google picker was blocked. Check your connection or browser extensions.")); };
    document.head.appendChild(script);
  }).catch((error) => { loading = undefined; throw error; });
  return loading;
}

/** Google's picker grants drive.file access to only the selected files. Tokens stay in memory, not localStorage. */
export async function chooseDriveFiles(config: { accessToken: string; apiKey: string; appId: string }, onOpen: () => void) {
  await loadPicker();
  const api = window.google!.picker!;
  return new Promise<PickerDoc[]>((resolve) => {
    const picker = new api.PickerBuilder()
      .setAppId(config.appId).setDeveloperKey(config.apiKey).setOAuthToken(config.accessToken)
      .setOrigin(window.location.origin).enableFeature(api.Feature.MULTISELECT_ENABLED).addView(api.ViewId.DOCS)
      .setCallback((data) => {
        if (data.action !== "picked" && data.action !== "cancel") return;
        picker.dispose();
        resolve(data.action === "picked" ? data.docs ?? [] : []);
      }).build();
    onOpen();
    picker.setVisible(true);
  });
}
