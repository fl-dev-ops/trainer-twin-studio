import { createAudioAnalyser, Room, RoomEvent, Track, type Participant, type RemoteAudioTrack, type RemoteTrack, type TranscriptionSegment } from "livekit-client";
import { createElement, Maximize2, Mic, MicOff, Minimize2, PhoneOff, X } from "lucide";
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
type Phase = "ready" | "connecting" | "live" | "failed";
type AgentState = "listening" | "thinking" | "speaking";
export type WidgetPreview = { phase: Phase; agentState?: AgentState; reconnecting?: boolean; muted?: boolean; urgent?: boolean; name?: string; embedded?: boolean };

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

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function icon(node: Parameters<typeof createElement>[0]) {
  return createElement(node, { class: "tt-icon", "aria-hidden": "true", focusable: "false", "stroke-width": 1.75 });
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
  let phase: Phase = "ready";
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
  let visitorToken: string | undefined;
  let savedName = preview?.name;
  let editingName = false;
  let storageAvailable = true;
  const scope = `${config.agentId}:${config.parentOrigin}`;
  const tokenKey = `trainertwin-widget:visitor:${scope}`;
  const nameKey = `trainertwin-widget:name:${scope}`;
  const captions = new Map<string, HTMLElement>();
  const attachedTracks = new Set<RemoteTrack>();

  const post = (type: "ready" | "close" | "status" | "interaction", active?: boolean) => {
    if (window.parent !== window) {
      window.parent.postMessage({
        source: "trainertwin-widget", version: 1, type,
        ...(type === "status" ? { active: active === true } : {}),
        ...(type === "interaction" ? { editing: active === true } : {}),
      }, config.parentOrigin);
    }
  };

  const card = element("section", "tt-card");
  card.style.setProperty("--tt-accent", config.accentColor);
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(config.accentColor.slice(offset, offset + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  card.style.setProperty("--tt-action", luminance < .04 ? "#f2eee5" : config.accentColor);
  card.style.setProperty("--tt-on-accent", luminance < .04 || luminance > .179 ? "#111111" : "#ffffff");
  card.setAttribute("aria-label", `${config.name} voice assistant`);
  function portrait(className: string) {
    const node = element("div", `tt-portrait ${className}`);
    node.setAttribute("aria-hidden", "true");
    const initials = config.trainerName.trim().split(/\s+/u).slice(0, 2).map((part) => part.charAt(0)).join("");
    const fallback = element("span", "tt-initials", initials);
    node.append(fallback);
    if (config.photoUrl) {
      fallback.hidden = true;
      const image = element("img", "tt-photo");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.loading = "eager";
      image.fetchPriority = "high";
      image.decoding = "async";
      image.src = config.photoUrl;
      image.addEventListener("error", () => {
        image.remove();
        fallback.hidden = false;
      }, { once: true });
      node.append(image);
    }
    return node;
  }
  const dismiss = button("tt-icon-button tt-dismiss", "");
  dismiss.append(icon(X));
  dismiss.setAttribute("aria-label", "Close widget");
  dismiss.addEventListener("click", () => post("close"));
  const body = element("div", "tt-body");
  const hero = element("div", "tt-hero");
  const portraitStage = element("div", "tt-portrait-stage");
  const heroPortrait = portrait("tt-hero-portrait");
  const waves = element("canvas", "tt-waves");
  waves.setAttribute("aria-hidden", "true");
  const status = element("p", "tt-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  portraitStage.append(heroPortrait);
  hero.append(portraitStage, status);

  const form = element("form", "tt-prejoin");
  const label = element("label", "tt-label", "What’s your name?");
  label.htmlFor = "tt-visitor-name";
  const name = element("input", "tt-input");
  name.id = label.htmlFor;
  name.name = "name";
  name.type = "text";
  name.autocomplete = "name";
  name.setAttribute("aria-label", "Your name");
  name.maxLength = 80;
  name.placeholder = "Your name";
  name.required = true;
  name.setAttribute("aria-describedby", "tt-error");
  const start = button("tt-primary", "Continue");
  start.type = "submit";
  start.disabled = true;
  const nameField = element("div", "tt-name-field");
  nameField.append(label, name);
  const changeName = button("tt-change-name", "Change name");
  changeName.setAttribute("aria-label", "Change your name");
  changeName.addEventListener("click", () => {
    phase = "ready";
    editingName = true;
    name.value = savedName ?? "";
    clearError();
    render();
    name.focus();
    name.select();
  });
  form.append(nameField, start);

  const call = element("section", "tt-call");
  call.hidden = true;
  call.setAttribute("aria-label", "Voice call");
  const callMeta = element("div", "tt-call-meta");
  const countdown = element("span", "tt-countdown", `${clock(config.maxSeconds)} left`);
  countdown.setAttribute("aria-label", "Time remaining");
  const captionToggle = button("tt-icon-button tt-caption-toggle", "");
  captionToggle.append(icon(Maximize2));
  captionToggle.setAttribute("aria-label", "Expand captions");
  captionToggle.setAttribute("aria-expanded", "false");
  captionToggle.setAttribute("aria-controls", "tt-captions");
  captionToggle.title = "Expand captions";
  function expandCaptions(expanded: boolean) {
    captionToggle.replaceChildren(icon(expanded ? Minimize2 : Maximize2));
    captionToggle.setAttribute("aria-expanded", String(expanded));
    captionToggle.setAttribute("aria-label", expanded ? "Collapse captions" : "Expand captions");
    captionToggle.title = expanded ? "Collapse captions" : "Expand captions";
    card.classList.toggle("tt-captions-expanded", expanded);
    updateCaptionVisibility();
  }
  function updateCaptionVisibility() {
    const latest = [...captions.values()].slice(-2);
    for (const caption of captions.values()) caption.hidden = !card.classList.contains("tt-captions-expanded") && !latest.includes(caption);
  }
  captionToggle.addEventListener("click", () => expandCaptions(captionToggle.getAttribute("aria-expanded") !== "true"));
  callMeta.append(countdown, captionToggle);
  const transcript = element("div", "tt-transcript");
  transcript.id = "tt-captions";
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation captions");
  transcript.setAttribute("aria-live", "polite");
  transcript.setAttribute("aria-relevant", "additions text");
  transcript.tabIndex = 0;
  const playbackHint = element("p", "tt-playback-hint", "Audio is blocked by your browser. Tap the widget to hear the call.");
  playbackHint.hidden = true;
  playbackHint.setAttribute("role", "alert");
  const controls = element("div", "tt-controls");
  const mute = button("tt-secondary tt-mute", "");
  mute.append(icon(Mic), icon(MicOff));
  mute.setAttribute("aria-label", "Mute microphone");
  mute.title = "Mute microphone";
  mute.setAttribute("aria-pressed", "false");
  const end = button("tt-end", "");
  end.append(icon(PhoneOff));
  end.setAttribute("aria-label", "End call");
  end.title = "End call";
  const muteControl = element("div", "tt-control");
  const muteLabel = element("span", "tt-control-label", "Mute");
  const endControl = element("div", "tt-control");
  muteControl.append(mute, muteLabel);
  endControl.append(end, element("span", "tt-control-label", "End call"));
  controls.append(muteControl, endControl);
  call.append(transcript, playbackHint);

  const callActions = element("section", "tt-call-actions");
  const callTitle = element("h2", "tt-call-title", config.welcome);
  callTitle.setAttribute("aria-live", "polite");
  const retry = button("tt-primary", "Start voice call");
  retry.addEventListener("click", () => {
    if (starting || finishing || destroyed) return;
    phase = "ready";
    if (savedName && !editingName) void beginCall();
    else {
      clearError();
      render();
      name.focus();
    }
  });
  callActions.append(callTitle, retry, changeName);
  const error = element("p", "tt-error");
  error.id = "tt-error";
  error.hidden = true;
  error.tabIndex = -1;
  error.setAttribute("role", "alert");
  body.append(hero, form, call, callActions, error);
  card.append(waves, dismiss, callMeta, body, controls);
  root.replaceChildren(card);
  card.dataset.visible = "false";
  let reportedHeight = 0;
  function reportSize() {
    if ((preview && !preview.embedded) || !initialized || destroyed || window.parent === window) return;
    const portraitHeight = portraitStage.offsetHeight;
    const chromeHeight = card.offsetHeight - portraitHeight;
    const squareHeight = portraitStage.offsetWidth;
    const natural = chromeHeight + squareHeight;
    if (squareHeight) portraitStage.style.height = `${Math.max(0, Math.min(squareHeight, innerHeight - chromeHeight))}px`;
    const height = Math.max(MIN_WIDGET_HEIGHT, Math.min(MAX_WIDGET_HEIGHT, Math.ceil(natural)));
    if (height === reportedHeight) return;
    reportedHeight = height;
    window.parent.postMessage({ source: "trainertwin-widget", version: 1, type: "resize", height }, config.parentOrigin);
  }
  const sizeObserver = new ResizeObserver(reportSize);
  sizeObserver.observe(body);
  sizeObserver.observe(controls);
  window.addEventListener("resize", reportSize);
  const audioContainer = document.getElementById("trainertwin-audio") ?? element("div", "tt-audio");
  audioContainer.hidden = true;
  const ownsAudioContainer = !audioContainer.isConnected;
  if (ownsAudioContainer) root.after(audioContainer);
  let stopWaves: (() => void) | undefined;
  function updateWaves() {
    stopWaves?.();
    stopWaves = undefined;
    if (!room || phase !== "live") return;
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
    error.textContent = "";
    error.hidden = true;
    name.removeAttribute("aria-invalid");
  }

  function showError(message: string, nameError = false) {
    if (destroyed) return;
    error.textContent = message;
    error.hidden = false;
    if (nameError) {
      name.setAttribute("aria-invalid", "true");
      name.focus();
    } else {
      error.focus();
    }
  }

  function render() {
    if (destroyed) return;
    card.dataset.phase = phase;
    card.dataset.agentState = agentState;
    const needsName = phase === "ready" && (!savedName || editingName);
    card.dataset.stage = needsName ? "name" : "call";
    form.hidden = !needsName;
    hero.hidden = needsName;
    call.hidden = phase !== "connecting" && phase !== "live";
    callMeta.hidden = call.hidden;
    controls.hidden = call.hidden;
    dismiss.hidden = !call.hidden || (preview !== undefined && !preview.embedded);
    callActions.hidden = needsName || !call.hidden;
    callTitle.textContent = phase === "failed" ? "We couldn’t start the conversation." : config.welcome;
    if (phase === "failed") callTitle.setAttribute("aria-description", finishMessage ?? "Please try again in a little while.");
    else callTitle.removeAttribute("aria-description");
    changeName.hidden = !savedName;
    retry.textContent = phase === "failed" ? "Try again" : "Start voice call";
    const connecting = phase === "connecting" || (phase === "live" && reconnecting);
    status.hidden = !connecting;
    waves.hidden = phase !== "live";
    start.disabled = !initialized || starting || finishing;
    retry.disabled = starting || finishing || !initialized;
    name.disabled = starting || !needsName;
    mute.disabled = phase !== "live" || mutePending || reconnecting;
    mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    mute.title = muted ? "Unmute microphone" : "Mute microphone";
    muteLabel.textContent = muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed", String(muted));
    status.textContent = connecting ? "Connecting…" : "";
    playbackHint.hidden = phase !== "live" || room?.canPlaybackAudio !== false;
    reportSize();
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
    expandCaptions(false);
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
    render();
    if (warning) showError(warning);
    else if (phase === "ready") {
      if (card.dataset.visible === "true") post("close");
    } else retry.focus();
  }

  function tick() {
    const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    countdown.textContent = `${clock(remaining)} left`;
    countdown.classList.toggle("tt-urgent", remaining <= 15);
    if (remaining === 0) void finish(false, "This call reached its time limit.");
  }

  function setCaption(key: string, value: string, final: boolean, visitor: boolean) {
    let caption = captions.get(key);
    if (!caption) {
      caption = element("p", visitor ? "tt-caption tt-caption-you" : "tt-caption");
      caption.append(element("span", "tt-caption-text"));
      captions.set(key, caption);
      transcript.append(caption);
    }
    if (caption.lastElementChild) caption.lastElementChild.textContent = value.slice(0, 8000);
    caption.dataset.final = String(final);
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
      const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 64;
      for (const segment of segments) {
        if (!segment.text.trim()) continue;
        setCaption(`${participant?.identity ?? "agent"}:${segment.id}`, segment.text, segment.final,
          participant?.identity === current.localParticipant.identity);
      }
      while (captions.size > 120) {
        const oldest = captions.entries().next().value;
        if (!oldest) break;
        oldest[1].remove();
        captions.delete(oldest[0]);
      }
      updateCaptionVisibility();
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
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
      displayName = visitorName(form.hidden ? savedName ?? "" : name.value);
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
    expandCaptions(false);
    captions.clear();
    transcript.replaceChildren();
    countdown.textContent = `${clock(config.maxSeconds)} left`;
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
      render();
      end.focus();
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
      rememberName(visitorName(form.hidden ? savedName ?? "" : name.value));
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
    countdown.textContent = state.urgent ? "0:12 left" : `${clock(config.maxSeconds)} left`;
    countdown.classList.toggle("tt-urgent", state.urgent === true);
    expandCaptions(false);
    render();
    stopWaves?.();
    stopWaves = phase === "live" ? drawCallWaves(waves, [
      { color: "#85a75b", gate: 0, volume: () => agentState === "speaking" ? .26 + .12 * Math.sin(performance.now() / 180) : 0 },
      { color: "#e5bf94", gate: MIC_NOISE_GATE, volume: () => agentState === "listening" && !muted ? .16 : 0 },
    ]) : undefined;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void beginCall();
  });

  if (preview) {
    initialized = !preview.embedded;
    card.dataset.visible = String(!preview.embedded);
    setCaption("welcome", "What would you like to practice today?", true, false);
    setCaption("visitor", "I want to get better at giving feedback.", true, true);
    setCaption("response", "Let’s start with a conversation you’ve been putting off.", true, false);
    mute.addEventListener("click", () => { muted = !muted; render(); });
    end.addEventListener("click", () => {
      showPreview({ phase: "ready" });
      if (preview.embedded) {
        post("status", false);
        post("close");
      }
    });
    if (preview.embedded) {
      window.addEventListener("message", receive);
      card.addEventListener("keydown", (event) => { if (event.key === "Escape") post("close"); });
      ready();
    }
    window.addEventListener("pagehide", () => {
      stopWaves?.();
      sizeObserver.disconnect();
      window.removeEventListener("resize", reportSize);
      window.removeEventListener("message", receive);
    }, { once: true });
    showPreview(preview);
    return;
  }

  card.addEventListener("click", () => {
    if (phase === "live" && room?.canPlaybackAudio === false) {
      void room.startAudio().catch((failure: unknown) => showError(mediaError(failure)));
    }
  });
  name.addEventListener("input", () => {
    name.removeAttribute("aria-invalid");
  });
  end.addEventListener("click", () => { void finish(); });
  mute.addEventListener("click", () => {
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
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && config.mode === "floating") {
      event.preventDefault();
      post("close");
    }
  });
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
    void finish(true).finally(() => { if (ownsAudioContainer) audioContainer.remove(); });
    root.replaceChildren();
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
      card.dataset.visible = String(data.open);
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
      if (!destroyed) post("interaction", document.hasFocus() && document.activeElement === name);
    });
  }
  document.addEventListener("focusin", interaction);
  document.addEventListener("focusout", interaction);
  window.addEventListener("focus", interaction);
  window.addEventListener("blur", interaction);
  window.addEventListener("message", receive);
  window.addEventListener("pageshow", ready);
  window.addEventListener("pagehide", destroy);
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
      const error = element("p", "tt-config-error", mediaError(failure));
      error.setAttribute("role", "alert");
      root.replaceChildren(error);
    }
  }
}
