import { ChevronDown } from "lucide-react";
import { useState, type RefObject } from "react";

export function WidgetName({ inputRef, initialName, enabled, invalid, onStart, onInput, onDismiss }: {
  inputRef: RefObject<HTMLInputElement | null>;
  initialName?: string;
  enabled: boolean;
  invalid: boolean;
  onStart: () => void;
  onInput: () => void;
  onDismiss?: () => void;
}) {
  const [hasDraft, setHasDraft] = useState(!!initialName);
  return (
    <>
      {onDismiss && <button type="button" className="tt-icon-button tt-dismiss" aria-label="Close widget" onClick={onDismiss}>
        <ChevronDown size={18} aria-hidden="true" />
      </button>}
      <form className="tt-prejoin" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
        <label className="tt-name-hit-area">
          <input ref={inputRef} className="tt-input" id="tt-visitor-name" name="name" autoComplete="name"
            aria-label="Your name" aria-describedby="tt-error" aria-invalid={invalid || undefined}
            maxLength={80} placeholder="What’s your name?" defaultValue={initialName} required disabled={!enabled}
            onInput={(event) => { setHasDraft(!!event.currentTarget.value); onInput(); }} />
        </label>
        <button type="submit" className="tt-primary" disabled={!enabled}
          hidden={!hasDraft}>Continue</button>
      </form>
    </>
  );
}
