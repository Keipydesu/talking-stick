const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const UNDERLINE = "\u001b[4m";
const ERROR_COLOR = "\u001b[31m";
const CHROME_COLOR = "\u001b[35m";
// Use theme-defined green, blue, and cyan (normal and bright). Keep magenta
// for the frame, and reserve red/yellow for semantic error/warning styling.
const IDENTITY_COLORS = [2, 4, 6, 10, 12, 14];

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
  border: (text: string) => string;
  error: (text: string) => string;
  holder: (text: string) => string;
  operator: (text: string, self?: boolean) => string;
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
    accent: (text) => wrap(`${BOLD}${CHROME_COLOR}`, text),
    border: (text) => wrap(CHROME_COLOR, text),
    error: (text) => wrap(ERROR_COLOR, text),
    holder: (text) => wrap(`\u001b[92m${BOLD}`, text),
    operator: (text, self = false) => wrap(`\u001b[96m${BOLD}${self ? UNDERLINE : ""}`, text),
    identity: (agentId, text, self = false) => {
      if (!color || !agentId) return text;
      const index = identityColorIndex(agentId);
      const identity = `\u001b[${index < 8 ? 30 + index : 90 + index - 8}m`;
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
