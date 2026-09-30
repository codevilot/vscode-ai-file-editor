import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import type { EditorElement, Point, Tool } from "../src/protocol";
import { drawElements, hitTest } from "./drawing";
import { renderPageWithoutText } from "./pdfText";

interface StyleSettings {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
}

interface Props {
  page: PDFPageProxy;
  elements: EditorElement[];
  selectedId?: string;
  tool: Tool;
  zoom: number;
  style: StyleSettings;
  onSelect(id?: string): void;
  onChange(elements: EditorElement[], commit: boolean, label: string): void;
}

interface Gesture {
  kind: "move" | "draw" | "pen";
  start: Point;
  id?: string;
  original?: EditorElement[];
  points?: Point[];
}

export function EditorCanvas(props: Props) {
  const backgroundRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<Gesture | undefined>(undefined);
  const [rendering, setRendering] = useState(true);
  const viewport = props.page.getViewport({ scale: 1.8 * props.zoom });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  useEffect(() => {
    const canvas = backgroundRef.current;
    if (!canvas) return;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    let disposed = false;
    setRendering(true);
    const rendered = document.createElement("canvas");
    void renderPageWithoutText(props.page, rendered, 1.8 * props.zoom * dpr, props.elements)
      .then(() => {
        if (disposed) return;
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        canvas.getContext("2d")?.drawImage(rendered, 0, 0);
        setRendering(false);
      })
      .catch(() => {
        if (!disposed) setRendering(false);
      });
    return () => { disposed = true; };
  }, [props.page, props.elements, props.zoom, dpr, viewport.height, viewport.width]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    drawElements(context, props.elements, {
      selectedId: props.selectedId,
      pageWidth: props.page.view[2] - props.page.view[0],
    });
  }, [props.elements, props.selectedId, props.page, props.zoom, dpr, viewport.height, viewport.width]);

  function pointFromEvent(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (props.tool === "select") {
      const hit = hitTest(props.elements, point);
      props.onSelect(hit?.id);
      if (hit) {
        gestureRef.current = {
          kind: "move",
          start: point,
          id: hit.id,
          original: structuredClone(props.elements),
        };
      }
      return;
    }

    if (props.tool === "text") {
      const element = makeElement("text", point, props.style);
      props.onSelect(element.id);
      props.onChange([...props.elements, element], true, "Add text");
      return;
    }

    if (props.tool === "pen") {
      gestureRef.current = { kind: "pen", start: point, points: [point] };
      return;
    }
    gestureRef.current = { kind: "draw", start: point };
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = pointFromEvent(event);
    if (gesture.kind === "move" && gesture.original && gesture.id) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      const next = gesture.original.map((element) =>
        element.id === gesture.id ? moveElement(element, dx, dy) : element,
      );
      props.onChange(next, false, "Move element");
      return;
    }
    if (gesture.kind === "pen") {
      gesture.points?.push(point);
      const preview = makePen(gesture.points ?? [], props.style);
      props.onChange([...props.elements.filter((item) => item.id !== "__preview"), preview], false, "Draw path");
      return;
    }
    const preview = makeShape(props.tool, gesture.start, point, props.style);
    props.onChange([...props.elements.filter((item) => item.id !== "__preview"), preview], false, `Draw ${props.tool}`);
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = pointFromEvent(event);
    gestureRef.current = undefined;

    if (gesture.kind === "move" && gesture.original && gesture.id) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      props.onChange(
        gesture.original.map((element) =>
          element.id === gesture.id ? moveElement(element, dx, dy) : element,
        ),
        true,
        "Move element",
      );
      return;
    }

    const withoutPreview = props.elements.filter((item) => item.id !== "__preview");
    if (gesture.kind === "pen") {
      const points = [...(gesture.points ?? []), point];
      if (points.length > 2) {
        const element = { ...makePen(points, props.style), id: crypto.randomUUID() };
        props.onSelect(element.id);
        props.onChange([...withoutPreview, element], true, "Draw path");
      }
      return;
    }

    const element = { ...makeShape(props.tool, gesture.start, point, props.style), id: crypto.randomUUID() };
    if (Math.abs(element.width) + Math.abs(element.height) > 0.006) {
      props.onSelect(element.id);
      props.onChange([...withoutPreview, element], true, `Draw ${props.tool}`);
    } else {
      props.onChange(withoutPreview, false, "Cancel drawing");
    }
  }

  return (
    <div className="artboard" style={{ width: viewport.width, height: viewport.height }}>
      <canvas ref={backgroundRef} className="page-canvas" />
      <canvas
        ref={overlayRef}
        className={`overlay-canvas tool-${props.tool}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
      {rendering && <div className="rendering">Rendering…</div>}
    </div>
  );
}

function makeElement(type: EditorElement["type"], point: Point, style: StyleSettings): EditorElement {
  return {
    id: crypto.randomUUID(),
    type,
    x: point.x,
    y: point.y,
    width: type === "text" ? 0.28 : 0,
    height: type === "text" ? 0.08 : 0,
    fill: style.fill,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    text: type === "text" ? "Text" : undefined,
    fontSize: style.fontSize,
    fontFamily: "system-ui, sans-serif",
    fontWeight: 600,
    rotation: 0,
    source: "user",
  };
}

function makeShape(
  tool: Tool,
  start: Point,
  end: Point,
  style: StyleSettings,
): EditorElement {
  return {
    ...makeElement(tool as EditorElement["type"], start, style),
    id: "__preview",
    width: end.x - start.x,
    height: end.y - start.y,
    fill: tool === "line" ? "transparent" : style.fill,
  };
}

function makePen(points: Point[], style: StyleSettings): EditorElement {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    ...makeElement("pen", points[0] ?? { x: 0, y: 0 }, style),
    id: "__preview",
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    fill: "transparent",
    points,
  };
}

function moveElement(element: EditorElement, dx: number, dy: number): EditorElement {
  const next = { ...element, x: clamp(element.x + dx), y: clamp(element.y + dy) };
  if (element.points) {
    next.points = element.points.map((point) => ({
      x: clamp(point.x + dx),
      y: clamp(point.y + dy),
    }));
  }
  return next;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
