export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#cf2845" />
      <path d="M16.5 8.2a5.2 5.2 0 1 0 0 7.6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M6 12h6.5" stroke="#fff" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.6 2.2" />
    </svg>
  )
}
