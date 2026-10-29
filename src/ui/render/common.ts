import { seg, type Line } from "../line";
import type { UiState } from "../state";
import type { Theme } from "../theme";

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export const key = (theme: Theme, text: string): Line[number] =>
  seg(text, { fg: theme.accent, bold: true });
export const dim = (text: string): Line[number] => seg(text, { dim: true });
export const spinner = (state: UiState) => SPINNER[state.frame % SPINNER.length]!;
