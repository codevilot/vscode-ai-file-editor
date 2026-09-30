import * as vscode from "vscode";
import { AiEditorProvider } from "./editorProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AiEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(AiEditorProvider.viewType, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("aiEditor.openWith", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showWarningMessage("Select an .ai file first.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, AiEditorProvider.viewType);
    }),
  );

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    const timer = setTimeout(() => void openDevelopmentFile(), 300);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

export function deactivate(): void {}

async function openDevelopmentFile(): Promise<void> {
  await Promise.allSettled([
    vscode.commands.executeCommand("workbench.action.closePanel"),
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar"),
  ]);
  await vscode.commands.executeCommand("workbench.view.explorer");
  const activeAi = vscode.window.activeTextEditor?.document.uri;
  const target = activeAi?.fsPath.toLowerCase().endsWith(".ai")
    ? activeAi
    : (await vscode.workspace.findFiles("*.ai", "**/node_modules/**", 1))[0];

  if (target) {
    await vscode.commands.executeCommand("vscode.openWith", target, AiEditorProvider.viewType);
  }
}
