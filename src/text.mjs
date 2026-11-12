/** Incremental terminal-control stripping shared by capture and live readers. */
export class TextNormalizer {
  constructor(snapshot) {
    this.mode = "text";
    this.controlLength = 0;
    this.afterCR = false;
    this.overflow = false;
    this.atLineBoundary = true;
    this.pending = Buffer.alloc(0);
    if (snapshot !== undefined) {
      if (
        !snapshot ||
        snapshot.version !== 1 ||
        !["text", "escape", "escape-intermediate", "csi", "string", "string-escape"].includes(
          snapshot.mode,
        ) ||
        !Number.isInteger(snapshot.controlLength) ||
        snapshot.controlLength < 0 ||
        snapshot.controlLength > 4096 ||
        typeof snapshot.afterCR !== "boolean" ||
        typeof snapshot.overflow !== "boolean" ||
        typeof snapshot.atLineBoundary !== "boolean" ||
        typeof snapshot.pending !== "string"
      )
        throw new Error("Invalid text checkpoint");
      const pending = Buffer.from(snapshot.pending, "base64");
      if (
        pending.length > 3 ||
        pending.toString("base64") !== snapshot.pending ||
        this.completePrefix(pending) !== 0
      )
        throw new Error("Invalid text checkpoint bytes");
      this.mode = snapshot.mode;
      this.controlLength = snapshot.controlLength;
      this.afterCR = snapshot.afterCR;
      this.overflow = snapshot.overflow;
      this.atLineBoundary = snapshot.atLineBoundary;
      this.pending = pending;
    }
  }
  snapshot() {
    return {
      version: 1,
      mode: this.mode,
      controlLength: this.controlLength,
      afterCR: this.afterCR,
      overflow: this.overflow,
      atLineBoundary: this.atLineBoundary,
      pending: this.pending.toString("base64"),
    };
  }
  completePrefix(data) {
    let start = data.length - 1;
    while (start >= 0 && data.length - start <= 4 && (data[start] & 0xc0) === 0x80) start--;
    if (start < 0) return data.length;
    const byte = data[start];
    const expected =
      byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte >= 0xe0 && byte <= 0xef
          ? 3
          : byte >= 0xf0 && byte <= 0xf4
            ? 4
            : 1;
    return expected > data.length - start ? start : data.length;
  }
  process(value) {
    let output = "";
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (this.mode !== "text") {
        if (++this.controlLength > 4096) {
          this.overflow = true;
          this.mode = "text";
          this.controlLength = 0;
          continue;
        }
        if (this.mode === "escape") {
          if (ch === "[") this.mode = "csi";
          else if (["]", "P", "X", "^", "_"].includes(ch)) this.mode = "string";
          else if (code >= 0x20 && code <= 0x2f) this.mode = "escape-intermediate";
          else this.mode = "text";
        } else if (this.mode === "escape-intermediate") {
          if (code >= 0x30 && code <= 0x7e) this.mode = "text";
        } else if (this.mode === "csi") {
          if (code >= 0x40 && code <= 0x7e) this.mode = "text";
        } else if (this.mode === "string") {
          if (code === 7 || code === 0x9c) this.mode = "text";
          else if (code === 0x1b) this.mode = "string-escape";
        } else if (ch === "\\" || code === 0x9c) this.mode = "text";
        else this.mode = code === 0x1b ? "string-escape" : "string";
        if (this.mode === "text") this.controlLength = 0;
        continue;
      }
      if (code === 0x1b) {
        this.mode = "escape";
        this.controlLength = 0;
        continue;
      }
      if (code === 0x9b) {
        this.mode = "csi";
        this.controlLength = 0;
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.mode = "string";
        this.controlLength = 0;
        continue;
      }
      if (ch === "\r") {
        output += "\n";
        this.atLineBoundary = true;
        this.afterCR = true;
        continue;
      }
      if (ch === "\n") {
        if (!this.afterCR) output += "\n";
        this.atLineBoundary = true;
        this.afterCR = false;
        continue;
      }
      this.afterCR = false;
      if (ch === "\t" || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) {
        output += ch;
        this.atLineBoundary = false;
      }
    }
    return output;
  }
  write(data) {
    const bytes = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const end = this.completePrefix(bytes);
    this.pending = Buffer.from(bytes.subarray(end));
    return this.process(bytes.subarray(0, end).toString("utf8"));
  }
  end() {
    const result = this.process(this.pending.toString("utf8"));
    this.pending = Buffer.alloc(0);
    return result;
  }
}
