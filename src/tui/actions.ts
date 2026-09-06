export interface ChatAction {
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  cli: string;
  memberArgument?: boolean;
}

export const CHAT_ACTIONS: ChatAction[] = [
  action("help", "[command]", "Show chat actions and shortcuts.", "tt chat", []),
  action("msg", "<member> <message>", "Send a message to one member.", "tt msg send", ["dm"], true),
  action("who", "", "Show everyone in the room.", "tt state", ["members"]),
  action("state", "", "Show the current room and stick state.", "tt state"),
  action("health", "", "Show room health and suggested action.", "tt health"),
  action("history", "[count]", "Show recent room activity.", "tt events --target any"),
  action("note", "<text>", "Add a durable room note.", "tt notes add"),
  action("notes", "", "List unresolved room notes.", "tt notes list"),
  action("take", "[reason]", "Explicitly take the stick.", "tt take"),
  action("release", "", "Release the stick with a guided handoff.", "tt release"),
  action("pass", "", "Pass normally with a guided handoff.", "tt pass"),
  action("assign", "[member]", "Pass to a member with a guided handoff.", "tt assign", [], true),
  action("kick", "<member> [reason]", "Remove an inactive member.", "tt kick", [], true),
  action("instructions", "", "Show effective coordination instructions.", "tt instructions show"),
  action("rooms", "", "List rooms under this workspace.", "tt list"),
  action("quit", "[--force]", "Close chat but remain a room member.", "exit"),
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
  memberArgument = false
): ChatAction {
  return { name, aliases, usage, description, cli, memberArgument };
}
