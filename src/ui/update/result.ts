import type { Context, Result, Tone, UiState } from "../state";

export const same = (state: UiState): Result => ({ state, effects: [] });
export const quit = (state: UiState): Result => ({ state, effects: [{ type: "quit" }] });

export function toast(
  state: UiState,
  ctx: Context,
  text: string,
  tone: Tone = "info",
  ms = 4000,
): UiState {
  return { ...state, toast: { text, tone, until: ctx.now + ms } };
}
