import { useState } from "react";

export function WidgetPortrait({ name, photoUrl, className }: { name: string; photoUrl: string | null; className: string }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = !!photoUrl && !photoFailed;
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part.charAt(0)).join("");
  return (
    <div className={`tt-portrait ${className}`} aria-hidden="true">
      <span className="tt-initials" hidden={showPhoto}>{initials}</span>
      {showPhoto && <img className="tt-photo" src={photoUrl} alt="" referrerPolicy="no-referrer" loading="eager"
        fetchPriority="high" decoding="async" onError={() => setPhotoFailed(true)} />}
    </div>
  );
}
