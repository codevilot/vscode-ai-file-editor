export type Tool = "select" | "text" | "rectangle" | "ellipse" | "line" | "pen";

export interface Point {
  x: number;
  y: number;
}

export interface EditorElement {
  id: string;
  type: Exclude<Tool, "select">;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  rotation?: number;
  source?: "pdf" | "user";
  hidden?: boolean;
  originalBounds?: { x: number; y: number; width: number; height: number };
  points?: Point[];
}

export interface EditorState {
  version: 2;
  pages: Record<string, EditorElement[]>;
  importedPages: string[];
}

export interface DocumentInfo {
  fileName: string;
  byteLength: number;
  sidecarPath: string;
  modifiedAt: number;
}

export type FromExtensionMessage =
  | {
      type: "init";
      pdfBase64: string;
      state: EditorState;
      info: DocumentInfo;
      workerUri: string;
    }
  | { type: "state"; state: EditorState }
  | { type: "saved"; sidecarPath: string }
  | { type: "exported"; path: string }
  | { type: "error"; message: string };

export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "change"; state: EditorState; label: string }
  | { type: "export"; overlays: Array<{ pageIndex: number; pngDataUrl: string }> }
  | { type: "show-message"; message: string };

export const EMPTY_STATE: EditorState = { version: 2, pages: {}, importedPages: [] };
