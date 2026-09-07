import path from "node:path";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { CHAT_ACTIONS } from "./actions.js";
import { actionAvailability, type CapabilitySnapshot } from "./availability.js";
import {
  actionConfiguration,
  buildCommandPreview,
  filteredActions,
  menuWindow,
  selectedAction,
  type ActionMenuState
} from "./menu.js";
import type { ChatEventEntry, ChatState } from "./model.js";
import type { EditorSnapshot } from "./editor.js";
import { createTheme, type TuiTheme } from "./theme.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface RenderOptions {
  color?: boolean;
  width?: number;
  maxRows?: number;
  members?: ChatState["members"];
}

export interface FrameInput {
  state: ChatState;
  menu: ActionMenuState;
  capability: CapabilitySnapshot | null;
  editor: EditorSnapshot;
  width: number;
  rows: number;
  color?: boolean;
  scrollOffset?: number;
}

export function renderEvent(
  entry: ChatEventEntry,
  options: RenderOptions = {}
): string {
  const event = entry.event;
  const theme = renderTheme(options);
  const time = new Date(event.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const from = agentLabel(event.from_agent_id, options.members);
  const styledFrom = renderAgent(event.from_agent_id, from, theme);
  let text: string;
  switch (event.event_type) {
    case "message_sent": {
      const target = event.to_agent_id
        ? agentLabel(event.to_agent_id, options.members)
        : "room";
      const styledTime = theme.dim(time);
      const fromColumn = renderAgent(
        event.from_agent_id,
        from.padEnd(12),
        theme
      );
      const targetColumn = event.to_agent_id
        ? renderAgent(event.to_agent_id, target.padEnd(12), theme)
        : target.padEnd(12);
      text = `${styledTime}  ${fromColumn} -> ${targetColumn} ${event.payload?.body ?? ""}`;
      break;
    }
    case "join":
      text = `${time}  · ${styledFrom} joined`;
      break;
    case "leave":
      text = `${time}  · ${styledFrom} left`;
      break;
    case "kick":
      text = `${time}  · ${renderEventAgent(event.to_agent_id, options)} was kicked by ${styledFrom}${event.reason ? ` (${event.reason})` : ""}`;
      break;
    case "claim":
      text = `${time}  · ${renderEventAgent(event.to_agent_id, options)} took the stick`;
      break;
    case "takeover":
      text = `${time}  · ${renderEventAgent(event.to_agent_id, options)} took over${event.reason ? ` (${event.reason})` : ""}`;
      break;
    case "release":
      text = `${time}  · ${styledFrom} released the stick${event.handoff?.status ? ` — ${event.handoff.status}` : ""}`;
      break;
    case "pass":
      text = `${time}  · ${styledFrom} passed to ${renderEventAgent(event.to_agent_id, options)}${event.handoff?.status ? ` — ${event.handoff.status}` : ""}`;
      break;
    case "close":
      text = `${time}  · room closed`;
      break;
    case "reservation_expired":
      text = `${time}  · reservation for ${renderEventAgent(event.to_agent_id, options)} expired`;
      break;
    case "session_superseded":
      text = `${time}  · ${renderEventAgent(event.to_agent_id, options)} session superseded`;
      break;
    default:
      text = `${time}  · ${event.event_type} ${styledFrom}`;
  }
  const fitted = fitWidth(text, options.width);
  return entry.historical ? theme.dim(fitted) : fitted;
}

export function renderStatusBar(
  state: ChatState,
  options: RenderOptions = {}
): string {
  const room = path.basename(state.canonicalPath) || state.canonicalPath;
  const activeMembers = state.members.filter((member) => member.status === "active").length;
  const stick = renderStick(state, options);
  return fitWidth(
    `-- ${room} · ${activeMembers} ${activeMembers === 1 ? "member" : "members"} · ${stick} `,
    options.width,
    "-"
  );
}

export function renderDashboard(
  state: ChatState,
  options: RenderOptions = {}
): string[] {
  const theme = renderTheme(options);
  if (options.width && options.width < 48) {
    return [renderStatusBar(state, options)];
  }
  if (options.width && options.width < 72) {
    const active = state.members.filter((member) => member.status === "active").length;
    return [
      renderStatusBar(state, options),
      renderCwdSummary(state.workingDirectory, active, options.width)
    ];
  }
  const title = theme.accent(`╭─ talking-stick · ${state.room.state}`);
  const members = [...state.members]
    .sort((left, right) => Number(right.status === "active") - Number(left.status === "active"))
    .map((member) => renderMember(state, member, theme));
  const cwdLabel = theme.dim("cwd");
  const membersLabel = theme.dim("members");
  const bottom = `${theme.accent("╰─")} ${renderStick(state, options)} · Tab actions · ? help`;

  const memberRows = renderMemberRows(membersLabel, members, options.width);
  const maxMemberRows = options.maxRows
    ? Math.max(1, options.maxRows - 3)
    : memberRows.length;
  const visibleMemberRows = memberRows.slice(0, maxMemberRows);
  if (memberRows.length > maxMemberRows) {
    visibleMemberRows[maxMemberRows - 1] = fitWidth(
      `│ ${padVisible(membersLabel, 8)}… ${memberRows.length - maxMemberRows + 1} more`,
      options.width,
      " "
    );
  }
  return [
    fitWidth(title, options.width, "─"),
    renderCwdRow(cwdLabel, state.workingDirectory, options.width),
    ...visibleMemberRows,
    fitWidth(bottom, options.width, "─")
  ];
}

export function renderFrame(input: FrameInput): string[] {
  const frame = renderBaseFrame(input);
  const theme = renderTheme({ color: input.color });
  if (input.menu.stage === "closed" || !input.capability) return frame;
  const size = popupSize(input.width, input.rows);
  if (size.width < 6 || size.rows < 3) return frame;
  const content = renderActionMenu(input.menu, input.capability, {
    color: input.color, width: size.width - 4, maxRows: size.rows - 2
  });
  const popup = [
    theme.border(`┌${"─".repeat(size.width - 2)}┐`),
    ...Array.from({ length: size.rows - 2 }, (_, i) => `${theme.border("│")} ${fitWidth(content[i] ?? "", size.width - 4, " ")} ${theme.border("│")}`),
    theme.border(`└${"─".repeat(size.width - 2)}┘`)
  ];
  const left = Math.floor((input.width - size.width) / 2);
  const top = Math.max(0, Math.floor((input.rows - size.rows - 2) / 2));
  return frame.map((line, row) => {
    if (row < top || row >= top + popup.length) return line;
    // The background remains visible on all sides; reset its colors before
    // painting the opaque modal so selected rows cannot inherit dim styling.
    return `${sliceCells(line, 0, left)}${input.color ? RESET : ""}${popup[row - top]}${sliceCells(line, left + size.width, input.width)}`;
  });
}

export function popupSize(width: number, rows: number): { width: number; rows: number } {
  return { width: Math.min(64, Math.max(1, width - 4)), rows: Math.min(19, Math.max(1, rows - 6)) };
}

export function activitySize(width: number, rows: number): { width: number; rows: number } {
  if (width < 72 || rows < 12) return { width, rows: Math.max(1, rows - 5) };
  const sidebar = Math.min(30, Math.max(22, Math.floor(width * 0.27)));
  return { width: width - sidebar - 2, rows: Math.max(1, rows - 6) };
}

function renderBaseFrame(input: FrameInput): string[] {
  const width = Math.max(1, input.width);
  const rows = Math.max(1, input.rows);
  const theme = renderTheme({ color: input.color });
  if (width < 24 || rows < 8) {
    const compact = [
      renderStatusBar(input.state, { color: input.color, width }),
      renderInputLine(input.editor, width),
      fitWidth("Tab actions · ? help · /quit detach", width, " ")
    ];
    return exactRows(compact, width, rows);
  }

  if (width < 72 || rows < 12) {
    const activity = renderActivity(input.state, width, Math.max(1, rows - 5), input.color, input.scrollOffset);
    return exactRows([
      theme.accent(fitWidth(`talking-stick · ${input.state.room.state}`, width, "─")),
      fitWidth(`cwd  ${displayPath(input.state.workingDirectory, Math.max(1, width - 5))}`, width, " "),
      fitWidth(`turn ${input.state.room.turn_id} · ${plainStick(input.state)}`, width, " "),
      ...activity,
      renderInputLine(input.editor, width),
      fitWidth("Tab actions · PgUp/PgDn scroll · Ctrl-E live · /quit", width, " ")
    ], width, rows);
  }

  const sidebarWidth = Math.min(30, Math.max(22, Math.floor(width * 0.27)));
  const leftWidth = width - sidebarWidth - 1;
  const contentRows = Math.max(1, rows - 6);
  const paneWidth = Math.max(1, leftWidth - 1);
  const activity = renderActivity(input.state, paneWidth, contentRows, input.color, input.scrollOffset);
  const memberWidth = sidebarWidth - 3;
  const members = [...input.state.members]
    .sort((left, right) => Number(right.status === "active") - Number(left.status === "active"))
    .flatMap((member) => wrapText(renderSidebarMember(input.state, member), memberWidth).map((line, index) => {
      const self = member.agent_id === input.state.selfAgentId;
      const operator = isOperator(input.state, member);
      const holder = member.agent_id === input.state.room.owner;
      let styled = operator ? theme.operator(line, self) : holder ? theme.holder(line) : line;
      if (operator && holder && index === 0) {
        styled = `${theme.holder("o--")}${theme.operator(line.slice(3), self)}`;
      }
      return `  ${member.status === "inactive" ? theme.dim(styled) : styled}`;
    }));
  const activeMembers = input.state.members.filter((member) => member.status === "active").length;
  const legend = wrapText("o-- stick · o-> reserved · operator", memberWidth).map((line) =>
    `  ${line.replace("o-- stick", theme.holder("o-- stick")).replace("operator", theme.operator("operator"))}`
  );
  const legendStart = contentRows + 1 - legend.length;
  const memberRows = Array.from({ length: contentRows + 1 }, (_, index) =>
    index >= legendStart ? legend[index - legendStart] : members[index] ?? ""
  );
  const roomStatus = input.state.room.state === "idle" ? "stick free" : input.state.room.state;
  const result: string[] = [];
  result.push(joinColumns(
    theme.accent(fitWidth(`┌─ talking-stick · turn ${input.state.room.turn_id} · ${roomStatus} `, leftWidth, "─")),
    "",
    leftWidth,
    sidebarWidth,
    theme,
    "┬",
    "─",
    "┐"
  ));
  result.push(joinColumns(
    `${theme.border("│")} ${displayPath(input.state.workingDirectory, Math.max(1, leftWidth - 3))}`,
    `  ${theme.accent(`MEMBERS · ${activeMembers} active`)}`,
    leftWidth,
    sidebarWidth,
    theme
  ));
  result.push(joinColumns(
    theme.accent(fitWidth(`├─ TIMELINE · ${input.scrollOffset ? "history · Ctrl-E live" : "live"} `, leftWidth, "─")),
    memberRows[0] ?? "",
    leftWidth,
    sidebarWidth,
    theme,
    "┤"
  ));
  for (let index = 0; index < contentRows; index += 1) {
    const right = memberRows[index + 1] ?? "";
    result.push(joinColumns(
      `${theme.border("│")}${fitWidth(activity[index] ?? "", paneWidth, " ")}`,
      right,
      leftWidth,
      sidebarWidth,
      theme
    ));
  }
  result.push(joinColumns(
    theme.border("└".padEnd(leftWidth, "─")),
    "",
    leftWidth,
    sidebarWidth,
    theme,
    "┴",
    "─",
    "┘"
  ));
  result.push(renderInputLine(input.editor, width));
  result.push(fitWidth("Tab actions · PgUp/PgDn scroll · Ctrl-E live · ? help · /quit", width, " "));
  return exactRows(result, width, rows);
}

export function renderActionMenu(
  menu: ActionMenuState,
  snapshot: CapabilitySnapshot,
  options: RenderOptions = {}
): string[] {
  const theme = renderTheme(options);
  const width = options.width;
  const maxRows = Math.max(5, options.maxRows ?? 12);
  if (menu.stage === "global_help") {
    return fitRows([
      theme.accent("ACTIONS & HELP"),
      "Tab opens actions. j/k or ↑↓ move; 1–9 select; Enter runs.",
      "The stick grants one guarded writer turn. Messages converse; notes persist; handoffs transfer work.",
      "h/l back/options · / search · ? action help · Esc back/close.",
      "PgUp/PgDn or Ctrl-U/D scroll. Ctrl-E returns to live activity.",
      theme.dim("? / Esc close")
    ], width, maxRows);
  }

  const action = selectedAction(menu);
  if (!action) return [];
  if (menu.stage === "browse" && filteredActions(CHAT_ACTIONS, menu.filter).length === 0) {
    return menuWithFooter([
      theme.accent(`ACTIONS · search: ${menu.filter}${menu.searching ? "▏" : ""}`),
      "No matching actions"
    ], ["Backspace edits search · / search · Esc closes"], width, maxRows);
  }
  const configuration = actionConfiguration(menu, action);
  const verdict = actionAvailability(action, snapshot, configuration);
  if (menu.stage === "help") {
    return fitRows([
      theme.accent(`${action.name} — help`),
      action.description,
      verdict === true ? "Available now" : `Unavailable: ${verdict}`,
      ...(action.options.length > 0
        ? action.options.map((option) => `${option.syntax} — ${option.description}`)
        : ["No configurable options."]),
      `Equivalent: ${buildCommandPreview(action, configuration)}`,
      theme.dim("? / Esc back")
    ], width, maxRows);
  }
  if (menu.stage === "options") {
    const rows = action.options.map((option, index) => {
      const configured = configuration[option.id];
      const marker = index === menu.selectedOptionIndex ? ">" : " ";
      const value = option.kind === "boolean"
        ? `[${configured === true ? "x" : " "}]`
        : typeof configured === "string" && configured ? configured : option.syntax;
      const row = `${marker} ${index + 1} ${option.id.padEnd(14)} ${value}`;
      return index === menu.selectedOptionIndex ? theme.bold(row) : row;
    });
    const selectedOption = action.options[menu.selectedOptionIndex];
    return menuWithFooter([
      theme.accent(`${action.name} · options`),
      ...rows
    ], [
      theme.border("─".repeat(width ?? 60)),
      ...wrapText(selectedOption?.description ?? action.description, width ?? 60),
      `Preview: ${buildCommandPreview(action, configuration)}`,
      verdict === true ? "Available now" : `Unavailable: ${verdict}`,
      theme.dim("j/k move · 1–9 select · Space edit/toggle"),
      theme.dim("Enter run · h back · ? help · Esc back")
    ], width, maxRows);
  }

  const visible = filteredActions(CHAT_ACTIONS, menu.filter);
  const shown = menuWindow(menu, maxRows);
  const rows = shown.map((candidate, index) => {
    const configured = actionConfiguration(menu, candidate);
    const available = actionAvailability(candidate, snapshot, configured);
    const marker = candidate.id === action.id ? ">" : " ";
    const row = `${marker} ${index + 1} ${candidate.name}${available === true ? "" : " · unavailable"}`;
    if (candidate.id === action.id) return theme.bold(row);
    return available === true ? row : theme.dim(row);
  });
  const description = wrapText(action.description, width ?? 60);
  const hints = [
    theme.dim(menu.searching ? "Type to search · Enter finish · Esc finish" : "j/k move · 1–9 select · Enter run · l options"),
    theme.dim("h back · / search · ? help · Esc close")
  ];
  const footer = maxRows >= 10 ? [
    theme.border("─".repeat(width ?? 60)),
    description[0] ?? "",
    description[1] ?? "",
    verdict === true ? "Available now" : `Unavailable: ${verdict}`,
    ...hints
  ] : [
    verdict === true ? action.description : `Unavailable: ${verdict}`,
    ...hints
  ];
  return menuWithFooter([
    theme.accent(`ACTIONS · ${Math.max(0, visible.findIndex((candidate) => candidate.id === action.id)) + 1}/${visible.length}${menu.searching || menu.filter ? ` · search: ${menu.filter}${menu.searching ? "▏" : ""}` : ""}`),
    ...rows
  ], footer, width, maxRows);
}

function menuWithFooter(body: string[], footer: string[], width: number | undefined, rows: number): string[] {
  const footerRows = footer.slice(-Math.max(1, rows - 2));
  const bodyRows = rows - footerRows.length;
  return [
    ...Array.from({ length: bodyRows }, (_, index) => fitWidth(body[index] ?? "", width, " ")),
    ...footerRows.map((line) => fitWidth(line, width, " "))
  ];
}

export function renderPalette(command?: string): string[] {
  if (command) {
    const normalized = command.replace(/^\//, "").toLowerCase();
    const found = CHAT_ACTIONS.find(
      (action) => action.name === normalized || action.aliases.includes(normalized)
    );
    if (!found) {
      return [`No chat action /${normalized}. Type /help to list actions.`];
    }
    return [
      `/${found.name}${found.usage ? ` ${found.usage}` : ""} — ${found.description}`,
      `Equivalent: ${found.cli}`
    ];
  }
  return [
    "Type a message and press Enter to send it to the room.",
    ...CHAT_ACTIONS.map(
      (action) =>
        `  /${action.name}${action.usage ? ` ${action.usage}` : ""}`.padEnd(35) +
        action.description
    ),
    "For administrative commands, run `tt help` outside chat."
  ];
}

export function completionCandidates(
  line: string,
  members: Array<{ agent_id: string }>
): string[] {
  if (!line.startsWith("/")) return [];
  const words = line.slice(1).split(/\s+/);
  if (words.length === 1) {
    const prefix = words[0].toLowerCase();
    return CHAT_ACTIONS.flatMap((action) => [action.name, ...action.aliases])
      .filter((name) => name.startsWith(prefix))
      .map((name) => `/${name}`);
  }
  const actionName = words[0].toLowerCase();
  const action = CHAT_ACTIONS.find(
    (candidate) =>
      candidate.name === actionName || candidate.aliases.includes(actionName)
  );
  if (!action?.memberArgument || words.length > 2) return [];
  const memberPrefix = words[1].toLowerCase();
  return members
    .map((member) => member.agent_id)
    .filter((agentId) => agentId.toLowerCase().startsWith(memberPrefix))
    .map((agentId) => `/${actionName} ${agentId}`);
}

export function renderTeachingCommand(
  command: string,
  args: string[] = [],
  color = true
): string {
  const text = `→ ${[...command.split(/\s+/), ...args].map(shellQuote).join(" ")}`;
  return createTheme({ isTTY: color, env: {} }).dim(text);
}

export function renderError(message: string, color = true): string {
  return createTheme({ isTTY: color, env: {} }).error(message);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function shortAgent(agentId: string | null): string {
  if (!agentId) return "system";
  const [kind, value] = agentId.split(":", 2);
  if (kind === "human") return value || agentId;
  return kind || agentId;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function renderStick(state: ChatState, options: RenderOptions): string {
  if (["stale_owner", "owner_gone", "owner_idle", "recipient_gone"].includes(state.room.state)) {
    return `takeover available (${state.room.state}) — /take`;
  }
  if (state.room.owner === state.selfAgentId) {
    return "your turn — /release when done";
  }
  if (state.room.owner) {
    return `stick: ${renderEventAgent(state.room.owner, {
      ...options,
      members: state.members
    })}`;
  }
  if (state.room.reserved_for === state.selfAgentId) {
    return "reserved for you — /take";
  }
  if (state.room.reserved_for) {
    return `reserved: ${renderEventAgent(state.room.reserved_for, {
      ...options,
      members: state.members
    })}`;
  }
  if (state.room.state === "closed") return "room closed";
  return "stick: free — /take";
}

function renderMember(
  state: ChatState,
  member: ChatState["members"][number],
  theme: TuiTheme
): string {
  const marker = member.agent_id === state.room.owner
    ? "◆"
    : member.status === "active" ? "●" : "○";
  const you = member.agent_id === state.selfAgentId ? " (you)" : "";
  const owner = member.agent_id === state.room.owner ? " [stick]" : "";
  const label = agentLabel(member.agent_id, state.members);
  const rendered = `${marker} ${renderAgent(
    member.agent_id,
    label,
    theme,
    member.agent_id === state.selfAgentId
  )}${you}${owner}`;
  return member.status === "inactive" ? theme.dim(rendered) : rendered;
}

function renderSidebarMember(state: ChatState, member: ChatState["members"][number]): string {
  const marker = member.agent_id === state.room.owner
    ? "o--"
    : member.agent_id === state.room.reserved_for
      ? "o->"
      : member.status === "active" ? " ● " : " ○ ";
  const role = member.agent_id === state.selfAgentId ? " (you)" : isOperator(state, member) ? " (operator)" : "";
  return `${marker} ${agentLabel(member.agent_id, state.members)}${role}`;
}

function isOperator(state: ChatState, member: ChatState["members"][number]): boolean {
  return member.agent_id === state.selfAgentId || member.agent_id.startsWith("human:");
}

function renderMemberRows(
  label: string,
  members: string[],
  width: number | undefined
): string[] {
  const firstPrefix = `│ ${padVisible(label, 8)}`;
  const nextPrefix = `│ ${" ".repeat(8)}`;
  if (members.length === 0) {
    return [fitWidth(`${firstPrefix}no members`, width, " ")];
  }
  if (!width) return [`${firstPrefix}${members.join("  ")}`];

  const contentWidth = Math.max(1, width - stripAnsi(firstPrefix).length);
  const rows: string[] = [];
  let current = "";
  for (const member of members) {
    const fittedMember = fitWidth(member, contentWidth);
    const candidate = current ? `${current}  ${fittedMember}` : fittedMember;
    if (current && stripAnsi(candidate).length > contentWidth) {
      rows.push(current);
      current = fittedMember;
    } else {
      current = candidate;
    }
  }
  rows.push(current);
  return rows.map((row, index) =>
    fitWidth(`${index === 0 ? firstPrefix : nextPrefix}${row}`, width, " ")
  );
}

function renderEventAgent(agentId: string | null, options: RenderOptions): string {
  return renderAgent(
    agentId,
    agentLabel(agentId, options.members),
    renderTheme(options)
  );
}

function agentLabel(
  agentId: string | null,
  members: ChatState["members"] | undefined
): string {
  const member = members?.find((candidate) => candidate.agent_id === agentId);
  const displayName = member?.display_name?.trim();
  if (!displayName || !agentId) return displayName || shortAgent(agentId);

  const duplicates = members?.filter(
    (candidate) => candidate.display_name?.trim().toLowerCase() === displayName.toLowerCase()
  ) ?? [];
  if (duplicates.length < 2) return displayName;

  const kind = agentId.split(":", 1)[0];
  const sameKind = duplicates.filter(
    (candidate) => candidate.agent_id.split(":", 1)[0] === kind
  );
  if (sameKind.length === 1) return `${displayName} [${kind}]`;

  const value = agentId.slice(kind.length + 1);
  let length = Math.min(4, value.length);
  while (length < value.length && sameKind.some((candidate) => candidate.agent_id !== agentId && candidate.agent_id.slice(kind.length + 1).startsWith(value.slice(0, length)))) length += 1;
  return `${displayName} [${value.slice(0, length)}]`;
}

function renderAgent(
  agentId: string | null,
  label: string,
  theme: TuiTheme,
  self = false
): string {
  return theme.identity(agentId, label, self);
}

export function fitWidth(text: string, width?: number, fill?: string): string {
  if (!width || width <= 0) return text;
  const visible = cellWidth(text);
  if (visible > width) {
    return truncateStyled(text, width);
  }
  return fill ? `${text}${fill.repeat(width - visible)}` : text;
}

function renderActivity(
  state: ChatState,
  width: number,
  rows: number,
  color: boolean | undefined,
  scrollOffset = 0
): string[] {
  const lines = timelineLines(state, width, color);
  if (lines.length === 0) lines.push(...wrapText("No messages yet. Type a message to the room, or press Tab for actions.", width));
  const offset = Math.min(scrollOffset, Math.max(0, lines.length - rows));
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - rows), end);
  return Array.from({ length: rows }, (_, index) => fitWidth(visible[index] ?? "", width, " "));
}

export function timelineLines(state: ChatState, width: number, color: boolean | undefined): string[] {
  const theme = renderTheme({ color });
  const activity = state.activity.length > 0
    ? state.activity
    : [
      ...state.events.map((entry) => ({ kind: "event" as const, entry })),
      ...state.notices.map((notice) => ({ kind: "notice" as const, notice }))
    ];
  const lines: string[] = [];
  let routine: string[] = [];
  const flushRoutine = () => {
    if (routine.length) lines.push(...wrapText(routine.join(" · "), width).map((line) => theme.dim(line)));
    routine = [];
  };
  for (const item of activity) {
    if (item.kind === "event") {
      const event = item.entry.event;
      const time = new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      const from = agentLabel(event.from_agent_id, state.members);
      const target = agentLabel(event.to_agent_id, state.members);
      if (event.event_type === "message_sent" || event.handoff) {
        flushRoutine();
        if (lines.length && lines.at(-1) !== "") lines.push("");
        const title = event.event_type === "message_sent"
          ? `${time}  ${from} → ${event.to_agent_id ? target : "room"}`
          : `${time}  HANDOFF · ${from}${event.to_agent_id ? ` → ${target}` : " released the stick"}`;
        lines.push(...wrapText(title, width).map((line) => theme.identity(event.from_agent_id, line)));
        const body = event.event_type === "message_sent" ? String(event.payload?.body ?? "") : event.handoff?.status ?? "";
        lines.push(...wrapText(body, Math.max(1, width - 2)).map((line) => `  ${line}`));
        if (event.handoff?.next_action) {
          lines.push(...wrapText(`Next: ${event.handoff.next_action}`, Math.max(1, width - 2)).map((line) => `  ${line}`));
        }
        lines.push("");
      } else {
        routine.push(stripAnsi(renderEvent({ ...item.entry, historical: false }, { members: state.members })));
      }
      continue;
    }
    flushRoutine();
    lines.push(...wrapText(item.notice.text, width).map((line) => item.notice.level === "error" ? theme.error(line) : theme.dim(line)));
  }
  flushRoutine();
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

function renderInputLine(editor: EditorSnapshot, width: number): string {
  const before = editor.value.slice(0, editor.cursor);
  const after = editor.value.slice(editor.cursor);
  const prefix = `${editor.prompt}${before}`;
  // Leave a cell after the cursor for either trailing text or the ellipsis.
  const start = Math.max(0, cellWidth(prefix) - width + 3);
  return fitWidth(`${start ? "‹" : ""}${sliceCells(prefix, start, cellWidth(prefix))}▏${after}`, width, " ");
}

function plainStick(state: ChatState): string {
  if (state.room.owner === state.selfAgentId) return "your turn";
  if (state.room.owner) return `stick: ${agentLabel(state.room.owner, state.members)}`;
  if (state.room.reserved_for === state.selfAgentId) return "reserved for you";
  if (state.room.reserved_for) return `reserved: ${agentLabel(state.room.reserved_for, state.members)}`;
  return state.room.state === "closed" ? "room closed" : "stick free";
}

function joinColumns(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
  theme: TuiTheme,
  separator = "│",
  rightFill = " ",
  rightEnd = "│"
): string {
  const rightColumn = fitWidth(right, rightWidth - 1, rightFill);
  return `${fitWidth(left, leftWidth, " ")}${theme.border(separator)}${rightFill === "─" ? theme.border(rightColumn) : rightColumn}${theme.border(rightEnd)}`;
}

function exactRows(lines: string[], width: number, rows: number): string[] {
  const visible = lines.slice(0, rows).map((line) => fitWidth(line, width, " "));
  while (visible.length < rows) visible.push(" ".repeat(width));
  return visible;
}

function padVisible(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stripAnsi(text).length))}`;
}

function renderCwdRow(label: string, workingDirectory: string, width?: number): string {
  const prefix = `│ ${padVisible(label, 8)}`;
  const available = width ? Math.max(1, width - stripAnsi(prefix).length) : undefined;
  const displayed = displayPath(workingDirectory, available);
  return fitWidth(`${prefix}${displayed}`, width, " ");
}

function renderCwdSummary(
  workingDirectory: string,
  activeMembers: number,
  width: number
): string {
  const suffix = ` · ${activeMembers} active`;
  const prefix = "cwd: ";
  const available = Math.max(1, width - prefix.length - suffix.length);
  return fitWidth(`${prefix}${displayPath(workingDirectory, available)}${suffix}`, width, " ");
}

function displayPath(workingDirectory: string, width?: number): string {
  const home = os.homedir();
  const displayed = workingDirectory === home
    ? "~"
    : workingDirectory.startsWith(`${home}${path.sep}`)
      ? `~${workingDirectory.slice(home.length)}`
      : workingDirectory;
  if (!width || displayed.length <= width) return displayed;
  if (width <= 1) return "…";
  const left = Math.ceil((width - 1) / 2);
  const right = Math.floor((width - 1) / 2);
  return `${displayed.slice(0, left)}…${displayed.slice(displayed.length - right)}`;
}

function truncateStyled(text: string, width: number): string {
  if (width <= 1) return "…";
  return `${sliceCells(text, 0, width - 1)}…`;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeWidth(text: string): number {
  const code = text.codePointAt(0) ?? 0;
  if (/^[\p{Mark}\p{Control}\p{Format}]+$/u.test(text)) return 0;
  if (/\p{Emoji_Presentation}/u.test(text) || text.includes("\ufe0f")) return 2;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

export function cellWidth(text: string): number {
  return [...segmenter.segment(stripAnsi(text))].reduce((sum, entry) => sum + graphemeWidth(entry.segment), 0);
}

function sliceCells(text: string, start: number, end: number): string {
  let position = 0;
  let result = "";
  for (const token of text.split(/(\u001b\[[0-?]*[ -/]*[@-~])/)) {
    if (token.startsWith("\u001b[")) {
      result += token;
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      const size = graphemeWidth(segment);
      const next = position + size;
      if (position >= start && next <= end) result += segment;
      else if (next > start && position < end) result += " ".repeat(Math.min(next, end) - Math.max(position, start));
      position = next;
    }
  }
  return `${result}${text.includes("\u001b[") ? RESET : ""}`;
}

export function wrapText(text: string, width: number): string[] {
  const clean = stripVTControlCharacters(text).replace(/\r/g, "").replace(/\t/g, "    ");
  const lines: string[] = [];
  for (const paragraph of clean.split("\n")) {
    let line = "";
    let size = 0;
    for (const word of paragraph.split(/(\s+)/)) {
      const wordWidth = cellWidth(word);
      if (size && size + wordWidth > width && word.trim()) {
        lines.push(line.trimEnd());
        line = "";
        size = 0;
      }
      if (!line && !word.trim()) continue;
      for (const { segment } of segmenter.segment(word)) {
        const cells = graphemeWidth(segment);
        if (size + cells > width) {
          if (line) lines.push(line.trimEnd());
          line = "";
          size = 0;
        }
        line += cells > width ? "�" : segment;
        size += Math.min(cells, width);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function fitRows(lines: string[], width: number | undefined, maxRows: number): string[] {
  const fitted = lines.slice(0, maxRows).map((line) => fitWidth(line, width, " "));
  if (lines.length > maxRows && fitted.length > 0) {
    fitted[fitted.length - 1] = fitWidth("… more · use ↑↓ or ?", width, " ");
  }
  return fitted;
}

function renderTheme(options: RenderOptions): TuiTheme {
  return createTheme({ isTTY: options.color === true, env: {} });
}
