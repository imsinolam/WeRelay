/** Bounded text-only VT screen for reading native settings menus across partial redraws. */
export class CliSettingsScreen {
  private rows: string[][] = [[]];
  private row = 0;
  private column = 0;
  private pending = "";
  private saved: [number, number] = [0, 0];

  reset(): void { this.rows = [[]]; this.row = 0; this.column = 0; this.pending = ""; }

  write(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = "";
    for (let index = 0; index < text.length;) {
      const char = text[index]!;
      if (char === "\u001b") {
        const rest = text.slice(index);
        if (rest.startsWith("\u001b]")) {
          // eslint-disable-next-line no-control-regex -- OSC terminators in native terminal data.
          const end = /\u0007|\u001b\\/.exec(rest);
          if (!end) { this.pending = rest.slice(-2000); break; }
          index += end.index + end[0].length; continue;
        }
        // eslint-disable-next-line no-control-regex -- CSI commands in native terminal data.
        const sequence = /^\u001b\[([0-?]*)([ -/]*)([@-~])/.exec(rest);
        if (sequence) {
          this.command(sequence[1]!, sequence[3]!);
          index += sequence[0].length; continue;
        }
        if (rest === "\u001b" || (rest.startsWith("\u001b[") && rest.length < 80)) { this.pending = rest; break; }
        if (text[index + 1] === "7") this.saved = [this.row, this.column];
        if (text[index + 1] === "8") [this.row, this.column] = this.saved;
        index += 2; continue;
      }
      index++;
      if (char === "\r") this.column = 0;
      else if (char === "\n") this.row++;
      else if (char === "\b") this.column = Math.max(0, this.column - 1);
      else if (char >= " " && char !== "\u007f") {
        const line = this.rows[this.row] ?? (this.rows[this.row] = []);
        line[this.column++] = char;
      }
      this.bound();
    }
  }

  text(): string { return this.rows.map((line) => Array.from({ length: line.length }, (_, i) => line[i] ?? " ").join("")).join("\n"); }

  private bound(): void {
    this.row = Math.max(0, this.row);
    if (this.row >= 160) { const count = this.row - 159; this.rows.splice(0, count); this.row = 159; }
    this.column = Math.min(500, Math.max(0, this.column));
  }

  private command(params: string, command: string): void {
    const numbers = params.replace(/^[?>]/, "").split(";").map(Number);
    const count = numbers[0] || 1;
    switch (command) {
      case "A": this.row -= count; break;
      case "B": this.row += count; break;
      case "C": this.column += count; break;
      case "D": this.column -= count; break;
      case "G": this.column = count - 1; break;
      case "H": case "f": this.row = count - 1; this.column = (numbers[1] || 1) - 1; break;
      case "K": {
        const line = this.rows[this.row] ?? (this.rows[this.row] = []);
        if (numbers[0] === 2) this.rows[this.row] = [];
        else if (numbers[0] === 1) for (let i = 0; i <= this.column; i++) line[i] = " ";
        else line.splice(this.column);
        break;
      }
      case "J": {
        if (numbers[0] === 2 || numbers[0] === 3) this.rows = [];
        else if (!numbers[0]) { this.rows.splice(this.row + 1); this.rows[this.row]?.splice(this.column); }
        break;
      }
    }
    this.bound();
  }
}
