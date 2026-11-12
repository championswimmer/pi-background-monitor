export type TextCheckpoint = {
  version: 1;
  mode: "text" | "escape" | "escape-intermediate" | "csi" | "string" | "string-escape";
  controlLength: number;
  afterCR: boolean;
  overflow: boolean;
  atLineBoundary: boolean;
  pending: string;
};
export class TextNormalizer {
  constructor(snapshot?: TextCheckpoint);
  overflow: boolean;
  atLineBoundary: boolean;
  snapshot(): TextCheckpoint;
  write(data: Buffer): string;
  end(): string;
}
