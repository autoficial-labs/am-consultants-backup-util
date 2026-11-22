import { useId } from 'react';

/** The AM Backup mark (same drawing as the app icon). */
export function AppMark({ size = 32 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="64 64 896 896" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2B88D8" />
          <stop offset="1" stopColor="#0A4F8C" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill={`url(#bg${id})`} />
      <path
        d="M332 706h372c78 0 140-60 140-136 0-72-56-130-128-136-16-104-104-180-210-180-90 0-168 56-198 138-80 8-142 74-142 156 0 88 72 158 166 158z"
        fill="#fff"
      />
      <path d="M512 382l-112 118h76v128h72V500h76z" fill="#0F6CBD" />
    </svg>
  );
}
