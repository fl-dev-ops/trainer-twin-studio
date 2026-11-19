import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, X } from "lucide-react";
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export type WidgetRefs = {
  card: RefObject<HTMLElement | null>;
  body: RefObject<HTMLDivElement | null>;
  portrait: RefObject<HTMLDivElement | null>;
  waves: RefObject<HTMLCanvasElement | null>;
  transcript: RefObject<HTMLDivElement | null>;
  controls: RefObject<HTMLDivElement | null>;
  name: RefObject<HTMLInputElement | null>;
  end: RefObject<HTMLButtonElement | null>;
  retry: RefObject<HTMLButtonElement | null>;
  error: RefObject<HTMLParagraphElement | null>;
};

export type WidgetPhase = "ready" | "connecting" | "live" | "failed";
export type AgentState = "listening" | "thinking" | "speaking";
export type Caption = { id: string; text: string; final: boolean; visitor: boolean };

type WidgetViewProps = {
  elements: WidgetRefs;
  config: { name: string; trainerName: string; welcome: string; photoUrl: string | null };
  theme: CSSProperties;
  phase: WidgetPhase;
  agentState: AgentState;
  visible: boolean;
  needsName: boolean;
  hasName: boolean;
  canStart: boolean;
  dismissible: boolean;
  expanded: boolean;
  seconds: number;
  captions: Caption[];
  reconnecting: boolean;
  muted: boolean;
  mutePending: boolean;
  playbackBlocked: boolean;
  finishMessage?: string;
  errorMessage?: string;
  nameInvalid: boolean;
  onCommit: () => void;
  onDismiss: () => void;
  onStart: () => void;
  onRetry: () => void;
  onChangeName: () => void;
  onNameInput: () => void;
  onToggleCaptions: () => void;
  onMute: () => void;
  onEnd: () => void;
  onUnlockAudio: () => void;
};

const icon = { className: "tt-icon", "aria-hidden": true, focusable: "false", strokeWidth: 1.75 } as const;

function Portrait({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = !!photoUrl && !photoFailed;
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part.charAt(0)).join("");
  return (
    <div className="tt-portrait tt-hero-portrait" aria-hidden="true">
      <span className="tt-initials" hidden={showPhoto}>{initials}</span>
      {showPhoto && <img className="tt-photo" src={photoUrl} alt="" referrerPolicy="no-referrer" loading="eager"
        fetchPriority="high" decoding="async" onError={() => setPhotoFailed(true)} />}
    </div>
  );
}

export function WidgetView(props: WidgetViewProps) {
  const { config, elements, phase, muted, expanded } = props;
  const inCall = phase === "connecting" || phase === "live";
  const connecting = phase === "connecting" || (phase === "live" && props.reconnecting);
  const failed = phase === "failed";
  const muteAction = muted ? "Unmute microphone" : "Mute microphone";
  const captionAction = expanded ? "Collapse captions" : "Expand captions";
  const timeRemaining = `${Math.floor(props.seconds / 60)}:${String(props.seconds % 60).padStart(2, "0")} left`;
  useLayoutEffect(() => props.onCommit());

  return (
    <section ref={elements.card} className={`tt-card${expanded ? " tt-captions-expanded" : ""}`} style={props.theme}
      data-phase={phase} data-agent-state={props.agentState} data-stage={props.needsName ? "name" : "call"}
      data-visible={props.visible} aria-label={`${config.name} voice assistant`} onClick={props.onUnlockAudio}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onDismiss(); } }}>
      <canvas ref={elements.waves} className="tt-waves" hidden={phase !== "live"} aria-hidden="true" />
      <button type="button" className="tt-icon-button tt-dismiss" aria-label="Close widget"
        hidden={inCall || !props.dismissible} onClick={props.onDismiss}><X {...icon} /></button>
      <div className="tt-call-meta" hidden={!inCall}>
        <span className={`tt-countdown${props.seconds <= 15 ? " tt-urgent" : ""}`} aria-label="Time remaining">{timeRemaining}</span>
        <button type="button" className="tt-icon-button tt-caption-toggle" aria-label={captionAction} title={captionAction}
          aria-expanded={expanded} aria-controls="tt-captions" onClick={props.onToggleCaptions}>
          {expanded ? <Minimize2 {...icon} /> : <Maximize2 {...icon} />}
        </button>
      </div>
      <div ref={elements.body} className="tt-body">
        <div className="tt-hero" hidden={props.needsName}>
          <div ref={elements.portrait} className="tt-portrait-stage"><Portrait name={config.trainerName} photoUrl={config.photoUrl} /></div>
          <p className="tt-status" role="status" aria-live="polite" hidden={!connecting}>{connecting ? "Connecting…" : ""}</p>
        </div>
        <form className="tt-prejoin" hidden={!props.needsName} onSubmit={(event) => { event.preventDefault(); props.onStart(); }}>
          <div className="tt-name-field">
            <label className="tt-label" htmlFor="tt-visitor-name">What’s your name?</label>
            <input ref={elements.name} className="tt-input" id="tt-visitor-name" name="name" autoComplete="name"
              aria-label="Your name" aria-describedby="tt-error" aria-invalid={props.nameInvalid || undefined}
              maxLength={80} placeholder="Your name" required disabled={!props.needsName || !props.canStart} onInput={props.onNameInput} />
          </div>
          <button type="submit" className="tt-primary" disabled={!props.canStart}>Continue</button>
        </form>
        <section className="tt-call" aria-label="Voice call" hidden={!inCall}>
          <div ref={elements.transcript} id="tt-captions" className="tt-transcript" role="log" aria-label="Conversation captions"
            aria-live="polite" aria-relevant="additions text" tabIndex={0}>
            {props.captions.map(({ id, text, final, visitor }, index) => (
              <p key={id} className={`tt-caption${visitor ? " tt-caption-you" : ""}`} data-final={final}
                hidden={!expanded && index < props.captions.length - 2}><span className="tt-caption-text">{text}</span></p>
            ))}
          </div>
          <p className="tt-playback-hint" role="alert" hidden={!props.playbackBlocked}>Audio is blocked by your browser. Tap the widget to hear the call.</p>
        </section>
        <section className="tt-call-actions" hidden={props.needsName || inCall}>
          <h2 className="tt-call-title" aria-live="polite" aria-description={failed ? props.finishMessage ?? "Please try again in a little while." : undefined}>
            {failed ? "We couldn’t start the conversation." : config.welcome}
          </h2>
          <button ref={elements.retry} type="button" className="tt-primary" disabled={!props.canStart} onClick={props.onRetry}>
            {failed ? "Try again" : "Start voice call"}
          </button>
          <button type="button" className="tt-change-name" aria-label="Change your name" hidden={!props.hasName} onClick={props.onChangeName}>Change name</button>
        </section>
        <p ref={elements.error} className="tt-error" id="tt-error" tabIndex={-1} role="alert" hidden={!props.errorMessage}>{props.errorMessage}</p>
      </div>
      <div ref={elements.controls} className="tt-controls" hidden={!inCall}>
        <div className="tt-control">
          <button type="button" className="tt-secondary tt-mute" aria-label={muteAction} title={muteAction} aria-pressed={muted}
            disabled={phase !== "live" || props.mutePending || props.reconnecting} onClick={props.onMute}><Mic {...icon} /><MicOff {...icon} /></button>
          <span className="tt-control-label">{muted ? "Unmute" : "Mute"}</span>
        </div>
        <div className="tt-control">
          <button ref={elements.end} type="button" className="tt-end" aria-label="End call" title="End call" onClick={props.onEnd}><PhoneOff {...icon} /></button>
          <span className="tt-control-label">End call</span>
        </div>
      </div>
    </section>
  );
}
