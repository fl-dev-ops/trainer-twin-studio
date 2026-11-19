import { ArrowRight, PenLine, Phone } from "lucide-react";
import type { RefObject } from "react";
import { WidgetPortrait } from "./widget-portrait";
import { SwapText } from "./widget-text";

const callLabel = "Talk to my AI twin";

/**
 * The white intro card. In "name" mode the call button morphs in place into the name field and
 * the side button becomes the submit arrow, so first-time visitors never leave this card.
 */
export function WidgetIntro({ trainer, photoUrl, welcome, mode, disabled, invalid, initialName, onOpen, onStart, onNameInput,
  onChangeName, buttonRef, inputRef }: {
  trainer: string;
  photoUrl: string | null;
  welcome: string;
  mode: "intro" | "name";
  disabled: boolean;
  invalid: boolean;
  initialName?: string;
  onOpen: () => void;
  onStart: () => void;
  onNameInput: () => void;
  onChangeName?: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const naming = mode === "name";
  const title = naming ? "What should I call you?" : `Hey! I’m ${trainer}’s AI twin`;
  const body = naming ? `So ${trainer}’s twin knows who it’s talking to.`
    : welcome === callLabel ? `Ask me about ${trainer}’s work and experiences.` : welcome;
  const side = naming ? "submit" : onChangeName ? "edit" : "none";

  return (
    <div className="tt-intro tt-stage" data-mode={mode}>
      <div className="tt-intro-heading">
        <WidgetPortrait name={trainer} photoUrl={photoUrl} className="tt-intro-portrait" />
        <div>
          <SwapText as="h2" text={title} />
          <SwapText as="p" text={body} delay={60} />
        </div>
      </div>
      <form className="tt-intro-actions" noValidate onSubmit={(event) => { event.preventDefault(); if (naming) onStart(); }}>
        <div className="tt-pill">
          <button ref={buttonRef} type="button" className="tt-pill-face tt-intro-button" data-active={!naming}
            disabled={disabled} inert={naming} onClick={onOpen}>
            <Phone size={16} aria-hidden="true" />{callLabel}
          </button>
          <input ref={inputRef} className="tt-pill-face tt-input" data-active={naming} inert={!naming}
            id="tt-visitor-name" name="name" autoComplete="name" enterKeyHint="go" placeholder="Your name"
            aria-label="Your name" aria-describedby="tt-error" aria-invalid={invalid || undefined}
            maxLength={80} defaultValue={initialName} disabled={disabled} onInput={onNameInput} />
        </div>
        <div className="tt-intro-side" data-side={side}>
          {side === "submit" && <button key="submit" type="submit" className="tt-side-button tt-side-submit" aria-label="Start call"
            title="Start call" disabled={disabled}><ArrowRight size={18} aria-hidden="true" /></button>}
          {side === "edit" && <button key="edit" type="button" className="tt-side-button tt-intro-change" aria-label="Change your name"
            title="Change your name" onClick={onChangeName}><PenLine size={18} aria-hidden="true" /></button>}
        </div>
      </form>
    </div>
  );
}
