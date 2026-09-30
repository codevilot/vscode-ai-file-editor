import { OPS, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EditorElement } from "../src/protocol";
import { drawElements } from "./drawing";

interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  fontName: string;
  transform: number[];
}

const TEXT_OPERATIONS = new Set<number>([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);

export async function extractPdfText(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<EditorElement[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const colors = await extractTextColors(page);
  let colorIndex = 0;

  return content.items.flatMap((candidate, itemIndex) => {
    if (!("str" in candidate)) return [];
    const item = candidate as PdfTextItem;
    const fill = colors[colorIndex] ?? "#111111";
    colorIndex += 1;
    if (!item.str.trim()) return [];

    const style = content.styles[item.fontName];
    const fontSize = item.height || Math.hypot(item.transform[2], item.transform[3]);
    const ascent = style?.ascent ?? 0.8;
    const [baselineX, baselineY] = viewport.convertToViewportPoint(
      item.transform[4],
      item.transform[5],
    );
    const rotation = Math.atan2(item.transform[1], item.transform[0]) * 180 / Math.PI;

    const bounds = {
      x: clamp(baselineX / viewport.width),
      y: clamp((baselineY - fontSize * ascent) / viewport.height),
      width: Math.max(0.006, item.width / viewport.width),
      height: Math.max(0.012, fontSize * 1.2 / viewport.height),
    };
    return [{
      id: `pdf-text-${pageIndex}-${itemIndex}`,
      type: "text" as const,
      ...bounds,
      fill,
      stroke: "transparent",
      strokeWidth: 0,
      opacity: 1,
      text: item.str,
      fontSize,
      fontFamily: style?.fontFamily || "sans-serif",
      fontWeight: 400,
      rotation,
      source: "pdf" as const,
      originalBounds: bounds,
    }];
  });
}

export async function renderPageWithoutText(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  elements: EditorElement[],
): Promise<void> {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  const task = page.render({
    canvas,
    canvasContext: context,
    viewport,
    background: "#ffffff",
  });
  await task.promise;
  eraseOriginalText(context, elements);
}

export async function createFlattenedPagePng(
  page: PDFPageProxy,
  elements: EditorElement[],
): Promise<string> {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(2, 1800 / Math.max(baseViewport.width, baseViewport.height)));
  const canvas = document.createElement("canvas");
  await renderPageWithoutText(page, canvas, scale, elements);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  drawElements(context, elements, { pageWidth: baseViewport.width, clear: false });
  return canvas.toDataURL("image/png");
}

function eraseOriginalText(
  context: CanvasRenderingContext2D,
  elements: EditorElement[],
): void {
  const { width, height } = context.canvas;
  for (const element of elements) {
    if (element.source !== "pdf" || !element.originalBounds) continue;
    const bounds = element.originalBounds;
    const x = bounds.x * width;
    const y = bounds.y * height;
    const w = bounds.width * width;
    const h = bounds.height * height;
    const padding = Math.max(2, width / 700);
    context.fillStyle = sampleBackground(context, x, y, w, h, padding);
    context.fillRect(x - padding, y - padding, w + padding * 2, h + padding * 2);
  }
}

function sampleBackground(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  padding: number,
): string {
  const maxX = context.canvas.width - 1;
  const maxY = context.canvas.height - 1;
  const points = [
    [x - padding * 2, y - padding * 2],
    [x + width + padding * 2, y - padding * 2],
    [x - padding * 2, y + height + padding * 2],
    [x + width + padding * 2, y + height + padding * 2],
  ].map(([sampleX, sampleY]) => {
    const pixel = context.getImageData(
      Math.round(Math.min(maxX, Math.max(0, sampleX))),
      Math.round(Math.min(maxY, Math.max(0, sampleY))),
      1,
      1,
    ).data;
    return [pixel[0], pixel[1], pixel[2]];
  });

  let best = [points[0], points[1]];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const distance = points[first].reduce(
        (sum, channel, index) => sum + Math.abs(channel - points[second][index]),
        0,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [points[first], points[second]];
      }
    }
  }
  const average = best[0].map((channel, index) => Math.round((channel + best[1][index]) / 2));
  return `rgb(${average.join(",")})`;
}

async function extractTextColors(page: PDFPageProxy): Promise<string[]> {
  const list = await page.getOperatorList();
  const colors: string[] = [];
  let fill = "#111111";
  list.fnArray.forEach((operation, index) => {
    if (operation === OPS.setFillRGBColor) {
      const value = list.argsArray[index]?.[0];
      if (typeof value === "string" && value.startsWith("#")) fill = value;
    }
    if (TEXT_OPERATIONS.has(operation)) colors.push(fill);
  });
  return colors;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
