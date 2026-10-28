import { homedir } from "node:os";
import {
  CliRenderEvents,
  RGBA,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { ActionService } from "../core/actions";
import type { DashboardService, DashboardSnapshot } from "../core/types";
import { toStyledText } from "./line";
import {
  initialState,
  listView,
  spinning,
  update,
  type Effect,
  type UiEvent,
  type UiState,
} from "./model";
import { listPageSize, render, type RenderContext, type Viewport } from "./render";
import { createTheme } from "./theme";

const TICK_MS = 120;
const INSPECT_DELAY_MS = 150;

export async function runTerminal(
  service: DashboardService,
  options: { renderer?: CliRenderer; actions?: ActionService; home?: string } = {},
): Promise<void> {
  const renderer = options.renderer ?? (await createCliRenderer({ exitOnCtrlC: false }));
  const screen = new TextRenderable(renderer, {
    id: "dashboard-screen",
    content: "",
    width: "100%",
    height: "100%",
    wrapMode: "none",
    // Unstyled text uses the terminal's own foreground and background, so light themes stay readable.
    fg: RGBA.defaultForeground(),
    bg: RGBA.defaultBackground(),
  });
  renderer.root.add(screen);

  const actions = options.actions;
  const home = options.home ?? homedir();
  const theme = createTheme(renderer.themeMode);
  const viewport: Viewport = { listTop: 0, projectsTop: 0, listScope: "" };
  let snapshot: DashboardSnapshot = service.getSnapshot();
  let state: UiState = initialState();
  let finished = false;
  let inspectTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function renderContext(): RenderContext {
    return {
      snapshot,
      width: renderer.width,
      height: renderer.height,
      now: Date.now(),
      theme,
      home,
      canAct: actions !== undefined,
    };
  }

  function context() {
    return {
      snapshot,
      now: Date.now(),
      pageSize: listPageSize(renderer.height),
      canAct: actions !== undefined,
      canExpand: listView(state, snapshot).focus !== null,
    };
  }

  function draw(): void {
    if (finished) return;
    const lines = render(state, renderContext(), viewport);
    screen.content = toStyledText(lines);
    // Updates from timers and background work do not come with input, so ask for a frame explicitly.
    renderer.requestRender();
  }

  // Coalesce bursts (a keypress followed by a promise that settles at once) into one frame per turn.
  let drawQueued = false;
  function scheduleDraw(): void {
    if (drawQueued || finished) return;
    drawQueued = true;
    setTimeout(() => {
      drawQueued = false;
      draw();
    }, 0);
  }

  function finish(): void {
    if (!finished) {
      finished = true;
      resolveExit();
    }
  }

  function dispatch(event: UiEvent): void {
    if (finished) return;
    const result = update(state, event, context());
    const changed = result.state !== state;
    state = result.state;
    if (changed || event.type !== "tick") scheduleDraw();
    for (const effect of result.effects) perform(effect);
    scheduleInspect();
  }

  function perform(effect: Effect): void {
    switch (effect.type) {
      case "quit":
        finish();
        return;
      case "refresh":
        void service.refresh(effect.repos);
        return;
      case "remeasure":
        void service.refreshSize(effect.id);
        return;
      case "prepareRemoval":
        actions!.prepareRemoval(effect.rows).then(
          (plan) => dispatch({ type: "planReady", token: effect.token, plan }),
          (error) => dispatch({ type: "planFailed", token: effect.token, error: message(error) }),
        );
        return;
      case "executeRemoval":
        actions!
          .executeRemoval(
            effect.plan,
            effect.choices,
            (id, status) => dispatch({ type: "progress", id, status }),
            () => state.jobs.find((job) => job.id === effect.jobId)?.stopping ?? false,
          )
          .then(
            (result) => dispatch({ type: "removalDone", jobId: effect.jobId, result }),
            (error) =>
              dispatch({ type: "removalFailed", jobId: effect.jobId, error: message(error) }),
          );
        return;
      case "preparePrune":
        actions!.preparePrune(effect.repoPath).then(
          (plan) => dispatch({ type: "pruneReady", token: effect.token, plan }),
          (error) => dispatch({ type: "pruneFailed", token: effect.token, error: message(error) }),
        );
        return;
      case "executePrune":
        actions!.executePrune(effect.plan).then(
          () => dispatch({ type: "pruneDone", plan: effect.plan }),
          (error) => dispatch({ type: "pruneFailed", token: null, error: message(error) }),
        );
        return;
    }
  }

  // Loads the focused row's file breakdown for the details pane once focus rests on it.
  function scheduleInspect(): void {
    if (!actions) return;
    const row = listView(state, snapshot).focus;
    if (!row || state.files[row.id]) return;
    if (inspectTimer) clearTimeout(inspectTimer);
    const generation = state.generation;
    inspectTimer = setTimeout(() => {
      inspectTimer = null;
      if (
        finished ||
        state.generation !== generation ||
        listView(state, snapshot).focus?.id !== row.id ||
        state.files[row.id]
      )
        return;
      dispatch({ type: "files", id: row.id, generation, state: { kind: "loading" } });
      actions.inspectFiles(row).then(
        (report) =>
          dispatch({ type: "files", id: row.id, generation, state: { kind: "ready", report } }),
        (error) =>
          dispatch({
            type: "files",
            id: row.id,
            generation,
            state: { kind: "error", message: message(error) },
          }),
      );
    }, INSPECT_DELAY_MS);
  }

  function onKey(key: KeyEvent): void {
    dispatch({
      type: "key",
      key: { name: key.name.toLowerCase(), char: key.sequence, ctrl: key.ctrl },
    });
  }

  const unsubscribe = service.subscribe((next) => {
    snapshot = next;
    dispatch({ type: "snapshot" });
  });
  const ticker = setInterval(() => {
    if (state.toast || spinning(state, snapshot)) dispatch({ type: "tick" });
  }, TICK_MS);
  renderer.keyInput.on("keypress", onKey);
  renderer.on(CliRenderEvents.RESIZE, draw);
  renderer.once("destroy", finish);
  draw();
  void service.refresh();
  try {
    await exit;
  } finally {
    clearInterval(ticker);
    if (inspectTimer) clearTimeout(inspectTimer);
    unsubscribe();
    renderer.keyInput.off("keypress", onKey);
    renderer.off(CliRenderEvents.RESIZE, draw);
    renderer.destroy();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
