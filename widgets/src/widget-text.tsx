import { Fragment, type CSSProperties, type Ref } from "react";

/**
 * Text that re-plays a soft word-by-word rise whenever its content changes.
 * Words are keyed by the full text, so unrelated re-renders never restart the animation.
 */
export function SwapText({ as: Tag, text, className, delay = 0, ref, tabIndex }: {
  as: "h2" | "p";
  text: string;
  className?: string;
  delay?: number;
  ref?: Ref<HTMLHeadingElement & HTMLParagraphElement>;
  tabIndex?: number;
}) {
  const words = text.split(/\s+/u).filter(Boolean);
  return (
    <Tag ref={ref} className={className} tabIndex={tabIndex}>
      {words.map((word, index) => (
        <Fragment key={`${text}:${index}`}>
          {index > 0 && " "}
          <span className="tt-word" style={{ "--tt-word-delay": `${delay + index * 24}ms` } as CSSProperties}>{word}</span>
        </Fragment>
      ))}
    </Tag>
  );
}
