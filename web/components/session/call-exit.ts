"use client";

import { useEffect } from "react";
import type { Room } from "livekit-client";

/**
 * Leaving the call screen any way but End (Back, a link, the nav, or the page itself going) closes the call's connection, so the voice agent
 * sees the room empty and ends the session (agent.py watch_empty_room). Before, the connection stayed open in the
 * background and the call kept running on the learner's minutes.
 */
export function useEndCallOnLeave(room: Room) {
  useEffect(() => {
    // The page really going (closed, reloaded, another address, after "Leave"), not just asked about: rooms are
    // built with disconnectOnPageLeave off, so a "Leave site?" Cancel keeps the call.
    const leave = () => void room.disconnect().catch(() => {});
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [room]);
}

/**
 * While a call is live, closing or refreshing the tab asks first (the browser's own "Leave site?"; its wording can't
 * be changed). Leaving inside the app needs no prompt: `useEndCallOnLeave` ends the call.
 */
export function useLeaveWarning(live: boolean) {
  useEffect(() => {
    if (!live) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [live]);
}
