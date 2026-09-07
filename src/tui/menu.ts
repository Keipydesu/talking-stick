import { CHAT_ACTIONS, type ChatAction } from "./actions.js";
import type { ActionConfiguration } from "./availability.js";

export type MenuStage = "closed" | "browse" | "options" | "help" | "global_help";

export interface ActionMenuState {
  stage: MenuStage;
  returnStage: Exclude<MenuStage, "help">;
  selectedActionId: string;
  selectedOptionIndex: number;
  filter: string;
  configurations: Record<string, ActionConfiguration>;
}

export type MenuEvent =
  | { type: "open" }
  | { type: "global_help" }
  | { type: "up" }
  | { type: "down" }
  | { type: "right" }
  | { type: "left" }
  | { type: "escape" }
  | { type: "help" }
  | { type: "filter"; value: string }
  | { type: "backspace" }
  | { type: "toggle" };

export function createMenuState(): ActionMenuState {
  return {
    stage: "closed",
    returnStage: "browse",
    selectedActionId: CHAT_ACTIONS.find((action) => action.id === "take")?.id ?? "help",
    selectedOptionIndex: 0,
    filter: "",
    configurations: {}
  };
}

export function updateMenu(
  state: ActionMenuState,
  event: MenuEvent,
  actions: ChatAction[] = CHAT_ACTIONS
): ActionMenuState {
  if (event.type === "open") {
    return { ...state, stage: "browse", filter: "" };
  }
  if (event.type === "global_help") {
    return { ...state, stage: "global_help", returnStage: "closed" };
  }
  if (event.type === "escape") {
    if (state.stage === "options") return { ...state, stage: "browse" };
    if (state.stage === "help") return { ...state, stage: state.returnStage };
    return { ...state, stage: "closed", filter: "" };
  }
  if (event.type === "help") {
    if (state.stage === "global_help") return { ...state, stage: "closed" };
    if (state.stage === "help") return { ...state, stage: state.returnStage };
    if (state.stage === "closed") return { ...state, stage: "global_help", returnStage: "closed" };
    return { ...state, returnStage: state.stage, stage: "help" };
  }
  if (state.stage === "closed" || state.stage === "global_help" || state.stage === "help") {
    return state;
  }

  const action = selectedAction(state, actions);
  if (state.stage === "options") {
    if (!action) return state;
    if (event.type === "left") return { ...state, stage: "browse" };
    if (event.type === "up" || event.type === "down") {
      const direction = event.type === "up" ? -1 : 1;
      return {
        ...state,
        selectedOptionIndex: wrapIndex(
          state.selectedOptionIndex + direction,
          Math.max(1, action.options.length)
        )
      };
    }
    if (event.type === "toggle") {
      const option = action.options[state.selectedOptionIndex];
      if (!option || option.kind !== "boolean") return state;
      const configuration = state.configurations[action.id] ?? {};
      return setMenuOption(state, action.id, option.id, configuration[option.id] !== true);
    }
    return state;
  }

  if (event.type === "right") {
    if (!action || action.options.length === 0 || action.guidedForm) return state;
    return { ...state, stage: "options", selectedOptionIndex: 0 };
  }
  if (event.type === "filter") {
    const filter = `${state.filter}${event.value}`;
    const visible = filteredActions(actions, filter);
    return {
      ...state,
      filter,
      selectedActionId: visible[0]?.id ?? state.selectedActionId
    };
  }
  if (event.type === "backspace") {
    const filter = state.filter.slice(0, -1);
    const visible = filteredActions(actions, filter);
    return {
      ...state,
      filter,
      selectedActionId: visible[0]?.id ?? state.selectedActionId
    };
  }
  if (event.type === "up" || event.type === "down") {
    const visible = filteredActions(actions, state.filter);
    if (visible.length === 0) return state;
    const current = Math.max(0, visible.findIndex((candidate) => candidate.id === state.selectedActionId));
    const direction = event.type === "up" ? -1 : 1;
    return {
      ...state,
      selectedActionId: visible[wrapIndex(current + direction, visible.length)].id
    };
  }
  return state;
}

export function setMenuOption(
  state: ActionMenuState,
  actionId: string,
  optionId: string,
  value: string | boolean
): ActionMenuState {
  return {
    ...state,
    configurations: {
      ...state.configurations,
      [actionId]: {
        ...(state.configurations[actionId] ?? {}),
        [optionId]: value
      }
    }
  };
}

export function selectedAction(
  state: ActionMenuState,
  actions: ChatAction[] = CHAT_ACTIONS
): ChatAction | undefined {
  return actions.find((action) => action.id === state.selectedActionId) ?? actions[0];
}

export function filteredActions(
  actions: ChatAction[],
  filter: string
): ChatAction[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return actions;
  return actions.filter((action) =>
    action.name.includes(normalized) ||
    action.aliases.some((alias) => alias.includes(normalized)) ||
    action.description.toLowerCase().includes(normalized)
  );
}

export function actionConfiguration(
  state: ActionMenuState,
  action: ChatAction
): ActionConfiguration {
  const configured = state.configurations[action.id] ?? {};
  return Object.fromEntries(action.options.map((option) => [
    option.id,
    configured[option.id] ?? option.defaultValue
  ]));
}

export function buildCommandPreview(
  action: ChatAction,
  configuration: ActionConfiguration
): string {
  const parts = action.cli.split(/\s+/);
  for (const option of action.options) {
    const configured = configuration[option.id];
    if (option.kind === "boolean") {
      if (configured === true) parts.push(option.cliFlag ?? option.syntax);
      continue;
    }
    if (typeof configured !== "string" || !configured.trim()) continue;
    if (option.cliFlag) parts.push(option.cliFlag);
    parts.push(configured);
  }
  return parts.map(shellQuote).join(" ");
}

export function buildChatInput(
  action: ChatAction,
  configuration: ActionConfiguration
): string {
  const args: string[] = [];
  const value = (id: string) => {
    const configured = configuration[id];
    return typeof configured === "string" ? configured.trim() : "";
  };
  switch (action.name) {
    case "msg":
      args.push(value("member"), value("message"));
      break;
    case "history":
      args.push(value("count"));
      break;
    case "note":
      args.push(value("text"));
      break;
    case "take":
      args.push(value("reason"));
      break;
    case "assign":
      args.push(value("member"));
      break;
    case "kick":
      args.push(value("member"), value("reason"));
      if (configuration.force === true) args.push("--force");
      break;
    case "quit":
      if (configuration.force === true) args.push("--force");
      break;
  }
  return `/${action.name}${args.filter(Boolean).map((argument) => ` ${shellQuote(argument)}`).join("")}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}
