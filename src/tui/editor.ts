export interface EditorSnapshot {
  prompt: string;
  value: string;
  cursor: number;
}

export class InputEditor {
  private prompt = "> ";
  private value = "";
  private cursor = 0;
  private readonly history: string[] = [];
  private historyIndex: number | null = null;
  private draft = "";

  snapshot(): EditorSnapshot {
    return { prompt: this.prompt, value: this.value, cursor: this.cursor };
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  insert(text: string): void {
    this.value = `${this.value.slice(0, this.cursor)}${text}${this.value.slice(this.cursor)}`;
    this.cursor += text.length;
    this.historyIndex = null;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.value.length, this.cursor + 1);
  }

  home(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.value.length;
  }

  clear(): void {
    this.value = "";
    this.cursor = 0;
    this.historyIndex = null;
  }

  killToEnd(): void {
    this.value = this.value.slice(0, this.cursor);
  }

  deleteWord(): void {
    if (this.cursor === 0) return;
    const before = this.value.slice(0, this.cursor);
    const next = before.replace(/\s*\S+\s*$/, "");
    this.value = `${next}${this.value.slice(this.cursor)}`;
    this.cursor = next.length;
  }

  previousHistory(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.draft = this.value;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.replace(this.history[this.historyIndex]);
  }

  nextHistory(): void {
    if (this.historyIndex === null) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.replace(this.history[this.historyIndex]);
    } else {
      this.historyIndex = null;
      this.replace(this.draft);
    }
  }

  complete(candidates: string[]): void {
    if (candidates.length === 0) return;
    const current = this.value;
    const exactIndex = candidates.indexOf(current);
    this.replace(candidates[(exactIndex + 1) % candidates.length] ?? candidates[0]);
  }

  submit(): string {
    const submitted = this.value;
    if (submitted.trim() && this.history.at(-1) !== submitted) {
      this.history.push(submitted);
      if (this.history.length > 100) this.history.shift();
    }
    this.clear();
    return submitted;
  }

  private replace(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }
}
