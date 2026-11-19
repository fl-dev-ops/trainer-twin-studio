import { Phone } from "lucide-react";
import type { RefObject } from "react";
import { WidgetPortrait } from "./widget-portrait";

const callLabel = "Talk to my AI twin";

export function WidgetIntro({ trainer, photoUrl, welcome, disabled, onOpen, onChangeName, buttonRef }: {
  trainer: string;
  photoUrl: string | null;
  welcome: string;
  disabled: boolean;
  onOpen: () => void;
  onChangeName?: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="tt-intro">
      <div className="tt-intro-heading">
        <WidgetPortrait name={trainer} photoUrl={photoUrl} className="tt-intro-portrait" />
        <div>
          <h2>Hey! I’m {trainer}’s AI twin</h2>
          <p>{welcome === callLabel ? `Ask me about ${trainer}’s work and experiences.` : welcome}</p>
        </div>
      </div>
      <div className="tt-intro-actions">
        <button ref={buttonRef} type="button" className="tt-intro-button" disabled={disabled} onClick={onOpen}>
          <Phone size={16} aria-hidden="true" />{callLabel}
        </button>
        {onChangeName && <button type="button" className="tt-intro-change" aria-label="Change your name" onClick={onChangeName}>Change name</button>}
      </div>
    </div>
  );
}
