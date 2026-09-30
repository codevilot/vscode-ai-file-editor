import * as vscode from "vscode";
import { EMPTY_STATE, type EditorState } from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export class AiDocument implements vscode.CustomDocument {
  private _state: EditorState;
  private readonly _originalBytes: Uint8Array;

  private constructor(
    readonly uri: vscode.Uri,
    originalBytes: Uint8Array,
    state: EditorState,
  ) {
    this._originalBytes = originalBytes;
    this._state = state;
  }

  static async open(uri: vscode.Uri, backupId?: string): Promise<AiDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const sidecar = backupId ? vscode.Uri.parse(backupId) : sidecarUri(uri);
    const state = await readState(sidecar);
    return new AiDocument(uri, bytes, state);
  }

  get originalBytes(): Uint8Array {
    return this._originalBytes;
  }

  get state(): EditorState {
    return cloneState(this._state);
  }

  setState(state: EditorState): void {
    this._state = cloneState(state);
  }

  async save(): Promise<void> {
    await writeState(sidecarUri(this.uri), this._state);
  }

  async saveAs(destination: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.writeFile(destination, this._originalBytes);
    await writeState(sidecarUri(destination), this._state);
  }

  async revert(): Promise<void> {
    this._state = await readState(sidecarUri(this.uri));
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await writeState(destination, this._state);
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // VS Code may already have removed the backup.
        }
      },
    };
  }

  dispose(): void {}
}

export function sidecarUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: `${uri.path}.ai-editor.json` });
}

export function cloneState(state: EditorState): EditorState {
  return JSON.parse(JSON.stringify(state)) as EditorState;
}

async function readState(uri: vscode.Uri): Promise<EditorState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(decoder.decode(bytes)) as {
      version?: number;
      pages?: EditorState["pages"];
      importedPages?: string[];
    };
    if (parsed.version === 2 && parsed.pages && typeof parsed.pages === "object") {
      return {
        version: 2,
        pages: parsed.pages,
        importedPages: Array.isArray(parsed.importedPages) ? parsed.importedPages : [],
      };
    }
    if (parsed.version === 1 && parsed.pages && typeof parsed.pages === "object") {
      return { version: 2, pages: parsed.pages, importedPages: [] };
    }
  } catch {
    // A missing or invalid sidecar means a fresh edit session.
  }
  return cloneState(EMPTY_STATE);
}

async function writeState(uri: vscode.Uri, state: EditorState): Promise<void> {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(uri, encoder.encode(body));
}
