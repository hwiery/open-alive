/**
 * The one disclosure/dropdown arrow used across forms, so a select caret and an
 * expand toggle read as the same control family. `open` rotates it to point down.
 */
export function Chevron({ open = false, size = 12, direction = 'right' }: { open?: boolean; size?: number; direction?: 'right' | 'down' }) {
  const base = direction === 'down' ? 90 : 0;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, transform: `rotate(${open ? 90 : base}deg)`, transition: 'transform 200ms ease' }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
