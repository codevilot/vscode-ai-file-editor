import type { EditorElement } from "../src/protocol";

export interface DrawOptions {
  selectedId?: string;
  pageWidth: number;
  clear?: boolean;
}

export function drawElements(
  context: CanvasRenderingContext2D,
  elements: EditorElement[],
  options: DrawOptions,
): void {
  const { width, height } = context.canvas;
  const unit = width / options.pageWidth;
  if (options.clear !== false) context.clearRect(0, 0, width, height);

  for (const element of elements) {
    if (element.hidden) continue;
    context.save();
    context.globalAlpha = element.opacity;
    context.fillStyle = element.fill;
    context.strokeStyle = element.stroke;
    context.lineWidth = Math.max(1, element.strokeWidth * unit);
    context.lineCap = "round";
    context.lineJoin = "round";

    const x = element.x * width;
    const y = element.y * height;
    const w = element.width * width;
    const h = element.height * height;

    switch (element.type) {
      case "text":
        context.font = `${element.fontWeight ?? 600} ${Math.max(1, (element.fontSize ?? 16) * unit)}px ${element.fontFamily ?? "system-ui, sans-serif"}`;
        context.textBaseline = "top";
        if (element.rotation) {
          context.translate(x, y);
          context.rotate(element.rotation * Math.PI / 180);
          context.fillText(element.text ?? "Text", 0, 0);
        } else {
          context.fillText(element.text ?? "Text", x, y);
        }
        break;
      case "rectangle":
        if (element.fill !== "transparent") context.fillRect(x, y, w, h);
        if (element.strokeWidth > 0) context.strokeRect(x, y, w, h);
        break;
      case "ellipse": {
        context.beginPath();
        context.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        if (element.fill !== "transparent") context.fill();
        if (element.strokeWidth > 0) context.stroke();
        break;
      }
      case "line":
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + w, y + h);
        context.stroke();
        break;
      case "pen": {
        const points = element.points ?? [];
        if (points.length > 0) {
          context.beginPath();
          context.moveTo(points[0].x * width, points[0].y * height);
          for (const point of points.slice(1)) {
            context.lineTo(point.x * width, point.y * height);
          }
          context.stroke();
        }
        break;
      }
    }
    context.restore();
  }

  const selected = elements.find((element) => element.id === options.selectedId);
  if (selected) drawSelection(context, selected);
}

export function hitTest(
  elements: EditorElement[],
  point: { x: number; y: number },
): EditorElement | undefined {
  const tolerance = 0.012;
  return [...elements].reverse().find((element) => {
    if (element.hidden) return false;
    const bounds = getBounds(element);
    return (
      point.x >= bounds.left - tolerance &&
      point.x <= bounds.right + tolerance &&
      point.y >= bounds.top - tolerance &&
      point.y <= bounds.bottom + tolerance
    );
  });
}

export function getBounds(element: EditorElement) {
  if (element.type === "pen" && element.points?.length) {
    const xs = element.points.map((point) => point.x);
    const ys = element.points.map((point) => point.y);
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
  }
  return {
    left: Math.min(element.x, element.x + element.width),
    right: Math.max(element.x, element.x + element.width),
    top: Math.min(element.y, element.y + element.height),
    bottom: Math.max(element.y, element.y + element.height),
  };
}

function drawSelection(context: CanvasRenderingContext2D, element: EditorElement): void {
  const bounds = getBounds(element);
  const x = bounds.left * context.canvas.width;
  const y = bounds.top * context.canvas.height;
  const width = (bounds.right - bounds.left) * context.canvas.width;
  const height = (bounds.bottom - bounds.top) * context.canvas.height;
  context.save();
  context.globalAlpha = 1;
  context.strokeStyle = "#3b82f6";
  context.lineWidth = Math.max(2, context.canvas.width / 500);
  context.setLineDash([6, 4]);
  context.strokeRect(x - 4, y - 4, width + 8, height + 8);
  context.setLineDash([]);
  for (const [hx, hy] of [
    [x - 4, y - 4],
    [x + width + 4, y - 4],
    [x - 4, y + height + 4],
    [x + width + 4, y + height + 4],
  ]) {
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#2563eb";
    context.fillRect(hx - 3, hy - 3, 6, 6);
    context.strokeRect(hx - 3, hy - 3, 6, 6);
  }
  context.restore();
}

export function createOverlayPng(
  elements: EditorElement[],
  pageWidth: number,
  pageHeight: number,
): string | undefined {
  if (elements.length === 0) return undefined;
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pageWidth * scale));
  canvas.height = Math.max(1, Math.round(pageHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  drawElements(context, elements, { pageWidth });
  return canvas.toDataURL("image/png");
}
