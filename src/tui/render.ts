import path from "node:path";
import { CHAT_ACTIONS } from "./actions.js";
import type { ChatEventEntry, ChatState } from "./model.js";

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

export function renderEvent(
  entry: ChatEventEntry,
  options: RenderOptions = {}
): string {
  const event = entry.event;
  const time = new Date(event.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const from = shortAgent(event.from_agent_id);
  let text: string;
  switch (event.event_type) {
    case "message_sent": {
      const target = event.to_agent_id ? shortAgent(event.to_agent_id) : "room";
      text = `${time}  ${from.padEnd(10)} -> ${target.padEnd(10)} ${event.payload?.body ?? ""}`;
      break;
    }
    case "join":
      text = `${time}  · ${from} joined`;
      break;
    case "leave":
      text = `${time}  · ${from} left`;
      break;
    case "kick":
      text = `${time}  · ${shortAgent(event.to_agent_id)} was kicked by ${from}${event.reason ? ` (${event.reason})` : ""}`;
      break;
    case "claim":
      text = `${time}  · ${shortAgent(event.to_agent_id)} took the stick`;
      break;
    case "takeover":
      text = `${time}  · ${shortAgent(event.to_agent_id)} took over${event.reason ? ` (${event.reason})` : ""}`;
      break;
    case "release":
      text = `${time}  · ${from} released the stick${event.handoff?.status ? ` — ${event.handoff.status}` : ""}`;
      break;
    case "pass":
      text = `${time}  · ${from} passed to ${shortAgent(event.to_agent_id)}${event.handoff?.status ? ` — ${event.handoff.status}` : ""}`;
      break;
    case "close":
      text = `${time}  · room closed`;
      break;
    case "reservation_expired":
      text = `${time}  · reservation for ${shortAgent(event.to_agent_id)} expired`;
      break;
    case "session_superseded":
      text = `${time}  · ${shortAgent(event.to_agent_id)} session superseded`;
      break;
    default:
      text = `${time}  · ${event.event_type} ${from}`;
  }
  const fitted = fitWidth(text, options.width);
  return entry.historical && options.color ? `${DIM}${fitted}${RESET}` : fitted;
}

export function renderStatusBar(
  state: ChatState,
  options: RenderOptions = {}
): string {
  const room = path.basename(state.canonicalPath) || state.canonicalPath;
  const activeMembers = state.members.filter((member) => member.status === "active").length;
  let stick = "stick: free — /take";
  if (["stale_owner", "owner_gone", "owner_idle", "recipient_gone"].includes(state.room.state)) {
    stick = `takeover available (${state.room.state}) — /take`;
  } else if (state.room.owner === state.selfAgentId) {
    stick = "your turn — /release when done";
  } else if (state.room.owner) {
    stick = `stick: ${shortAgent(state.room.owner)}`;
  } else if (state.room.reserved_for === state.selfAgentId) {
    stick = "reserved for you — /take";
  } else if (state.room.reserved_for) {
    stick = `reserved: ${shortAgent(state.room.reserved_for)}`;
  } else if (state.room.state === "closed") {
    stick = "room closed";
  }
  return fitWidth(
    `-- ${room} · ${activeMembers} ${activeMembers === 1 ? "member" : "members"} · ${stick} `,
    options.width,
    "-"
  );
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
  return color ? `${DIM}${text}${RESET}` : text;
}

export function renderError(message: string, color = true): string {
  return color ? `${RED}${message}${RESET}` : message;
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

function fitWidth(text: string, width?: number, fill = " "): string {
  if (!width || width <= 0) return text;
  if (text.length > width) {
    return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
  }
  return fill === " " ? text : text.padEnd(width, fill);
}
