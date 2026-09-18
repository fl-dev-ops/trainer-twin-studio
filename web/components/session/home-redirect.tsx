"use client";

import { useEffect, useState } from "react";

const HOME = "https://www.trainertwin.com";

export function HomeRedirect({ delaySec = 5 }: { delaySec?: number }) {
  const [left, setLeft] = useState(delaySec);

  useEffect(() => {
    const started = Date.now();
    const tick = window.setInterval(() => {
      const remaining = Math.max(0, delaySec - Math.floor((Date.now() - started) / 1000));
      setLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(tick);
        window.location.assign(HOME);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [delaySec]);

  return (
    <p className="text-sm text-muted-foreground">
      Redirecting to trainertwin.com in {left}s…
    </p>
  );
}
