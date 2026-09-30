import { useEffect, useMemo, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  DocumentInfo,
  EditorElement,
  EditorState,
  FromExtensionMessage,
  Tool,
} from "../src/protocol";
import { EditorCanvas } from "./EditorCanvas";
import { createFlattenedPagePng, extractPdfText } from "./pdfText";
import { vscode } from "./vscode";

const TOOLS: Array<{ id: Tool; icon: string; label: string; shortcut: string }> = [
  { id: "select", icon: "↖", label: "Select", shortcut: "V" },
  { id: "text", icon: "T", label: "Text", shortcut: "T" },
  { id: "rectangle", icon: "□", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", icon: "○", label: "Ellipse", shortcut: "O" },
  { id: "line", icon: "╱", label: "Line", shortcut: "L" },
  { id: "pen", icon: "✎", label: "Pen", shortcut: "P" },
];

const DEFAULT_STYLE = {
  fill: "#2563eb",
  stroke: "#111827",
  strokeWidth: 1,
  fontSize: 16,
  opacity: 1,
};

interface LoadedDocument {
  pdf: PDFDocumentProxy;
  pages: PDFPageProxy[];
  info: DocumentInfo;
}

let pdfWorker: Worker | undefined;

export function App() {
  const [document, setDocument] = useState<LoadedDocument>();
  const [state, setState] = useState<EditorState>({
    version: 2,
    pages: {},
    importedPages: [],
  });
  const [tool, setTool] = useState<Tool>("select");
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [notice, setNotice] = useState<string>();

  const elements = state.pages[String(pageIndex)] ?? [];
  const visibleElements = elements.filter((element) => !element.hidden);
  const selected = visibleElements.find((element) => element.id === selectedId);

  useEffect(() => {
    let initialized = false;
    const receive = async (event: MessageEvent<FromExtensionMessage>) => {
      const message = event.data;
      if (message.type === "init") {
        initialized = true;
        try {
          if (!pdfWorker) {
            const response = await fetch(message.workerUri);
            if (!response.ok) throw new Error(`Could not load PDF worker (${response.status})`);
            const workerUrl = URL.createObjectURL(new Blob(
              [await response.text()],
              { type: "text/javascript" },
            ));
            pdfWorker = new Worker(workerUrl, { type: "module" });
            GlobalWorkerOptions.workerPort = pdfWorker;
          }
          const binary = Uint8Array.from(atob(message.pdfBase64), (char) => char.charCodeAt(0));
          const pdf = await getDocument({ data: binary }).promise;
          const pages = await Promise.all(
            Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1)),
          );
          const hydratedState = await hydratePdfText(message.state, pages);
          setState(hydratedState);
          const editablePage = pages.findIndex((_, index) =>
            (hydratedState.pages[String(index)] ?? []).some(
              (element) => element.type === "text" && element.source === "pdf",
            ),
          );
          if (editablePage >= 0) setPageIndex(editablePage);
          setDocument({ pdf, pages, info: message.info });
        } catch (error) {
          setNotice(`Could not render this AI file: ${(error as Error).message}`);
        }
      } else if (message.type === "state") {
        setState(message.state);
        setSelectedId(undefined);
      } else if (message.type === "saved") {
        showNotice("Edit state saved");
      } else if (message.type === "exported") {
        showNotice(`Exported ${message.path}`);
      } else if (message.type === "error") {
        showNotice(message.message);
      }
    };
    window.addEventListener("message", receive);
    vscode.postMessage({ type: "ready" });
    const retry = window.setInterval(() => {
      if (!initialized) vscode.postMessage({ type: "ready" });
    }, 750);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener("message", receive);
    };
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (isEditingInput()) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        const target = elements.find((element) => element.id === selectedId);
        if (target) removeElement(target);
        setSelectedId(undefined);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const nextTool = TOOLS.find((item) => item.shortcut.toLowerCase() === event.key.toLowerCase());
      if (nextTool) setTool(nextTool.id);
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [elements, selectedId, pageIndex, state]);

  const pageSize = useMemo(() => {
    const page = document?.pages[pageIndex];
    if (!page) return undefined;
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }, [document, pageIndex]);

  function showNotice(message: string): void {
    setNotice(message);
    window.setTimeout(() => setNotice(undefined), 3500);
  }

  function updatePage(next: EditorElement[], commit: boolean, label: string): void {
    const clean = next.filter((element) => element.id !== "__preview");
    const nextState: EditorState = {
      version: 2,
      pages: { ...state.pages, [String(pageIndex)]: commit ? clean : next },
      importedPages: state.importedPages,
    };
    setState(nextState);
    if (commit) vscode.postMessage({ type: "change", state: nextState, label });
  }

  function patchSelected(patch: Partial<EditorElement>, commit: boolean, label: string): void {
    if (!selectedId) return;
    updatePage(
      elements.map((element) =>
        element.id === selectedId ? { ...element, ...patch } : element,
      ),
      commit,
      label,
    );
  }

  function commitCurrent(label: string): void {
    const nextState: EditorState = {
      version: 2,
      pages: { ...state.pages, [String(pageIndex)]: elements },
      importedPages: state.importedPages,
    };
    vscode.postMessage({ type: "change", state: nextState, label });
  }

  function duplicateSelected(): void {
    if (!selected) return;
    const copy: EditorElement = {
      ...structuredClone(selected),
      id: crypto.randomUUID(),
      source: "user",
      originalBounds: undefined,
      x: Math.min(1, selected.x + 0.025),
      y: Math.min(1, selected.y + 0.025),
      points: selected.points?.map((point) => ({
        x: Math.min(1, point.x + 0.025),
        y: Math.min(1, point.y + 0.025),
      })),
    };
    setSelectedId(copy.id);
    updatePage([...elements, copy], true, "Duplicate element");
  }

  function removeElement(element: EditorElement): void {
    const next = element.source === "pdf"
      ? elements.map((item) => item.id === element.id ? { ...item, hidden: true } : item)
      : elements.filter((item) => item.id !== element.id);
    updatePage(next, true, "Delete element");
  }

  async function exportPdf(): Promise<void> {
    if (!document) return;
    showNotice("Preparing edited PDF…");
    try {
      const overlays = await Promise.all(document.pages.map(async (page, index) => ({
        pageIndex: index,
        pngDataUrl: await createFlattenedPagePng(page, state.pages[String(index)] ?? []),
      })));
      vscode.postMessage({ type: "export", overlays });
    } catch (error) {
      showNotice(`Could not export: ${(error as Error).message}`);
    }
  }

  if (!document) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>{notice ?? "Opening Illustrator document…"}</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Ai</span>
          <div>
            <strong>{document.info.fileName}</strong>
            <span>{formatBytes(document.info.byteLength)} · PDF-compatible AI</span>
          </div>
        </div>
        <div className="top-actions">
          {document.pdf.numPages > 1 && (
            <div className="page-switcher" aria-label="Page navigation">
              <button disabled={pageIndex === 0} onClick={() => { setPageIndex(pageIndex - 1); setSelectedId(undefined); }}>‹</button>
              <span>{pageIndex + 1} / {document.pdf.numPages}</span>
              <button disabled={pageIndex === document.pdf.numPages - 1} onClick={() => { setPageIndex(pageIndex + 1); setSelectedId(undefined); }}>›</button>
            </div>
          )}
          <button className="button secondary" onClick={() => vscode.postMessage({ type: "show-message", message: `Edits are saved to ${document.info.sidecarPath}` })}>
            Where are edits saved?
          </button>
          <button className="button primary" onClick={() => void exportPdf()}>Export PDF</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="toolbar" aria-label="Drawing tools">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              className={tool === item.id ? "tool active" : "tool"}
              title={`${item.label} (${item.shortcut})`}
              onClick={() => setTool(item.id)}
            >
              <span>{item.icon}</span>
              <small>{item.shortcut}</small>
            </button>
          ))}
        </aside>

        <main className="canvas-area" onClick={(event) => {
          if (event.target === event.currentTarget) setSelectedId(undefined);
        }}>
          <div className="canvas-scroll">
            {document.pages[pageIndex] && (
              <EditorCanvas
                page={document.pages[pageIndex]}
                elements={elements}
                selectedId={selectedId}
                tool={tool}
                zoom={zoom}
                style={style}
                onSelect={setSelectedId}
                onChange={updatePage}
              />
            )}
          </div>
          <div className="zoom-control">
            <button onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((value) => Math.min(4, value + 0.1))}>＋</button>
            <button onClick={() => setZoom(1)}>Reset</button>
          </div>
          {selected?.type === "text" && (
            <label className="mobile-text-editor">
              <span>Edit text</span>
              <textarea
                value={selected.text ?? ""}
                onChange={(event) => patchSelected({ text: event.target.value }, false, "Edit text")}
                onBlur={() => commitCurrent("Edit text")}
              />
            </label>
          )}
        </main>

        <aside className="inspector">
          <section>
            <h2>Document</h2>
            <div className="stats">
              <span>Page</span><strong>{pageIndex + 1} / {document.pdf.numPages}</strong>
              <span>Size</span><strong>{pageSize ? `${Math.round(pageSize.width)} × ${Math.round(pageSize.height)} pt` : "—"}</strong>
            </div>
            {document.pdf.numPages > 1 && (
              <div className="page-tabs">
                {document.pages.map((_, index) => (
                  <button
                    key={index}
                    className={index === pageIndex ? "active" : ""}
                    onClick={() => { setPageIndex(index); setSelectedId(undefined); }}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>{selected ? "Selection" : "New object style"}</h2>
            {selected?.type === "text" && (
              <label className="field wide">
                <span>Text</span>
                <textarea
                  value={selected.text ?? ""}
                  onChange={(event) => patchSelected({ text: event.target.value }, false, "Edit text")}
                  onBlur={() => commitCurrent("Edit text")}
                />
              </label>
            )}
            <div className="field-grid">
              <ColorField
                label="Fill"
                value={selected?.fill ?? style.fill}
                onChange={(value) => selected ? patchSelected({ fill: value }, true, "Change fill") : setStyle({ ...style, fill: value })}
              />
              <ColorField
                label="Stroke"
                value={selected?.stroke ?? style.stroke}
                onChange={(value) => selected ? patchSelected({ stroke: value }, true, "Change stroke") : setStyle({ ...style, stroke: value })}
              />
              <NumberField
                label="Stroke"
                value={selected?.strokeWidth ?? style.strokeWidth}
                min={0}
                max={20}
                step={0.5}
                onChange={(value) => selected ? patchSelected({ strokeWidth: value }, true, "Change stroke width") : setStyle({ ...style, strokeWidth: value })}
              />
              <NumberField
                label="Opacity"
                value={Math.round((selected?.opacity ?? style.opacity) * 100)}
                min={0}
                max={100}
                step={1}
                onChange={(value) => selected ? patchSelected({ opacity: value / 100 }, true, "Change opacity") : setStyle({ ...style, opacity: value / 100 })}
              />
              {(selected?.type === "text" || (!selected && tool === "text")) && (
                <NumberField
                  label="Font size"
                  value={selected?.fontSize ?? style.fontSize}
                  min={4}
                  max={144}
                  step={1}
                  onChange={(value) => selected ? patchSelected({ fontSize: value }, true, "Change font size") : setStyle({ ...style, fontSize: value })}
                />
              )}
            </div>
            {selected && (
              <div className="selection-actions">
                <button onClick={duplicateSelected}>Duplicate</button>
                <button className="danger" onClick={() => {
                  removeElement(selected);
                  setSelectedId(undefined);
                }}>Delete</button>
              </div>
            )}
          </section>

          <section className="layers-section">
            <h2>Layers <span>{visibleElements.length}</span></h2>
            <div className="layers">
              {[...visibleElements].reverse().map((element, reverseIndex) => (
                <button
                  key={element.id}
                  className={element.id === selectedId ? "layer active" : "layer"}
                  onClick={() => { setSelectedId(element.id); setTool("select"); }}
                >
                  <span className="layer-icon">{toolIcon(element.type)}</span>
                  <span>{element.type === "text" ? element.text || "Text" : capitalize(element.type)}</span>
                  <small>{element.source === "pdf" ? "PDF" : visibleElements.length - reverseIndex}</small>
                </button>
              ))}
              {visibleElements.length === 0 && <div className="empty-layers">Choose a tool and draw on the page.</div>}
            </div>
          </section>
        </aside>
      </div>

      <footer className="statusbar">
        <span>PDF text is editable; the source Illustrator file stays unchanged</span>
        <span>{visibleElements.length} editable object{visibleElements.length === 1 ? "" : "s"}</span>
      </footer>
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function ColorField(props: { label: string; value: string; onChange(value: string): void }) {
  const color = props.value === "transparent" ? "#ffffff" : props.value;
  return (
    <label className="field color-field">
      <span>{props.label}</span>
      <div>
        <input type="color" value={color} onChange={(event) => props.onChange(event.target.value)} />
        <code>{props.value}</code>
      </div>
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function toolIcon(type: EditorElement["type"]): string {
  return TOOLS.find((tool) => tool.id === type)?.icon ?? "•";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isEditingInput(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

async function hydratePdfText(
  saved: EditorState,
  pages: PDFPageProxy[],
): Promise<EditorState> {
  const importedPages = new Set(saved.importedPages);
  const nextPages = { ...saved.pages };
  const extracted = await Promise.all(
    pages.map((page, index) => extractPdfText(page, index)),
  );

  extracted.forEach((textElements, index) => {
    const key = String(index);
    if (importedPages.has(key)) {
      const defaults = new Map(textElements.map((element) => [element.id, element]));
      nextPages[key] = (saved.pages[key] ?? []).map((element) => {
        const extractedElement = defaults.get(element.id);
        if (!extractedElement) return element;
        return {
          ...extractedElement,
          ...element,
          originalBounds: element.originalBounds ?? extractedElement.originalBounds,
        };
      });
      return;
    }
    nextPages[key] = [...textElements, ...(saved.pages[key] ?? [])];
    importedPages.add(key);
  });

  return {
    version: 2,
    pages: nextPages,
    importedPages: [...importedPages],
  };
}
