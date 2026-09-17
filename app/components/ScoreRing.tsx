/**
 * Score ring with a current value and, optionally, the value the shop would
 * reach if everything found were fixed.
 *
 * Polaris has no ring or determinate progress component, so this is a small
 * inline SVG. Structural colour (track, text) uses Polaris design tokens so it
 * tracks the merchant's admin theme including dark mode; the arcs themselves
 * are gradients, which tokens cannot express, and are chosen to stay legible
 * on both light and dark surfaces.
 */

import { useId } from "react";
import type { IconName } from "../lib/icons";

type Props = {
  label: string;
  /** Null renders as "Not measured" rather than a misleading zero. */
  score: number | null;
  potential?: number | null;
  size?: number;
  caption?: string;
  /** Icon shown beside the label. Optional so the ring stays reusable. */
  icon?: IconName;
  /**
   * The outcome a boost delivers here, in the merchant's words — "faster",
   * "compressed". It completes the gain caption ("+25% compressed"), so the
   * headroom reads as a promise rather than a deficit.
   */
  gainWord?: string;
};

const RADIUS = 50;
const STROKE = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Three bands, each a two-stop gradient. The lighter stop leads so the arc
 * brightens as it sweeps, which reads as progress rather than a flat bar.
 */
const BANDS = {
  strong: { from: "#12B981", to: "#06A47C" },
  medium: { from: "#FBBF24", to: "#E09612" },
  weak: { from: "#FB7185", to: "#E0435C" },
} as const;

/**
 * The headroom arc is green, because it is the good news: it is the ground a
 * boost wins. The risk green carries here is that it reads as ground *already*
 * won — a shop scoring 0 with 100 available looking fully optimized. Two things
 * keep the two arcs apart: this is a lighter mint held well below full opacity
 * while the current score is drawn solid on top of it, and the target and gain
 * are both spelled out in words next to the ring.
 */
const POTENTIAL = "#34D399";

function bandFor(score: number): (typeof BANDS)[keyof typeof BANDS] {
  if (score >= 80) return BANDS.strong;
  if (score >= 50) return BANDS.medium;
  return BANDS.weak;
}

export function ScoreRing({
  label,
  score,
  potential,
  size = 132,
  caption,
  icon,
  gainWord = "better",
}: Props) {
  // One gradient definition per instance: duplicate SVG ids across rings would
  // make every ring adopt whichever definition rendered last.
  const gradientId = `ring-${useId().replace(/:/g, "")}`;

  const measured = score !== null;
  const value = measured ? Math.max(0, Math.min(100, score)) : 0;
  const gain = measured && potential != null ? Math.max(0, potential - value) : 0;
  const target = Math.min(100, value + gain);

  const band = bandFor(value);
  const valueOffset = CIRCUMFERENCE * (1 - value / 100);
  // The potential arc is drawn behind the current one, so the gap between them
  // is exactly the headroom a boost would close.
  const potentialOffset = CIRCUMFERENCE * (1 - target / 100);

  return (
    <s-stack direction="block" alignItems="center" gap="small-300">
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        role="img"
        aria-label={
          measured
            ? `${label}: ${value}%${gain > 0 ? `, up to ${target}% after optimizing — ${gain} percent ${gainWord}` : ""}`
            : `${label}: not measured yet`
        }
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={band.from} />
            <stop offset="100%" stopColor={band.to} />
          </linearGradient>
        </defs>

        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke="var(--s-color-border, #E3E5E7)"
          strokeWidth={STROKE}
          opacity="0.55"
        />

        {gain > 0 && (
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke={POTENTIAL}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={potentialOffset}
            transform="rotate(-90 60 60)"
            opacity="0.45"
          />
        )}

        {measured && (
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={valueOffset}
            transform="rotate(-90 60 60)"
          />
        )}

        <text
          x="60"
          y={gain > 0 ? 58 : 68}
          textAnchor="middle"
          fontSize={measured ? 29 : 32}
          fontWeight="640"
          letterSpacing="-1"
          fill="var(--s-color-text, #202223)"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {measured ? `${value}%` : "—"}
        </text>

        {gain > 0 && (
          <text
            x="60"
            y="78"
            textAnchor="middle"
            fontSize="13"
            fontWeight="640"
            letterSpacing="-0.2"
            // The one place a literal green is right: this is the target, and
            // it has to match the headroom arc it labels. Both stops of the
            // band gradients are legible on the light and dark admin surfaces,
            // and so is this.
            fill="#059669"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            → {target}%
          </text>
        )}
      </svg>

      <s-stack direction="inline" gap="small-400" alignItems="center">
        {icon && <s-icon type={icon} tone="neutral" size="small" />}
        <s-text type="strong">{label}</s-text>
      </s-stack>

      {caption ? (
        <s-text color="subdued">{caption}</s-text>
      ) : !measured ? (
        <s-text color="subdued">Not measured</s-text>
      ) : gain > 0 ? (
        <s-stack direction="inline" gap="small-400" alignItems="center">
          <s-icon type="arrow-up" tone="success" size="small" />
          <s-text tone="success" type="strong">
            +{gain}% {gainWord}
          </s-text>
        </s-stack>
      ) : (
        <s-stack direction="inline" gap="small-400" alignItems="center">
          <s-icon type="check-circle" tone="success" size="small" />
          <s-text color="subdued">Fully optimized</s-text>
        </s-stack>
      )}
    </s-stack>
  );
}
