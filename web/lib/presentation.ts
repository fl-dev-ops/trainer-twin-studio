export function clampSlideIndex(index: number, slideCount: number) {
  return Math.max(0, Math.min(Math.round(index), Math.max(0, slideCount - 1)));
}

export function nextSlideIndex(
  key: string,
  currentIndex: number,
  slideCount: number,
) {
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(key)) {
    return clampSlideIndex(currentIndex + 1, slideCount);
  }
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(key)) {
    return clampSlideIndex(currentIndex - 1, slideCount);
  }
  if (key === "Home") return 0;
  if (key === "End") return Math.max(0, slideCount - 1);
  return null;
}
