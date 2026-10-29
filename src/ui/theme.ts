import { RGBA } from "@opentui/core";
import type { Verdict } from "../core/types";

export interface Theme {
  safe: RGBA;
  review: RGBA;
  busy: RGBA;
  broken: RGBA;
  orphaned: RGBA;
  accent: RGBA;
  focusBg: RGBA;
  toastBg: RGBA;
}

/**
 * Semantic colors use the terminal's own ANSI palette, so they follow the user's theme.
 * Only the focus bar is a fixed tint, picked for the terminal's light or dark mode.
 */
export function createTheme(mode: "dark" | "light" | null): Theme {
  const light = mode === "light";
  return {
    safe: RGBA.fromIndex(2),
    review: RGBA.fromIndex(3),
    busy: RGBA.fromIndex(4),
    broken: RGBA.fromIndex(1),
    orphaned: RGBA.fromIndex(5),
    accent: RGBA.fromIndex(6),
    focusBg: RGBA.fromHex(light ? "#dfe3ea" : "#2b303b"),
    toastBg: RGBA.fromHex(light ? "#f3ead2" : "#3a3222"),
  };
}

export function verdictColor(theme: Theme, verdict: Verdict): RGBA {
  switch (verdict) {
    case "Safe":
      return theme.safe;
    case "Review":
      return theme.review;
    case "Busy":
      return theme.busy;
    case "Broken":
      return theme.broken;
    case "Orphaned":
      return theme.orphaned;
  }
}
