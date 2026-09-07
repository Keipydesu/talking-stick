const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const UNDERLINE = "\u001b[4m";
const RED_256 = "\u001b[38;5;160m";
const ACCENT_256 = "\u001b[38;5;37m";
const IDENTITY_COLORS = [
  25, 31, 37, 61, 67, 73, 97, 103, 109, 133, 139, 145,
  166, 172, 178, 202, 208
];

export interface ThemeEnvironment {
  isTTY: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TuiTheme {
  color: boolean;
  reset: string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  error: (text: string) => string;
  identity: (agentId: string | null, text: string, self?: boolean) => string;
}

export function createTheme(input: ThemeEnvironment): TuiTheme {
  const env = input.env ?? process.env;
  const color = input.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
  const wrap = (open: string, text: string) => color ? `${open}${text}${RESET}` : text;
  return {
    color,
    reset: color ? RESET : "",
    bold: (text) => wrap(BOLD, text),
    dim: (text) => wrap(DIM, text),
    accent: (text) => wrap(`${BOLD}${ACCENT_256}`, text),
    error: (text) => wrap(RED_256, text),
    identity: (agentId, text, self = false) => {
      if (!color || !agentId) return text;
      const identity = `\u001b[38;5;${identityColorIndex(agentId)}m`;
      return `${identity}${BOLD}${self ? UNDERLINE : ""}${text}${RESET}`;
    }
  };
}

export function identityColorIndex(agentId: string): number {
  return IDENTITY_COLORS[stableHash(agentId) % IDENTITY_COLORS.length];
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
