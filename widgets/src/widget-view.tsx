import { useLayoutEffect, type ComponentProps, type CSSProperties, type RefObject } from "react";
import { WidgetCall } from "./widget-call";
import { WidgetIntro } from "./widget-intro";
import { WidgetName } from "./widget-name";

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
  error: RefObject<HTMLParagraphElement | null>;
};

export type AgentState = "listening" | "thinking" | "speaking";

type WidgetViewProps = {
  name: string;
  theme: CSSProperties;
  stage: "intro" | "name" | "call";
  agentState: AgentState;
  visible: boolean;
  draftName?: string;
  errorMessage?: string;
  nameInvalid: boolean;
  call: Omit<ComponentProps<typeof WidgetCall>, "visible">;
  onCommit: () => void;
  onOpen: () => void;
  onStart: () => void;
  onNameInput: () => void;
  onUnlockAudio: () => void;
};

export function WidgetView(props: WidgetViewProps) {
  const { elements, trainer, photoUrl, welcome, canStart, dismissible, onDismiss } = props.call;
  useLayoutEffect(() => props.onCommit());

  return (
    <section ref={elements.card} className="tt-card" style={props.theme}
      data-phase={props.call.phase} data-agent-state={props.agentState} data-stage={props.stage}
      data-visible={props.visible} aria-label={`${props.name} voice assistant`} onClick={props.onUnlockAudio}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDismiss(); } }}>
      {props.stage === "intro" && <WidgetIntro trainer={trainer} photoUrl={photoUrl} welcome={welcome}
        disabled={!canStart} onOpen={props.onOpen} onChangeName={canStart && props.call.hasName ? props.call.onChangeName : undefined}
        buttonRef={elements.intro} />}
      {props.stage === "name" && <WidgetName inputRef={elements.name} initialName={props.draftName}
        enabled={canStart} invalid={props.nameInvalid} onStart={props.onStart} onInput={props.onNameInput}
        onDismiss={dismissible ? onDismiss : undefined} />}
      <WidgetCall {...props.call} visible={props.stage === "call"} />
      <p ref={elements.error} className="tt-error" id="tt-error" tabIndex={-1} role="alert" hidden={!props.errorMessage}>{props.errorMessage}</p>
    </section>
  );
}
