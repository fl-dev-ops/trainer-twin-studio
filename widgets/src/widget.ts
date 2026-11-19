import { createAudioAnalyser, Room, RoomEvent, Track, type Participant, type RemoteAudioTrack, type RemoteTrack, type TranscriptionSegment } from "livekit-client";
import { createElement, createRef, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Caption, WidgetPhase } from "./widget-call";
import { WidgetView, type AgentState, type WidgetRefs } from "./widget-view";
import "./widget.css";
import { isHostMessage, MAX_WIDGET_HEIGHT, MIN_WIDGET_HEIGHT } from "./protocol";
import { drawCallWaves, MIC_NOISE_GATE } from "../../shared/call-waves";

type Config = {
  mode: "floating";
  agentId: string;
  parentOrigin: string;
  name: string;
  trainerName: string;
  photoUrl: string | null;
  welcome: string;
  accentColor: string;
  maxSeconds: number;
  livekitUrl: string;
};
type EndCapability = { id: string; embedToken: string };
type Session = EndCapability & { secondsLeft: number; endsAt?: number; serverTime?: number };
export type WidgetPreview = { phase: WidgetPhase; agentState?: AgentState; reconnecting?: boolean; muted?: boolean; urgent?: boolean; name?: string; embedded?: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function urlWithProtocol(value: unknown, protocols: string[]): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function parseConfig(value: unknown): Config {
  if (!record(value) || !bounded(value.agentId, 128) || !/^[a-zA-Z0-9_-]+$/.test(value.agentId)
    || (value.mode !== undefined && value.mode !== "floating")
    || !bounded(value.name, 160) || !bounded(value.trainerName, 160) || !bounded(value.welcome, 120)
    || typeof value.accentColor !== "string" || !/^#[a-f0-9]{6}$/i.test(value.accentColor)
    || typeof value.maxSeconds !== "number" || !Number.isInteger(value.maxSeconds) || value.maxSeconds < 1 || value.maxSeconds > 3600) {
    throw new Error("This voice widget is not configured correctly.");
  }
  const origin = urlWithProtocol(value.parentOrigin, ["https:", "http:"]);
  const livekitUrl = urlWithProtocol(value.livekitUrl, ["wss:", "ws:"]);
  if (!origin || new URL(origin).origin !== value.parentOrigin || !livekitUrl) {
    throw new Error("This voice widget has an invalid connection configuration.");
  }
  return {
    mode: "floating",
    agentId: value.agentId, parentOrigin: new URL(origin).origin, name: value.name,
    trainerName: value.trainerName, welcome: value.welcome, accentColor: value.accentColor,
    photoUrl: urlWithProtocol(value.photoUrl, ["https:", "http:"]), maxSeconds: value.maxSeconds, livekitUrl,
  };
}

export function visitorName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("Enter your name using 1–80 characters, without control characters.");
  }
  return name;
}

export function parseSession(value: unknown): { session: Session; participantToken: string } {
  if (!record(value) || !record(value.session) || !bounded(value.session.id, 128)
    || !bounded(value.session.embedToken, 8192) || !bounded(value.participantToken, 16384)
    || typeof value.session.secondsLeft !== "number" || !Number.isFinite(value.session.secondsLeft)
    || value.session.secondsLeft <= 0 || value.session.secondsLeft > 3600
    || (value.session.endsAt !== undefined && (typeof value.session.endsAt !== "number" || !Number.isSafeInteger(value.session.endsAt) || value.session.endsAt <= 0))
    || (value.session.serverTime !== undefined && (typeof value.session.serverTime !== "number" || !Number.isSafeInteger(value.session.serverTime) || value.session.serverTime <= 0))) {
    throw new Error("The call service returned an invalid connection. Please try again.");
  }
  return {
    session: { id: value.session.id, embedToken: value.session.embedToken, secondsLeft: value.session.secondsLeft,
      ...(typeof value.session.endsAt === "number" ? { endsAt: value.session.endsAt } : {}),
      ...(typeof value.session.serverTime === "number" ? { serverTime: value.session.serverTime } : {}) },
    participantToken: value.participantToken,
  };
}

export function remainingCallMs(session: Pick<Session, "secondsLeft" | "endsAt" | "serverTime">, maxSeconds: number) {
  const serverRemaining = session.endsAt !== undefined && session.serverTime !== undefined ? session.endsAt - session.serverTime : session.secondsLeft * 1000;
  return Math.max(0, Math.min(session.secondsLeft * 1000, serverRemaining, maxSeconds * 1000));
}

class WidgetRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === "widget_token_invalid" ? "This widget connection expired. Please start again."
      : code === "public_call_limit" ? "Too many calls have been started. Please try again later."
      : code === "public_call_busy" ? "A call is already running. Please try again after it ends."
      : code === "widget_unavailable" ? "This twin is not available on this website."
      : "The call is unavailable right now. Please try again later.");
  }
}

function mediaError(failure: unknown): string {
  if (failure instanceof Error) {
    if (failure.name === "NotAllowedError" || failure.name === "SecurityError") {
      return "Microphone access is blocked. Allow microphone access in your browser and ask the website owner to enable microphone permission for this widget.";
    }
    if (failure.name === "NotFoundError") return "No microphone was found. Connect a microphone, then try again.";
    if (failure.name === "NotReadableError") return "Your microphone is unavailable. Close other apps using it, then try again.";
    return failure.message;
  }
  return "Could not start the voice call. Please try again.";
}

export function callStartError(failure: unknown): string {
  if (failure instanceof WidgetRequestError) return failure.message;
  if (failure instanceof Error && ["NotAllowedError", "SecurityError", "NotFoundError", "NotReadableError"].includes(failure.name)) return mediaError(failure);
  return "Please try again in a little while.";
}

export function mount(root: HTMLElement, config: Config, preview?: WidgetPreview) {
  let phase: WidgetPhase = "ready";
  let agentState: AgentState = "listening";
  let initialized = false;
  let destroyed = false;
  let starting = false;
  let finishing = false;
  let generation = 0;
  let room: Room | null = null;
  let session: EndCapability | null = null;
  let bootstrapAbort: AbortController | null = null;
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let muted = false;
  let reconnecting = false;
  let mutePending = false;
  let connected = false;
  let finishMessage: string | undefined;
  let errorMessage: string | undefined;
  let nameInvalid = false;
  let visible = false;
  let intro = !preview || !!preview.embedded;
  let seconds = config.maxSeconds;
  let focusTarget: "intro" | "name" | "error" | "retry" | "end" | undefined;
  let visitorToken: string | undefined;
  let savedName = preview?.name;
  let editingName = false;
  let storageAvailable = true;
  const scope = `${config.agentId}:${config.parentOrigin}`;
  const tokenKey = `trainertwin-widget:visitor:${scope}`;
  const nameKey = `trainertwin-widget:name:${scope}`;
  const captions = new Map<string, Caption>();
  const attachedTracks = new Set<RemoteTrack>();

  const post = (type: "ready" | "close" | "status" | "interaction", active?: boolean) => {
    if (window.parent !== window) {
      window.parent.postMessage({
        source: "trainertwin-widget", version: 1, type,
        ...(type === "ready" ? { intro: true } : {}),
        ...(type === "status" ? { active: active === true } : {}),
        ...(type === "interaction" ? { editing: active === true } : {}),
      }, config.parentOrigin);
    }
  };

  const elements: WidgetRefs = {
    card: createRef(), body: createRef(), portrait: createRef(), waves: createRef(), intro: createRef(),
    controls: createRef(), name: createRef(), end: createRef(), retry: createRef(), error: createRef(),
  };
  const view = createRoot(root);
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(config.accentColor.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  const theme: CSSProperties & Record<`--tt-${string}`, string> = {
    "--tt-accent": config.accentColor,
    "--tt-action": luminance < .04 ? "#f2eee5" : config.accentColor,
    "--tt-on-accent": luminance < .04 || luminance > .179 ? "#111111" : "#ffffff",
  };
  let reportedHeight = 0;
  function reportSize() {
    const card = elements.card.current;
    const portrait = elements.portrait.current;
    if (!card || !portrait || (preview && !preview.embedded) || !initialized || destroyed || window.parent === window) return;
    const chromeHeight = card.offsetHeight - portrait.offsetHeight;
    const squareHeight = portrait.offsetWidth;
    if (squareHeight) portrait.style.height = `${Math.max(0, Math.min(squareHeight, innerHeight - chromeHeight))}px`;
    const natural = !intro && needsName() ? 480 : chromeHeight + squareHeight;
    const height = Math.max(MIN_WIDGET_HEIGHT, Math.min(MAX_WIDGET_HEIGHT, Math.ceil(natural)));
    if (height === reportedHeight) return;
    reportedHeight = height;
    window.parent.postMessage({ source: "trainertwin-widget", version: 1, type: "resize", height }, config.parentOrigin);
  }
  const sizeObserver = new ResizeObserver(reportSize);
  const audioContainer = document.getElementById("trainertwin-audio") ?? document.createElement("div");
  audioContainer.hidden = true;
  const ownsAudioContainer = !audioContainer.isConnected;
  if (ownsAudioContainer) root.after(audioContainer);
  let stopWaves: (() => void) | undefined;
  function updateWaves() {
    stopWaves?.();
    stopWaves = undefined;
    const waves = elements.waves.current;
    if (!room || !waves || phase !== "live") return;
    const tracks = [
      [...attachedTracks].find((track): track is RemoteAudioTrack => track.kind === Track.Kind.Audio),
      room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack,
    ];
    const analysers = tracks.map((track) => track ? createAudioAnalyser(track) : undefined);
    let observing = true;
    for (const analyser of analysers) {
      if (analyser?.analyser.context instanceof AudioContext && analyser.analyser.context.state === "suspended") {
        void analyser.analyser.context.resume().catch((failure: unknown) => {
          if (observing) showError(mediaError(failure));
        });
      }
    }
    const stop = drawCallWaves(waves, tracks.map((track, index) => ({
      color: index === 0 ? "#16a34a" : "#ff5a00",
      gate: index === 0 ? 0.02 : MIC_NOISE_GATE,
      volume: () => track?.isMuted ? 0 : (analysers[index]?.calculateVolume() ?? 0),
    })));
    stopWaves = () => {
      observing = false;
      stop();
      for (const analyser of analysers) void analyser?.cleanup();
    };
  }

  function clearError() {
    errorMessage = undefined;
    nameInvalid = false;
  }

  function showError(message: string, invalidName = false) {
    if (destroyed) return;
    errorMessage = message;
    nameInvalid = invalidName;
    focusTarget = invalidName ? "name" : "error";
    render();
  }

  function needsName() {
    return phase === "ready" && (!savedName || editingName);
  }

  function onCommit() {
    reportSize();
    if (!focusTarget) return;
    const target = elements[focusTarget].current;
    if (target instanceof HTMLButtonElement && target.disabled) return;
    target?.focus();
    if (target instanceof HTMLInputElement && editingName && !nameInvalid) target.select();
    focusTarget = undefined;
  }

  function changeName() {
    intro = false;
    phase = "ready";
    editingName = true;
    clearError();
    focusTarget = "name";
    flushSync(render);
  }

  function retry() {
    if (starting || finishing || destroyed) return;
    phase = "ready";
    if (savedName && !editingName) void beginCall();
    else {
      clearError();
      focusTarget = "name";
      render();
    }
  }

  function openIntro() {
    if (!initialized || starting || finishing) return;
    intro = false;
    clearError();
    if (savedName && !editingName) void beginCall();
    else {
      focusTarget = "name";
      flushSync(render);
    }
  }

  function render() {
    if (destroyed) return;
    view.render(createElement(WidgetView, {
      name: config.name, theme, stage: intro ? "intro" : needsName() ? "name" : "call",
      agentState, visible, draftName: savedName, errorMessage, nameInvalid,
      call: {
        elements, phase, trainer: config.trainerName, photoUrl: config.photoUrl, welcome: config.welcome,
        seconds, muted, reconnecting, mutePending, finishMessage, hasName: !!savedName,
        captions: [...captions.values()], canStart: initialized && !starting && !finishing,
        dismissible: !preview || !!preview.embedded, playbackBlocked: phase === "live" && room?.canPlaybackAudio === false,
        onDismiss: dismiss, onRetry: retry, onChangeName: changeName, onMute: toggleMute, onEnd: endCall,
      },
      onCommit, onOpen: openIntro, onStart: beginCall, onNameInput: nameInput, onUnlockAudio: unlockAudio,
    }));
  }

  function readName() {
    try {
      const value = localStorage.getItem(nameKey);
      if (bounded(value, 80)) savedName = visitorName(value);
    } catch (failure) {
      if (!(failure instanceof DOMException) || failure.name !== "SecurityError") throw failure;
    }
  }

  function rememberName(value: string) {
    savedName = value;
    editingName = false;
    if (preview) return;
    try {
      localStorage.setItem(nameKey, value);
    } catch (failure) {
      if (!(failure instanceof DOMException) || !["SecurityError", "QuotaExceededError"].includes(failure.name)) throw failure;
    }
  }

  function readVisitorToken() {
    if (!storageAvailable) return visitorToken;
    try {
      const saved = localStorage.getItem(tokenKey);
      if (bounded(saved, 4096)) visitorToken = saved;
    } catch (failure) {
      if (!(failure instanceof DOMException) || failure.name !== "SecurityError") throw failure;
      storageAvailable = false;
    }
    return visitorToken;
  }

  function saveVisitorToken(token: string) {
    visitorToken = token;
    if (!storageAvailable) return;
    try {
      localStorage.setItem(tokenKey, token);
    } catch (failure) {
      if (!(failure instanceof DOMException) || !["SecurityError", "QuotaExceededError"].includes(failure.name)) throw failure;
      storageAvailable = false;
    }
  }

  function clearVisitorToken() {
    visitorToken = undefined;
    if (!storageAvailable) return;
    try {
      localStorage.removeItem(tokenKey);
    } catch (failure) {
      if (!(failure instanceof DOMException) || failure.name !== "SecurityError") throw failure;
      storageAvailable = false;
    }
  }

  async function request(path: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(path, { ...options, credentials: "omit", cache: "no-store" });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The call service returned an unreadable response. Please try again.");
    }
    if (!response.ok) {
      throw new WidgetRequestError(response.status, record(payload) && typeof payload.code === "string" ? payload.code : "");
    }
    return payload;
  }

  async function closeSession(closing: EndCapability): Promise<string | null> {
    try {
      const response = await fetch(`/api/public/widgets/sessions/${encodeURIComponent(closing.id)}/end`, {
        method: "POST", credentials: "omit", cache: "no-store", keepalive: true,
        headers: { Authorization: `Bearer ${closing.embedToken}` },
      });
      if (!response.ok) return "Could not confirm the call ended. The server will stop it at its time limit.";
      return null;
    } catch {
      return "The connection was lost while ending the call. The server will stop it at its time limit.";
    }
  }

  async function disconnect(closing: Room) {
    stopWaves?.();
    stopWaves = undefined;
    closing.removeAllListeners();
    for (const track of attachedTracks) {
      for (const attached of track.detach()) attached.remove();
    }
    attachedTracks.clear();
    audioContainer.replaceChildren();
    await closing.disconnect();
  }

  async function finish(unloading = false, message?: string) {
    if (finishing) return;
    finishing = true;
    generation++;
    bootstrapAbort?.abort();
    bootstrapAbort = null;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const closingSession = session;
    const closingRoom = room;
    session = null;
    room = null;
    finishMessage = message;
    phase = message && !connected ? "failed" : "ready";
    render();
    const results = await Promise.allSettled([
      closingSession ? closeSession(closingSession) : Promise.resolve(null),
      closingRoom ? disconnect(closingRoom) : Promise.resolve(),
    ]);
    finishing = false;
    if (destroyed || unloading) {
      for (const result of results) {
        if (result.status === "rejected") console.error("Widget call cleanup failed", result.reason);
        else if (typeof result.value === "string") console.error(result.value);
      }
      return;
    }
    const endResult = results[0];
    const disconnectResult = results[1];
    const warning = disconnectResult.status === "rejected" ? "Could not disconnect cleanly. Close this widget to stop microphone access."
      : endResult.status === "fulfilled" ? endResult.value : null;
    post("status", false);
    if (warning) showError(warning);
    else {
      intro = phase === "ready";
      focusTarget = intro ? "intro" : "retry";
      render();
    }
  }

  function tick() {
    const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    if (remaining !== seconds) {
      seconds = remaining;
      render();
    }
    if (remaining === 0) void finish(false, "This call reached its time limit.");
  }

  function setCaption(id: string, value: string, final: boolean, visitor: boolean) {
    captions.set(id, { id, text: value.slice(0, 8000), final, visitor });
  }

  function bindRoom(current: Room) {
    current.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio || current !== room || destroyed) return;
      attachedTracks.add(track);
      const audio = track.attach();
      audioContainer.append(audio);
      updateWaves();
    });
    current.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const audio of track.detach()) audio.remove();
      attachedTracks.delete(track);
      updateWaves();
    });
    current.on(RoomEvent.LocalTrackPublished, updateWaves);
    current.on(RoomEvent.LocalTrackUnpublished, updateWaves);
    current.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], participant?: Participant) => {
      if (current !== room || destroyed) return;
      for (const segment of segments) {
        if (!segment.text.trim()) continue;
        setCaption(`${participant?.identity ?? "agent"}:${segment.id}`, segment.text, segment.final,
          participant?.identity === current.localParticipant.identity);
      }
      while (captions.size > 120) {
        const oldest = captions.entries().next().value;
        if (!oldest) break;
        captions.delete(oldest[0]);
      }
      render();
    });
    const updateAgent = (attributes: Record<string, string>, participant: Participant) => {
      if (participant.identity === current.localParticipant.identity || current !== room) return;
      const state = attributes["lk.agent.state"];
      if (state === "listening" || state === "thinking" || state === "speaking") {
        agentState = state;
        render();
      }
    };
    current.on(RoomEvent.ParticipantAttributesChanged, updateAgent);
    current.on(RoomEvent.ParticipantConnected, (participant) => updateAgent(participant.attributes, participant));
    current.on(RoomEvent.AudioPlaybackStatusChanged, () => render());
    current.on(RoomEvent.Reconnecting, () => {
      if (room === current) { reconnecting = true; render(); }
    });
    current.on(RoomEvent.Reconnected, () => {
      if (room === current) { reconnecting = false; render(); }
    });
    current.on(RoomEvent.Disconnected, () => {
      if (room === current && !destroyed) void finish(false, connected ? undefined : callStartError(undefined));
    });
    current.on(RoomEvent.DataReceived, (payload) => {
      if (payload.byteLength > 4096) return;
      let data: unknown;
      try { data = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (record(data) && data.type === "session-ended") void finish();
    });
  }

  async function startCall() {
    if (!initialized || destroyed || starting || finishing || phase !== "ready") return;
    clearError();
    let displayName: string;
    try {
      displayName = visitorName(needsName() ? elements.name.current?.value ?? "" : savedName ?? "");
    } catch (failure) {
      showError(mediaError(failure), true);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      showError("Microphone access is unavailable. Open this website over HTTPS in a supported browser and allow microphone access for the embedded widget.");
      return;
    }
    const policyDocument = document as Document & {
      permissionsPolicy?: { allowsFeature(name: string): boolean };
      featurePolicy?: { allowsFeature(name: string): boolean };
    };
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
    if (policy && !policy.allowsFeature("microphone")) {
      showError("Microphone access is blocked by this website. Ask the website owner to allow microphone access for this widget.");
      return;
    }
    rememberName(displayName);
    starting = true;
    const attempt = ++generation;
    const cancelled = () => destroyed || generation !== attempt;
    phase = "connecting";
    captions.clear();
    seconds = config.maxSeconds;
    muted = false;
    reconnecting = false;
    agentState = "listening";
    connected = false;
    finishMessage = undefined;
    post("status", true);
    render();
    try {
      const current = new Room({
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      room = current;
      bindRoom(current);
      await current.startAudio().catch((failure: unknown) => {
        if (!(failure instanceof DOMException) || failure.name !== "NotAllowedError") throw failure;
      });
      if (cancelled()) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const track of stream.getTracks()) track.stop();
      if (cancelled()) return;
      bootstrapAbort = new AbortController();
      const bootstrapOptions = {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: bootstrapAbort.signal,
      };
      const bootstrapPath = `/api/public/widgets/${encodeURIComponent(config.agentId)}/bootstrap`;
      const savedToken = readVisitorToken();
      let bootstrap: unknown;
      try {
        bootstrap = await request(bootstrapPath, {
          ...bootstrapOptions,
          body: JSON.stringify({ parentOrigin: config.parentOrigin, visitorToken: savedToken }),
        });
      } catch (failure) {
        if (cancelled() || !savedToken || !(failure instanceof WidgetRequestError)
          || failure.status !== 401 || failure.code !== "widget_token_invalid") throw failure;
        clearVisitorToken();
        bootstrap = await request(bootstrapPath, {
          ...bootstrapOptions, body: JSON.stringify({ parentOrigin: config.parentOrigin }),
        });
      }
      bootstrapAbort = null;
      if (cancelled()) return;
      if (!record(bootstrap) || !bounded(bootstrap.grant, 8192) || !bounded(bootstrap.visitorToken, 4096)) {
        throw new Error("Could not authorize this voice widget. Reload the website and try again.");
      }
      saveVisitorToken(bootstrap.visitorToken);
      // Session creation is not aborted: a late charged start must still be ended.
      const payload = await request(`/api/public/widgets/${encodeURIComponent(config.agentId)}/sessions`, {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bootstrap.grant}` },
        body: JSON.stringify({ name: displayName }),
      });
      const capability = record(payload) && record(payload.session)
        && bounded(payload.session.id, 128) && bounded(payload.session.embedToken, 8192)
        ? { id: payload.session.id, embedToken: payload.session.embedToken } : null;
      if (cancelled()) {
        const failure = capability ? await closeSession(capability) : null;
        if (failure) console.error(failure);
        return;
      }
      session = capability;
      const launch = parseSession(payload);
      session = launch.session;
      deadline = performance.now() + remainingCallMs(launch.session, config.maxSeconds);
      timer = setInterval(tick, 250);
      tick();
      if (cancelled()) return;
      await current.connect(config.livekitUrl, launch.participantToken);
      if (cancelled()) { await disconnect(current); return; }
      for (const participant of current.remoteParticipants.values()) {
        const state = participant.attributes["lk.agent.state"];
        if (state === "listening" || state === "thinking" || state === "speaking") agentState = state;
      }
      await current.localParticipant.setMicrophoneEnabled(true);
      if (cancelled()) { await disconnect(current); return; }
      phase = "live";
      connected = true;
      updateWaves();
      focusTarget = "end";
      render();
    } catch (failure) {
      if (!cancelled()) await finish(false, callStartError(failure));
    } finally {
      starting = false;
      render();
    }
  }

  function beginCall() {
    if (!preview) return startCall();
    try {
      rememberName(visitorName(needsName() ? elements.name.current?.value ?? "" : savedName ?? ""));
    } catch (failure) {
      showError(mediaError(failure), true);
      return;
    }
    clearError();
    showPreview({ phase: "live", agentState: "speaking" });
    if (preview.embedded) post("status", true);
  }

  function showPreview(state: WidgetPreview) {
    phase = state.phase;
    agentState = state.agentState ?? "listening";
    reconnecting = state.reconnecting ?? false;
    muted = state.muted ?? false;
    seconds = state.urgent ? 12 : config.maxSeconds;
    render();
    stopWaves?.();
    const waves = elements.waves.current;
    stopWaves = phase === "live" && waves ? drawCallWaves(waves, [
      { color: "#85a75b", gate: 0, volume: () => agentState === "speaking" ? .26 + .12 * Math.sin(performance.now() / 180) : 0 },
      { color: "#e5bf94", gate: MIC_NOISE_GATE, volume: () => agentState === "listening" && !muted ? .16 : 0 },
    ]) : undefined;
  }

  function dismiss() {
    if (phase === "connecting" || phase === "live" || finishing) return;
    if (intro) { post("close"); return; }
    intro = true;
    phase = "ready";
    editingName = false;
    clearError();
    focusTarget = "intro";
    render();
  }
  function unlockAudio() {
    if (phase === "live" && room?.canPlaybackAudio === false) {
      void room.startAudio().catch((failure: unknown) => showError(mediaError(failure)));
    }
  }
  function nameInput() {
    if (!nameInvalid) return;
    nameInvalid = false;
    render();
  }
  function endCall() {
    if (!preview) { void finish(); return; }
    intro = true;
    focusTarget = "intro";
    showPreview({ phase: "ready" });
    if (preview.embedded) post("status", false);
  }
  function toggleMute() {
    if (preview) { muted = !muted; render(); return; }
    const current = room;
    if (!current || phase !== "live" || mutePending) return;
    mutePending = true;
    render();
    void current.localParticipant.setMicrophoneEnabled(muted).then(() => {
      if (room === current) muted = !muted;
    }).catch((failure: unknown) => showError(mediaError(failure))).finally(() => {
      mutePending = false;
      render();
    });
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    sizeObserver.disconnect();
    window.removeEventListener("resize", reportSize);
    initialized = false;
    window.removeEventListener("message", receive);
    window.removeEventListener("pageshow", ready);
    window.removeEventListener("pagehide", destroy);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("focusin", interaction);
    document.removeEventListener("focusout", interaction);
    window.removeEventListener("focus", interaction);
    window.removeEventListener("blur", interaction);
    stopWaves?.();
    stopWaves = undefined;
    void finish(true).finally(() => { if (ownsAudioContainer) audioContainer.remove(); });
    view.unmount();
  }
  function receive(event: MessageEvent<unknown>) {
    if (destroyed || window.parent === window || event.source !== window.parent || event.origin !== config.parentOrigin) return;
    const data = event.data;
    if (!isHostMessage(data)) return;
    if (data.type === "init") {
      if (!initialized && !preview) readName();
      initialized = true;
      render();
    } else if (data.type === "visibility") {
      visible = data.open;
      render();
    } else if (data.type === "destroy") {
      destroy();
    }
  }
  function ready() {
    if (!destroyed) post("ready");
  }
  function visibility() {
    if (session) tick();
  }
  function interaction() {
    queueMicrotask(() => {
      if (!destroyed) post("interaction", document.hasFocus() && document.activeElement === elements.name.current);
    });
  }
  flushSync(render);
  if (elements.body.current) sizeObserver.observe(elements.body.current);
  if (elements.controls.current) sizeObserver.observe(elements.controls.current);
  window.addEventListener("resize", reportSize);
  window.addEventListener("pagehide", destroy);
  if (preview) {
    initialized = !preview.embedded;
    visible = !preview.embedded;
    setCaption("welcome", "What would you like to practice today?", true, false);
    setCaption("visitor", "I want to get better at giving feedback.", true, true);
    setCaption("response", "Let’s start with a conversation you’ve been putting off. Think of a recent moment when you wanted to give someone feedback but held back. What did you want them to understand, and what made it difficult to say?", true, false);
    if (preview.embedded) {
      window.addEventListener("message", receive);
      ready();
    }
    if (!intro && preview.phase === "ready" && !savedName) focusTarget = "name";
    showPreview(preview);
    return;
  }
  document.addEventListener("focusin", interaction);
  document.addEventListener("focusout", interaction);
  window.addEventListener("focus", interaction);
  window.addEventListener("blur", interaction);
  window.addEventListener("message", receive);
  window.addEventListener("pageshow", ready);
  document.addEventListener("visibilitychange", visibility);
  render();
  ready();
}

if (typeof document !== "undefined") {
  const root = document.getElementById("trainertwin-widget");
  if (root) {
    try {
      const configNode = document.getElementById("trainertwin-config");
      if (!configNode?.textContent) throw new Error("Voice widget configuration is missing.");
      const value: unknown = JSON.parse(configNode.textContent);
      const config = parseConfig(value);
      mount(root, config);
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) mount(root, config);
      });
    } catch (failure) {
      createRoot(root).render(createElement("p", { className: "tt-config-error", role: "alert" }, mediaError(failure)));
    }
  }
}
