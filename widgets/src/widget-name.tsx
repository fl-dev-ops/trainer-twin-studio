import { useState, type RefObject } from "react";

export function WidgetName({ inputRef, initialName, enabled, invalid, onStart, onInput }: {
  inputRef: RefObject<HTMLInputElement | null>;
  initialName?: string;
  enabled: boolean;
  invalid: boolean;
  onStart: () => void;
  onInput: () => void;
}) {
  const [hasDraft, setHasDraft] = useState(!!initialName);
  return (
    <form className="tt-prejoin" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
      <label className="tt-name-hit-area">
        <span className="tt-name-prompt">What’s your name?</span>
        <input ref={inputRef} className="tt-input" id="tt-visitor-name" name="name" autoComplete="name" enterKeyHint="enter"
          aria-label="Your name" aria-describedby={hasDraft ? "tt-name-hint tt-error" : "tt-error"} aria-invalid={invalid || undefined}
          maxLength={80} defaultValue={initialName} required disabled={!enabled}
          onInput={(event) => { setHasDraft(!!event.currentTarget.value.trim()); onInput(); }} />
      </label>
      <p className="tt-name-hint" id="tt-name-hint" hidden={!hasDraft}>Press Enter to continue</p>
    </form>
  );
}
