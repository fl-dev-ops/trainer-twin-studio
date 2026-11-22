import { expect, test } from "bun:test";
import { handlePresentationRpc, type PresentationRpcContext } from "@/lib/presentation-rpc";

function viewer() {
  let index = 0;
  let zoom = 100;
  const controller = {
    isReady: () => true,
    getSlideIndex: () => index,
    getZoom: () => zoom,
    goToSlide: async (next: number) => { setTimeout(() => { index = next; }, 10); },
  } as NonNullable<PresentationRpcContext["controller"]>;
  const context: PresentationRpcContext = {
    controller, presentation: null, fileName: "test.pptx", slideCount: 2, warningCount: 0, showThumbnails: true,
    setShowThumbnails: () => {}, setZoom: async (next) => { setTimeout(() => { zoom = next; }, 10); },
  };
  return (action: string, payload: object = {}) => handlePresentationRpc(JSON.stringify({ action, payload }), context).then(JSON.parse);
}

test("navigation acknowledges the updated viewer index, not the controller's early promise", async () => {
  const run = viewer();
  expect(await run("go_to_slide", { slideNumber: 2 })).toMatchObject({ ok: true, result: { slideIndex: 1, slideNumber: 2 } });
  expect(await run("previous")).toMatchObject({ result: { slideIndex: 0 } });
  expect(await run("next")).toMatchObject({ result: { slideIndex: 1 } });
  expect(await run("next")).toMatchObject({ result: { slideIndex: 1 } });
});

test("zoom waits for the visible viewer value", async () => {
  expect(await viewer()("set_zoom", { percent: 150 })).toMatchObject({ ok: true, result: { zoom: 150 } });
});

test("invalid navigation is refused without moving the viewer", async () => {
  const run = viewer();
  await expect(run("go_to_slide", { slideNumber: 0 })).rejects.toThrow("Slide number");
  await expect(run("go_to_slide", { slideNumber: 3 })).rejects.toThrow("Slide number");
  expect(await run("get_state")).toMatchObject({ result: { slideIndex: 0 } });
});
