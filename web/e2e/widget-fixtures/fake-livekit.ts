export type WidgetRoomDriver = {
  connects: number;
  disconnects: number;
  microphone: boolean[];
  caption: (id: string, text: string, speaker?: "agent" | "visitor", final?: boolean) => void;
  agentState: (state: "listening" | "thinking" | "speaking") => void;
  attachAudio: () => void;
  detachAudio: () => void;
  reconnecting: () => void;
  reconnected: () => void;
  resolveConnect: () => void;
};

export type WidgetFetch = { path: string; credentials: RequestCredentials };

declare global {
  interface Window {
    __widgetRoom?: WidgetRoomDriver;
    __widgetConnectPending?: boolean;
    __widgetFetches?: WidgetFetch[];
    __widgetMicrophoneRequests?: number;
    __widgetMessages?: unknown[];
  }
}

export const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  TranscriptionReceived: "transcriptionReceived",
  ParticipantAttributesChanged: "participantAttributesChanged",
  ParticipantConnected: "participantConnected",
  AudioPlaybackStatusChanged: "audioPlaybackChanged",
  Disconnected: "disconnected",
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
  DataReceived: "dataReceived",
};
export const Track = { Kind: { Audio: "audio", Video: "video" } };
type Listener = (...args: unknown[]) => void;

export class Room {
  private listeners = new Map<string, Set<Listener>>();
  private releaseConnect: (() => void) | undefined;
  private audio: HTMLAudioElement[] = [];
  private remoteAudio = {
    kind: "audio",
    attach: () => {
      const audio = document.createElement("audio");
      audio.dataset.widgetFixture = "remote-audio";
      this.audio.push(audio);
      return audio;
    },
    detach: () => {
      const attached = this.audio;
      this.audio = [];
      return attached;
    },
  };
  canPlaybackAudio = false;
  remoteParticipants = new Map([
    ["agent", { identity: "agent", attributes: { "lk.agent.state": "listening" } }],
  ]);
  localParticipant = {
    identity: "visitor",
    setMicrophoneEnabled: async (enabled: boolean) => {
      this.driver.microphone.push(enabled);
    },
  };
  private driver: WidgetRoomDriver = {
    connects: 0,
    disconnects: 0,
    microphone: [],
    caption: (id, text, speaker = "agent", final = true) => {
      this.emit(RoomEvent.TranscriptionReceived, [{ id, text, final }], { identity: speaker });
    },
    agentState: (state) => {
      this.emit(RoomEvent.ParticipantAttributesChanged, { "lk.agent.state": state }, { identity: "agent" });
    },
    attachAudio: () => this.emit(RoomEvent.TrackSubscribed, this.remoteAudio),
    detachAudio: () => this.emit(RoomEvent.TrackUnsubscribed, this.remoteAudio),
    reconnecting: () => this.emit(RoomEvent.Reconnecting),
    reconnected: () => this.emit(RoomEvent.Reconnected),
    resolveConnect: () => this.releaseConnect?.(),
  };

  constructor() {
    window.__widgetRoom = this.driver;
  }

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  async connect() {
    this.driver.connects++;
    if (window.__widgetConnectPending) {
      await new Promise<void>((resolve) => { this.releaseConnect = resolve; });
    }
  }

  async startAudio() {
    this.canPlaybackAudio = true;
    this.emit(RoomEvent.AudioPlaybackStatusChanged);
  }

  async disconnect() {
    this.driver.disconnects++;
    this.releaseConnect?.();
    this.emit(RoomEvent.Disconnected);
  }
}
