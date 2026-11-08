"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// This host's home page: on an org's learner host, the org's home page (its twins and role plays), not trainertwin.com.
const HOME = "/";

export function HomeRedirect({ delaySec = 5 }: { delaySec?: number }) {
  const router = useRouter();
  const [left, setLeft] = useState(delaySec);

  useEffect(() => {
    const started = Date.now();
    const tick = window.setInterval(() => {
      const remaining = Math.max(0, delaySec - Math.floor((Date.now() - started) / 1000));
      setLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(tick);
        router.push(HOME);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [delaySec, router]);

  return (
    <p className="text-sm text-muted-foreground">
      Back to the home page in {left}s…
    </p>
  );
}
