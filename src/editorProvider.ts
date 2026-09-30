import * as path from "node:path";
import * as vscode from "vscode";
import { PDFDocument } from "pdf-lib";
import { AiDocument, cloneState, sidecarUri } from "./aiDocument";
import type {
  EditorState,
  FromExtensionMessage,
  FromWebviewMessage,
} from "./protocol";

export class AiEditorProvider implements vscode.CustomEditorProvider<AiDocument> {
  static readonly viewType = "aiEditor.editor";

  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<AiDocument>
  >();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  private readonly panels = new Map<AiDocument, Set<vscode.WebviewPanel>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<AiDocument> {
    return AiDocument.open(uri, openContext.backupId);
  }

  async resolveCustomEditor(
    document: AiDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };

    let documentPanels = this.panels.get(document);
    if (!documentPanels) {
      documentPanels = new Set();
      this.panels.set(document, documentPanels);
    }
    documentPanels.add(panel);
    panel.onDidDispose(() => {
      documentPanels?.delete(panel);
      if (documentPanels?.size === 0) this.panels.delete(document);
    });

    panel.webview.onDidReceiveMessage(async (message: FromWebviewMessage) => {
      try {
        await this.onMessage(document, panel, message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.post(panel, { type: "error", message: detail });
        void vscode.window.showErrorMessage(`Ai Illustrator File Editor: ${detail}`);
      }
    });

    // Install the message listener before loading the webview. The bundled app
    // can post `ready` immediately, especially on a warm development reload.
    panel.webview.html = this.renderHtml(panel.webview);
  }

  async saveCustomDocument(document: AiDocument): Promise<void> {
    await document.save();
    this.broadcast(document, {
      type: "saved",
      sidecarPath: sidecarUri(document.uri).fsPath,
    });
  }

  async saveCustomDocumentAs(document: AiDocument, destination: vscode.Uri): Promise<void> {
    await document.saveAs(destination);
  }

  async revertCustomDocument(document: AiDocument): Promise<void> {
    await document.revert();
    this.broadcast(document, { type: "state", state: document.state });
  }

  async backupCustomDocument(
    document: AiDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination);
  }

  private async onMessage(
    document: AiDocument,
    panel: vscode.WebviewPanel,
    message: FromWebviewMessage,
  ): Promise<void> {
    switch (message.type) {
      case "ready": {
        const stat = await vscode.workspace.fs.stat(document.uri);
        const workerUri = panel.webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, "dist", "pdf.worker.min.mjs"),
        );
        this.post(panel, {
          type: "init",
          pdfBase64: Buffer.from(document.originalBytes).toString("base64"),
          state: document.state,
          workerUri: workerUri.toString(),
          info: {
            fileName: path.basename(document.uri.fsPath),
            byteLength: stat.size,
            modifiedAt: stat.mtime,
            sidecarPath: sidecarUri(document.uri).fsPath,
          },
        });
        return;
      }
      case "change":
        this.applyEdit(document, message.state, message.label);
        return;
      case "export":
        await this.exportPdf(document, panel, message.overlays);
        return;
      case "show-message":
        void vscode.window.showInformationMessage(message.message);
    }
  }

  private applyEdit(document: AiDocument, nextState: EditorState, label: string): void {
    const before = document.state;
    const after = cloneState(nextState);
    document.setState(after);
    this.changeEmitter.fire({
      document,
      label,
      undo: async () => {
        document.setState(before);
        this.broadcast(document, { type: "state", state: before });
      },
      redo: async () => {
        document.setState(after);
        this.broadcast(document, { type: "state", state: after });
      },
    });
  }

  private async exportPdf(
    document: AiDocument,
    panel: vscode.WebviewPanel,
    overlays: Array<{ pageIndex: number; pngDataUrl: string }>,
  ): Promise<void> {
    const base = document.uri.fsPath.replace(/\.ai$/i, "");
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${base}.edited.pdf`),
      filters: { PDF: ["pdf"] },
      saveLabel: "Export edited PDF",
    });
    if (!destination) return;

    const pdf = await PDFDocument.load(document.originalBytes, {
      updateMetadata: false,
    });
    const pages = pdf.getPages();
    for (const overlay of overlays) {
      const page = pages[overlay.pageIndex];
      if (!page) continue;
      const pngBytes = Buffer.from(
        overlay.pngDataUrl.replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      const image = await pdf.embedPng(pngBytes);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: page.getWidth(),
        height: page.getHeight(),
      });
    }
    const output = await pdf.save({ useObjectStreams: false });
    await vscode.workspace.fs.writeFile(destination, output);
    this.post(panel, { type: "exported", path: destination.fsPath });
    void vscode.window.showInformationMessage(
      `Ai Illustrator File Editor: Exported ${path.basename(destination.fsPath)}`,
    );
  }

  private broadcast(document: AiDocument, message: FromExtensionMessage): void {
    for (const panel of this.panels.get(document) ?? []) this.post(panel, message);
  }

  private post(panel: vscode.WebviewPanel, message: FromExtensionMessage): void {
    void panel.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Ai Illustrator File Editor</title>
  </head>
  <body>
    <div id="root"><div class="loading">Opening Illustrator document…</div></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}
