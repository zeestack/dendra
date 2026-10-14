// The dendra mark, inlined so it's crisp at any size and needs no asset wiring.
// A branching "dendrite" with the brand gradient (blue → teal).

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label="dendra"
    >
      <defs>
        <linearGradient id="dendraMark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c9cff" />
          <stop offset="1" stopColor="#5be3b3" />
        </linearGradient>
      </defs>
      <g
        transform="translate(26,64)"
        stroke="url(#dendraMark)"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      >
        <path d="M0,0 C22,0 22,-30 44,-30" />
        <path d="M0,0 C22,0 22,30 44,30" />
        <path d="M44,-30 C66,-30 66,-50 88,-50" />
        <path d="M44,-30 C66,-30 66,-10 88,-10" />
        <path d="M44,30 C66,30 66,10 88,10" />
        <path d="M44,30 C66,30 66,50 88,50" />
      </g>
      <g transform="translate(26,64)">
        <circle cx="0" cy="0" r="9" fill="#5be3b3" />
        <circle cx="44" cy="-30" r="5" fill="#7fd6c4" />
        <circle cx="44" cy="30" r="5" fill="#7fd6c4" />
        <circle cx="88" cy="-50" r="6" fill="#7c9cff" />
        <circle cx="88" cy="-10" r="6" fill="#7c9cff" />
        <circle cx="88" cy="10" r="6" fill="#7c9cff" />
        <circle cx="88" cy="50" r="6" fill="#7c9cff" />
      </g>
    </svg>
  );
}
