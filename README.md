# Ai Illustrator File Editor for VS Code

Edit PDF-compatible Adobe Illustrator (`.ai`) files without leaving VS Code.

This extension follows the React webview and esbuild architecture used by
`lerobot-viewer`, while registering a real VS Code custom editor for `.ai` files.

## Features

- Opens `.ai` files by double-clicking them in the Explorer
- Renders every PDF-compatible artboard/page
- Extracts live PDF text into selectable, movable, editable text objects
- Select/move, text, rectangle, ellipse, line, and freehand pen tools
- Fill, stroke, stroke width, opacity, and font size controls
- Layer list, duplicate/delete, keyboard tool shortcuts
- VS Code native undo/redo and dirty/save state
- Exports the original artwork plus edits to a new PDF

## Data safety

Illustrator's private editing stream is proprietary and can be damaged by a
third-party PDF writer. Ai Illustrator File Editor therefore keeps the source `.ai` untouched.

- `Cmd/Ctrl+S` saves editable overlay data to `<file>.ai.ai-editor.json`.
- **Export PDF** writes a new `<file>.edited.pdf`.
- Text that remains live in the PDF is editable. Text converted to vector
  outlines in Illustrator remains part of the locked artwork background.

Only PDF-compatible `.ai` files can be rendered. In Illustrator, enable
**Create PDF Compatible File** when saving.

## Development

```bash
npm install
npm run check
npm run build
```

Press `F5` in VS Code to launch an Extension Development Host, then open an
`.ai` file.
