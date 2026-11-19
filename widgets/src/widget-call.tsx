import { Mic, MicOff, PhoneOff, X } from "lucide-react";
import { WidgetPortrait } from "./widget-portrait";
import type { WidgetRefs } from "./widget-view";

export type WidgetPhase = "ready" | "connecting" | "live" | "failed";
export type Caption = { id: string; text: string; final: boolean; visitor: boolean };

type WidgetCallProps = {
  elements: WidgetRefs;
  trainer: string;
  photoUrl: string | null;
  welcome: string;
  phase: WidgetPhase;
  visible: boolean;
  hasName: boolean;
  canStart: boolean;
  dismissible: boolean;
  seconds: number;
  captions: Caption[];
  reconnecting: boolean;
  muted: boolean;
  mutePending: boolean;
  playbackBlocked: boolean;
  finishMessage?: string;
  onDismiss: () => void;
  onRetry: () => void;
  onChangeName: () => void;
  onMute: () => void;
  onEnd: () => void;
};

const icon = { className: "tt-icon", "aria-hidden": true, focusable: "false", strokeWidth: 1.75 } as const;

export function WidgetCall(props: WidgetCallProps) {
  const { elements, phase, muted } = props;
  const inCall = phase === "connecting" || phase === "live";
  const connecting = phase === "connecting" || (phase === "live" && props.reconnecting);
  const failed = phase === "failed";
  const muteAction = muted ? "Unmute microphone" : "Mute microphone";
  const timeRemaining = `${Math.floor(props.seconds / 60)}:${String(props.seconds % 60).padStart(2, "0")} left`;
  return (
    <div className="tt-call-screen" hidden={!props.visible}>
      <canvas ref={elements.waves} className="tt-waves" hidden={phase !== "live"} aria-hidden="true" />
      <button type="button" className="tt-icon-button tt-dismiss" aria-label="Close widget"
        hidden={inCall || !props.dismissible} onClick={props.onDismiss}><X {...icon} /></button>
      <div className="tt-call-meta" hidden={!inCall}>
        <span className={`tt-countdown${props.seconds <= 15 ? " tt-urgent" : ""}`} aria-label="Time remaining">{timeRemaining}</span>
      </div>
      <div ref={elements.body} className="tt-body">
        <div className="tt-hero">
          <div ref={elements.portrait} className="tt-portrait-stage">
            <WidgetPortrait name={props.trainer} photoUrl={props.photoUrl} className="tt-hero-portrait" />
          </div>
          <p className="tt-status" role="status" aria-live="polite" hidden={!connecting}>{connecting ? "Connecting…" : ""}</p>
        </div>
        <section className="tt-call" aria-label="Voice call" hidden={!inCall}>
          <div className="tt-transcript" role="log" aria-label="Conversation captions" aria-live="polite" aria-relevant="additions text">
            {props.captions.slice(-2).map(({ id, text, final, visitor }) => (
              <p key={id} className={`tt-caption${visitor ? " tt-caption-you" : ""}`} data-final={final}>
                <span className="tt-caption-text">{text}</span>
              </p>
            ))}
          </div>
          <p className="tt-playback-hint" role="alert" hidden={!props.playbackBlocked}>Audio is blocked by your browser. Tap the widget to hear the call.</p>
        </section>
        <section className="tt-call-actions" hidden={inCall}>
          <h2 className="tt-call-title" aria-live="polite" aria-description={failed ? props.finishMessage ?? "Please try again in a little while." : undefined}>
            {failed ? "We couldn’t start the conversation." : props.welcome}
          </h2>
          <button ref={elements.retry} type="button" className="tt-primary" disabled={!props.canStart} onClick={props.onRetry}>
            {failed ? "Try again" : "Start voice call"}
          </button>
          <button type="button" className="tt-change-name" aria-label="Change your name" hidden={!props.hasName} onClick={props.onChangeName}>Change name</button>
        </section>
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
    </div>
  );
}
