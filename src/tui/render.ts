import path from "node:path";
import os from "node:os";
import { CHAT_ACTIONS } from "./actions.js";
import { actionAvailability, type CapabilitySnapshot } from "./availability.js";
import {
  actionConfiguration,
  buildCommandPreview,
  filteredActions,
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
  const room = path.basename(state.canonicalPath) || state.canonicalPath;
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
  const title = theme.accent(`╭─ tt · ${room} · ${state.room.state}`);
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
  const width = Math.max(1, input.width);
  const rows = Math.max(1, input.rows);
  const theme = renderTheme({ color: input.color });
  const room = path.basename(input.state.canonicalPath) || input.state.canonicalPath;
  if (width < 48 || rows < 8) {
    const compact = [
      renderStatusBar(input.state, { color: input.color, width }),
      fitWidth(renderInputLine(input.editor), width, " "),
      fitWidth("Tab actions · ? help · /quit detach", width, " ")
    ];
    return exactRows(compact, width, rows);
  }

  if (width < 72 || rows < 12) {
    const overlay = renderOverlay(input, width, Math.max(1, rows - 5));
    const activity = overlay ?? renderActivity(input.state, width, Math.max(1, rows - 5), input.color);
    return exactRows([
      fitWidth(theme.accent(`tt · ${room} · ${input.state.room.state}`), width, "─"),
      fitWidth(`cwd  ${displayPath(input.state.workingDirectory, Math.max(1, width - 5))}`, width, " "),
      fitWidth(`turn ${input.state.room.turn_id} · ${plainStick(input.state)}`, width, " "),
      ...activity,
      fitWidth(renderInputLine(input.editor), width, " "),
      fitWidth("Tab actions · ? help · /quit detach", width, " ")
    ], width, rows);
  }

  const sidebarWidth = Math.min(30, Math.max(22, Math.floor(width * 0.27)));
  const leftWidth = width - sidebarWidth - 1;
  const contentRows = Math.max(1, rows - 7);
  const paneWidth = Math.max(1, leftWidth - 1);
  const overlay = renderOverlay(input, paneWidth, contentRows);
  const activity = overlay ?? renderActivity(input.state, paneWidth, contentRows, input.color);
  const members = [...input.state.members]
    .sort((left, right) => Number(right.status === "active") - Number(left.status === "active"))
    .map((member) => renderMember(input.state, member, theme));
  const result: string[] = [];
  result.push(joinColumns(
    theme.accent(`┌─ tt · ${room} · ${input.state.room.state}`),
    "",
    leftWidth,
    sidebarWidth,
    "┬",
    "─",
    "┐"
  ));
  result.push(joinColumns(
    `│cwd  ${displayPath(input.state.workingDirectory, Math.max(1, leftWidth - 6))}`,
    theme.accent("MEMBERS"),
    leftWidth,
    sidebarWidth
  ));
  result.push(joinColumns(
    `│turn ${input.state.room.turn_id} · ${plainStick(input.state)}`,
    members[0] ?? theme.dim("○ no members"),
    leftWidth,
    sidebarWidth
  ));
  result.push(joinColumns(
    "├".padEnd(leftWidth, "─"),
    members[1] ?? "",
    leftWidth,
    sidebarWidth,
    "┤"
  ));
  for (let index = 0; index < contentRows; index += 1) {
    const memberIndex = index + 2;
    const right = index === contentRows - 1
      ? `stick: ${stickHolderLabel(input.state)}`
      : members[memberIndex] ?? "";
    result.push(joinColumns(
      `│${fitWidth(activity[index] ?? "", paneWidth, " ")}`,
      right,
      leftWidth,
      sidebarWidth
    ));
  }
  result.push(joinColumns(
    "└".padEnd(leftWidth, "─"),
    "",
    leftWidth,
    sidebarWidth,
    "┴",
    "─",
    "┘"
  ));
  result.push(fitWidth(renderInputLine(input.editor), width, " "));
  result.push(fitWidth("Tab actions · ? help · /quit detach", width, " "));
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
      "Tab on an empty prompt opens actions; type to filter, ↑↓ to move, Enter to run.",
      "The stick grants one guarded writer turn. Messages converse; notes persist; handoffs transfer work.",
      "? shows action help. Esc closes or goes back. Slash commands and Tab completion still work.",
      theme.dim("? / Esc close")
    ], width, maxRows);
  }

  const action = selectedAction(menu);
  if (!action) return [];
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
      const row = `${marker} ${option.id.padEnd(14)} ${value} — ${option.description}`;
      return index === menu.selectedOptionIndex ? theme.bold(row) : row;
    });
    return fitRows([
      theme.accent(`${action.name} · options`),
      ...rows,
      `Preview: ${buildCommandPreview(action, configuration)}`,
      verdict === true ? "Available now" : `Unavailable: ${verdict}`,
      theme.dim("↑↓ move · Space edit/toggle · Enter run · ? help · Esc back")
    ], width, maxRows);
  }

  const visible = filteredActions(CHAT_ACTIONS, menu.filter);
  const selectedIndex = Math.max(0, visible.findIndex((candidate) => candidate.id === action.id));
  const actionRows = Math.max(1, maxRows - 4);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(actionRows / 2), visible.length - actionRows));
  const shown = visible.slice(start, start + actionRows);
  const rows = shown.map((candidate) => {
    const configured = actionConfiguration(menu, candidate);
    const available = actionAvailability(candidate, snapshot, configured);
    const marker = candidate.id === action.id ? ">" : " ";
    const status = available === true ? "available" : available;
    const row = `${marker} ${candidate.name.padEnd(13)} ${status}`;
    if (candidate.id === action.id) return theme.bold(row);
    return available === true ? row : theme.dim(row);
  });
  return fitRows([
    theme.accent(`ACTIONS${menu.filter ? ` · filter: ${menu.filter}` : ""}`),
    ...(rows.length > 0 ? rows : [theme.dim("No matching actions")]),
    `${action.name} — ${action.description}`,
    theme.dim("↑↓ move · Enter run · → options · ? help · Esc close")
  ], width, maxRows);
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
  const suffix = value.length <= 8 ? value : `${value.slice(0, 6)}…`;
  return `${displayName} [${kind}:${suffix}]`;
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
  const visible = stripAnsi(text).length;
  if (visible > width) {
    return truncateStyled(text, width);
  }
  return fill ? `${text}${fill.repeat(width - visible)}` : text;
}

function renderOverlay(input: FrameInput, width: number, rows: number): string[] | null {
  if (input.menu.stage === "closed" || !input.capability) return null;
  return renderActionMenu(input.menu, input.capability, {
    color: input.color,
    width,
    maxRows: rows
  });
}

function renderActivity(
  state: ChatState,
  width: number,
  rows: number,
  color: boolean | undefined
): string[] {
  const activity = state.activity.length > 0
    ? state.activity
    : [
      ...state.events.map((entry) => ({ kind: "event" as const, entry })),
      ...state.notices.map((notice) => ({ kind: "notice" as const, notice }))
    ];
  const lines = activity.flatMap((item) => {
    if (item.kind === "event") {
      return [renderEvent(item.entry, { color, width, members: state.members })];
    }
    return item.notice.text.split("\n").map((line) =>
      item.notice.level === "error"
        ? renderError(line, color === true)
        : fitWidth(line, width)
    );
  }).slice(-rows);
  return Array.from({ length: rows }, (_, index) =>
    fitWidth(lines[index] ?? "", width, " ")
  );
}

function renderInputLine(editor: EditorSnapshot): string {
  const before = editor.value.slice(0, editor.cursor);
  const after = editor.value.slice(editor.cursor);
  return `${editor.prompt}${before}▏${after}`;
}

function plainStick(state: ChatState): string {
  if (state.room.owner === state.selfAgentId) return "your turn";
  if (state.room.owner) return `stick: ${agentLabel(state.room.owner, state.members)}`;
  if (state.room.reserved_for === state.selfAgentId) return "reserved for you";
  if (state.room.reserved_for) return `reserved: ${agentLabel(state.room.reserved_for, state.members)}`;
  return state.room.state === "closed" ? "room closed" : "stick free";
}

function stickHolderLabel(state: ChatState): string {
  if (state.room.owner === state.selfAgentId) return "you";
  if (state.room.owner) return agentLabel(state.room.owner, state.members);
  if (state.room.reserved_for === state.selfAgentId) return "reserved for you";
  if (state.room.reserved_for) return `reserved: ${agentLabel(state.room.reserved_for, state.members)}`;
  return "free";
}

function joinColumns(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
  separator = "│",
  rightFill = " ",
  rightEnd = "│"
): string {
  return `${fitWidth(left, leftWidth, " ")}${separator}${fitWidth(right, rightWidth - 1, rightFill)}${rightEnd}`;
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
  const target = width - 1;
  let result = "";
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < target) {
    if (text[index] === "\u001b") {
      const sequence = text.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/)?.[0];
      if (sequence) {
        result += sequence;
        index += sequence.length;
        continue;
      }
    }
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    result += character;
    index += character.length;
    visible += 1;
  }
  return `${result}…${text.includes("\u001b[") ? RESET : ""}`;
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
