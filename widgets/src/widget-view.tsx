import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type RefObject } from "react";
import { WidgetCall } from "./widget-call";
import { WidgetIntro } from "./widget-intro";
import { WidgetLimit } from "./widget-limit";

export type WidgetRefs = {
  card: RefObject<HTMLElement | null>;
  body: RefObject<HTMLDivElement | null>;
  portrait: RefObject<HTMLDivElement | null>;
  waves: RefObject<HTMLCanvasElement | null>;
  controls: RefObject<HTMLDivElement | null>;
  name: RefObject<HTMLInputElement | null>;
  intro: RefObject<HTMLButtonElement | null>;
  end: RefObject<HTMLButtonElement | null>;
  retry: RefObject<HTMLButtonElement | null>;
  notice: RefObject<HTMLHeadingElement | null>;
  error: RefObject<HTMLParagraphElement | null>;
};

export type AgentState = "listening" | "thinking" | "speaking";
export type WidgetStage = "intro" | "name" | "call" | "limit";
type Surface = "intro" | "call" | "limit";

/** How long the outgoing screen fades before the incoming one mounts. Keep in sync with `.tt-card[data-leaving]` in CSS. */
const LEAVE_MS = 200;

type WidgetViewProps = {
  name: string;
  welcome: string;
  theme: CSSProperties;
  stage: WidgetStage;
  agentState: AgentState;
  visible: boolean;
  draftName?: string;
  errorMessage?: string;
  nameInvalid: boolean;
  limitReason?: string;
  messageSentTo?: string;
  call: Omit<ComponentProps<typeof WidgetCall>, "visible">;
  onCommit: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  onStart: () => void;
  onNameInput: () => void;
  onUnlockAudio: () => void;
  onSendMessage: (email: string, message: string) => Promise<void>;
};

const surfaceOf = (stage: WidgetStage): Surface => stage === "name" ? "intro" : stage;

export function WidgetView(props: WidgetViewProps) {
  const { elements, trainer, photoUrl, canStart } = props.call;
  const target = surfaceOf(props.stage);
  // The surface on screen lags the requested one by LEAVE_MS so the old content can fade out first.
  const [shown, setShown] = useState<Surface>(target);
  const introMode = useRef<"intro" | "name">(props.stage === "name" ? "name" : "intro");
  if (props.stage === "intro" || props.stage === "name") introMode.current = props.stage;
  const leaving = shown !== target;
  useEffect(() => {
    if (!leaving) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setShown(target), reduce ? 0 : LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, target]);
  useLayoutEffect(() => props.onCommit());

  return (
    <section ref={elements.card} className="tt-card" style={props.theme}
      data-phase={props.call.phase} data-agent-state={props.agentState} data-stage={props.stage}
      data-surface={target === "call" ? "dark" : "light"} data-leaving={leaving}
      data-visible={props.visible} aria-label={`${props.name} voice assistant`} onClick={props.onUnlockAudio}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onDismiss(); } }}>
      {shown === "intro" && <WidgetIntro trainer={trainer} photoUrl={photoUrl} welcome={props.welcome} mode={introMode.current}
        disabled={!canStart} invalid={props.nameInvalid} initialName={props.draftName}
        onOpen={props.onOpen} onStart={props.onStart} onNameInput={props.onNameInput}
        onChangeName={canStart && props.call.hasName ? props.call.onChangeName : undefined}
        buttonRef={elements.intro} inputRef={elements.name} />}
      {shown === "limit" && <WidgetLimit trainer={trainer} photoUrl={photoUrl} reason={props.limitReason}
        sentTo={props.messageSentTo} noticeRef={elements.notice} onSend={props.onSendMessage} />}
      <WidgetCall {...props.call} visible={shown === "call"} />
      <p ref={elements.error} className="tt-error" id="tt-error" tabIndex={-1} role="alert" hidden={!props.errorMessage}>{props.errorMessage}</p>
    </section>
  );
}
