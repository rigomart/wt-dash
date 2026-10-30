import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTheme } from "../src/ui/theme";

/** WCAG 2 contrast ratio between two colors. */
function contrast(a: RGBA, b: RGBA): number {
  const luminance = (color: RGBA) => {
    const [r, g, b] = color.toInts().map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

test("the confirm button's text is readable on its red, and the red stands out from the terminal, in every mode (#61)", () => {
  const black = RGBA.fromHex("#000000");
  const white = RGBA.fromHex("#ffffff");
  for (const [mode, terminal] of [
    ["dark", black],
    [null, black],
    ["light", white],
  ] as const) {
    const theme = createTheme(mode);
    expect(contrast(theme.confirmFg, theme.confirmBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.confirmBg, terminal)).toBeGreaterThanOrEqual(3);
  }
});
