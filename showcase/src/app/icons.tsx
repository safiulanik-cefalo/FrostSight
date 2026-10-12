// Small line icons drawn for the HUD; currentColor so they take the text token.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const Icon = {
  Search: () => (<svg width="16" height="16" viewBox="0 0 24 24" {...P}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>),
  Alert: () => (<svg width="20" height="20" viewBox="0 0 24 24" {...P}><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17v.5" /></svg>),
  Mast: () => (<svg width="20" height="20" viewBox="0 0 24 24" {...P}><path d="M12 22V9M5 9h14M12 9L7 3M12 9l5-6" /></svg>),
  Clock: () => (<svg width="20" height="20" viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>),
  Bell: () => (<svg width="20" height="20" viewBox="0 0 24 24" {...P} strokeWidth={2}><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>),
  Road: () => (<svg width="22" height="22" viewBox="0 0 24 24" {...P} strokeWidth={2}><path d="M4 19l4-14h8l4 14" /><path d="M12 5v14" strokeDasharray="2 3" /></svg>),
  Trend: () => (<svg width="20" height="20" viewBox="0 0 24 24" {...P}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>),
  List: () => (<svg width="15" height="15" viewBox="0 0 24 24" {...P} strokeWidth={2.4}><path d="M4 6h16M4 12h16M4 18h10" /></svg>),
  Brand: () => (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 2l12 7v14l-12 7L4 23V9z" fill="var(--accent)" />
      <path d="M16 8v16M9 12l14 8M23 12L9 20" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
};
