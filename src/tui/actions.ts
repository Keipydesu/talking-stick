export interface ChatActionOption {
  id: string;
  syntax: string;
  kind: "boolean" | "value";
  description: string;
  cliFlag?: string;
  required?: boolean;
  member?: boolean;
  defaultValue?: string | boolean;
}

export interface ChatAction {
  id: string;
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  cli: string;
  options: ChatActionOption[];
  guidedForm?: "handoff";
  memberArgument?: boolean;
}

export const CHAT_ACTIONS: ChatAction[] = [
  action("help", "[command]", "Show chat actions and shortcuts.", "tt chat", []),
  action("msg", "<member> <message>", "Send a message to one member.", "tt msg send", ["dm"], [
    value("member", "<member>", "room member to receive the message", { required: true, member: true }),
    value("message", "<message>", "message body", { required: true })
  ]),
  action("who", "", "Show everyone in the room.", "tt state", ["members"]),
  action("state", "", "Show the current room and stick state.", "tt state"),
  action("health", "", "Show room health and suggested action.", "tt health"),
  action("history", "[count]", "Show recent room activity.", "tt events --target any", [], [
    value("count", "[count]", "number of recent actions to show (1–100)", { cliFlag: "--limit", defaultValue: "20" })
  ]),
  action("note", "<text>", "Add a durable room note.", "tt notes add", [], [
    value("text", "<text>", "durable note text", { required: true })
  ]),
  action("notes", "", "List unresolved room notes.", "tt notes list"),
  action("take", "[reason]", "Explicitly take the stick.", "tt take", [], [
    value("reason", "[reason]", "why you are taking the stick; recorded in the room", { cliFlag: "--reason" })
  ]),
  action("release", "", "Release the stick with a guided handoff.", "tt release", [], handoffOptions(), "handoff"),
  action("pass", "", "Pass normally with a guided handoff.", "tt pass", [], handoffOptions(), "handoff"),
  action("assign", "[member]", "Pass to a member with a guided handoff.", "tt assign", [], [
    value("member", "<member>", "reachable member who should receive the turn", { required: true, member: true }),
    ...handoffOptions()
  ], "handoff"),
  action("kick", "<member> [reason]", "Remove an inactive member.", "tt kick", [], [
    value("member", "<member>", "room member to remove", { required: true, member: true }),
    value("reason", "[reason]", "why the member is being removed", { cliFlag: "--reason" }),
    flag("force", "--force", "remove an active member after explicit confirmation")
  ]),
  action("instructions", "", "Show effective coordination instructions.", "tt instructions show"),
  action("rooms", "", "List rooms under this workspace.", "tt list"),
  action("quit", "[--force]", "Close chat but remain a room member.", "exit", [], [
    flag("force", "--force", "release an owned turn before closing chat")
  ]),
  action("leave", "", "Leave the room and close chat.", "tt leave")
];

export function findExactAction(name: string): ChatAction | undefined {
  const normalized = name.toLowerCase();
  return CHAT_ACTIONS.find(
    (candidate) =>
      candidate.name === normalized || candidate.aliases.includes(normalized)
  );
}

export function findActionCandidates(prefix: string): ChatAction[] {
  const normalized = prefix.toLowerCase();
  return CHAT_ACTIONS.filter(
    (candidate) =>
      candidate.name.startsWith(normalized) ||
      candidate.aliases.some((alias) => alias.startsWith(normalized))
  );
}

function action(
  name: string,
  usage: string,
  description: string,
  cli: string,
  aliases: string[] = [],
  options: ChatActionOption[] = [],
  guidedForm?: ChatAction["guidedForm"]
): ChatAction {
  return {
    id: name,
    name,
    aliases,
    usage,
    description,
    cli,
    options,
    guidedForm,
    memberArgument: options.some((option) => option.member)
  };
}

function value(
  id: string,
  syntax: string,
  description: string,
  options: Partial<Pick<ChatActionOption, "cliFlag" | "required" | "member" | "defaultValue">> = {}
): ChatActionOption {
  return { id, syntax, kind: "value", description, ...options };
}

function flag(id: string, syntax: string, description: string): ChatActionOption {
  return { id, syntax, kind: "boolean", description, cliFlag: syntax };
}

function handoffOptions(): ChatActionOption[] {
  return [
    value("status", "<status>", "what changed in the completed turn", { cliFlag: "--status", required: true }),
    value("next_action", "<next-action>", "what the next holder should do", { cliFlag: "--next-action", required: true })
  ];
}
