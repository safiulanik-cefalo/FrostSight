import { levelLabel, type Level, type LevelOrNone } from "../../shared/contract";

const CLS: Record<LevelOrNone, string> = { LOW: "low", MEDIUM: "medium", HIGH: "high", VERY_HIGH: "very-high", NONE: "none" };

/** A level as dot plus word in its tinted pill; colour is never the only signal. */
export function LevelPill({ level, small }: { level: LevelOrNone; small?: boolean }) {
  return <span className={`pill ${CLS[level]}${small ? " sm" : ""}`}>{level === "NONE" ? "No data" : levelLabel(level as Level)}</span>;
}

export function TonePill({ tone, children }: { tone: "low" | "medium" | "high" | "none" | "sim"; children: string }) {
  return <span className={`pill ${tone} sm`}>{children}</span>;
}

export function ScoreBar({ score, level }: { score: number | null; level: LevelOrNone }) {
  return (
    <span className="bar" aria-hidden="true">
      <i className={CLS[level]} style={{ width: `${Math.round((score ?? 0) * 100)}%` }} />
    </span>
  );
}

export const levelClass = (l: LevelOrNone) => CLS[l];
