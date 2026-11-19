export const MIC_NOISE_GATE = 0.06;

export function nextLevel(previous: number, volume: number, gate: number) {
  const target = Math.min(1, Math.max(0, (volume - gate) / (1 - gate)) * 2.5);
  return previous + (target - previous) * (target > previous ? 0.3 : 0.06);
}

type Voice = { volume: () => number; color: string; gate: number };

export function drawCallWaves(canvas: HTMLCanvasElement, voices: Voice[], onSpeaking?: (speaking: boolean) => void) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const levels = voices.map(() => 0);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let you = false;
  let frame = 0;
  const draw = (time: number) => {
    const dpr = devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    ctx.clearRect(0, 0, width, height);
    const t = still ? 0 : time / 1000;
    const floor = height;
    voices.forEach((voice, v) => {
      levels[v] = nextLevel(levels[v], voice.volume(), voice.gate);
      const level = levels[v];
      const rise = (10 + level * 120) * dpr;
      const centre = 0.5 + (v ? 0.06 : -0.06) * Math.sin(t * 0.3 + v);
      ctx.beginPath();
      ctx.moveTo(0, floor);
      for (let x = 0; x <= width; x += 6 * dpr) {
        const p = x / width;
        const mound = 0.3 + 0.7 * Math.exp(-(((p - centre) / 0.3) ** 2));
        const swell = 1 + 0.2 * Math.sin(p * Math.PI * 2.6 + t * 0.9 + v * 2) + 0.1 * Math.sin(p * Math.PI * 5.4 - t * 1.3);
        ctx.lineTo(x, floor - rise * mound * swell);
      }
      ctx.lineTo(width, floor);
      ctx.closePath();
      const glow = ctx.createLinearGradient(0, floor - rise * 1.3, 0, floor);
      glow.addColorStop(0, "transparent");
      glow.addColorStop(0.55, voice.color);
      glow.addColorStop(1, voice.color);
      ctx.fillStyle = glow;
      ctx.globalAlpha = 0.14 + level * 0.5;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    const speakingNow = levels[1] > (you ? 0.05 : 0.15);
    if (speakingNow !== you) onSpeaking?.((you = speakingNow));
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}
