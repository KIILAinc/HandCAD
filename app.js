const svg = document.querySelector(".canvas");
const shapeLayer = document.querySelector("#shapes");
const draft = document.querySelector("#draft");
const gridBackground = document.querySelector("#grid-background");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const SVG_NS = "http://www.w3.org/2000/svg";
const UNITS_PER_GRID = 24;
const MM_PER_GRID = 10;

let shapes = [];
let history = [];
let future = [];
let drawing = null;

function resizeCanvas() {
  const { width, height } = svg.getBoundingClientRect();
  if (!width || !height) return;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  gridBackground.setAttribute("width", width);
  gridBackground.setAttribute("height", height);
}

new ResizeObserver(resizeCanvas).observe(svg);
resizeCanvas();

function localPoint(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(svg.getScreenCTM().inverse());
  return { x: local.x, y: local.y };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathData(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
}

function syncHistoryButtons() {
  undoButton.disabled = history.length === 0;
  redoButton.disabled = future.length === 0;
}

function commitShapes(next) {
  history.push(shapes);
  shapes = next;
  future = [];
  render();
}

function addShape(shape) { commitShapes([...shapes, shape]); }

function render() {
  shapeLayer.replaceChildren();
  for (const shape of shapes) {
    let element;
    if (shape.kind === "circle") {
      element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", shape.cx);
      element.setAttribute("cy", shape.cy);
      element.setAttribute("r", shape.r);
    } else if (shape.kind === "rectangle") {
      element = document.createElementNS(SVG_NS, "rect");
      element.setAttribute("x", shape.x);
      element.setAttribute("y", shape.y);
      element.setAttribute("width", shape.width);
      element.setAttribute("height", shape.height);
    } else if (shape.kind === "line") {
      element = document.createElementNS(SVG_NS, "line");
      element.setAttribute("x1", shape.start.x);
      element.setAttribute("y1", shape.start.y);
      element.setAttribute("x2", shape.end.x);
      element.setAttribute("y2", shape.end.y);
      element.dataset.shapeIndex = String(shapes.indexOf(shape));
    } else {
      element = document.createElementNS(SVG_NS, "path");
      element.setAttribute("d", pathData(shape.points));
    }
    element.classList.add("cad-shape");
    shapeLayer.append(element);
  }
  syncHistoryButtons();
}

function isStraight(points) {
  const start = points[0];
  const end = points.at(-1);
  const length = distance(start, end);
  if (length < 10) return false;
  const pathLength = points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
  if (pathLength / length > 1.16) return false;
  const deviations = points.map(point => Math.abs((end.x - start.x) * (start.y - point.y) - (start.x - point.x) * (end.y - start.y)) / length);
  deviations.sort((a, b) => a - b);
  return deviations[Math.floor((deviations.length - 1) * 0.9)] < 10;
}

function recognize(points) {
  if (points.length < 2) return null;

  const first = points[0];
  const last = points.at(-1);
  const closed = points.length > 12 && distance(first, last) < 34;
  if (!closed) {
    if (isStraight(points)) return { kind: "line", start: first, end: last };
    return { kind: "freehand", points };
  }

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const width = right - left, height = bottom - top;
  if (width < 8 || height < 8) return { kind: "freehand", points };

  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const diagonal = Math.hypot(width, height);
  const corners = [
    { x: left, y: top }, { x: right, y: top },
    { x: right, y: bottom }, { x: left, y: bottom },
  ];
  const reachesCorners = corners.every(corner => points.some(point => distance(point, corner) < diagonal * 0.15));
  if (reachesCorners && points.length > 20 && width / height > 0.18 && width / height < 5.5) {
    return { kind: "rectangle", x: left, y: top, width, height };
  }

  const radii = points.map(point => distance(point, center));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  const radiusError = radii.reduce((sum, radius) => sum + Math.abs(radius - meanRadius), 0) / radii.length / meanRadius;
  const aspect = width / height;
  if (aspect > 0.78 && aspect < 1.28 && radiusError < 0.13) {
    return { kind: "circle", cx: center.x, cy: center.y, r: (width + height) / 4 };
  }
  return { kind: "freehand", points };
}

function setStrokeLength(index, edgeStart, edgeEnd, promptedMillimeters) {
  const millimeters = Number(promptedMillimeters);
  if (!Number.isFinite(millimeters) || millimeters <= 0) return;
  const targetLength = millimeters * UNITS_PER_GRID / MM_PER_GRID;
  const dx = edgeEnd.x - edgeStart.x;
  const dy = edgeEnd.y - edgeStart.y;
  const currentLength = Math.hypot(dx, dy);
  if (!currentLength) return;
  const end = { x: edgeStart.x + dx / currentLength * targetLength, y: edgeStart.y + dy / currentLength * targetLength };
  const shape = shapes[index];
  if (shape.kind === "line") {
    const next = [...shapes];
    next[index] = { ...shape, start: edgeStart, end };
    commitShapes(next);
  } else if (shape.kind === "rectangle") {
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const next = [...shapes];
    next[index] = isHorizontal ? { ...shape, width: targetLength } : { ...shape, height: targetLength };
    commitShapes(next);
  }
}

function nearestRectangleEdge(shape, point) {
  const edges = [
    [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y }],
    [{ x: shape.x + shape.width, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }],
    [{ x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }],
    [{ x: shape.x, y: shape.y + shape.height }, { x: shape.x, y: shape.y }],
  ];
  const measure = ([start, end]) => {
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    const nearest = { x: start.x + t * dx, y: start.y + t * dy };
    return { start, end, distance: distance(point, nearest) };
  };
  return edges.map(measure).sort((a, b) => a.distance - b.distance)[0];
}

function editLengthAt(event) {
  const point = localPoint(event);
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  let index = hit?.dataset.shapeIndex ? Number(hit.dataset.shapeIndex) : -1;
  let edge;

  if (index >= 0 && shapes[index]?.kind === "line") {
    const shape = shapes[index];
    edge = { start: shape.start, end: shape.end };
  } else {
    index = shapes.findIndex(shape => shape.kind === "rectangle" && nearestRectangleEdge(shape, point).distance < 18);
    if (index < 0) return;
    edge = nearestRectangleEdge(shapes[index], point);
  }

  const currentMillimeters = distance(edge.start, edge.end) * MM_PER_GRID / UNITS_PER_GRID;
  const input = prompt(`辺の長さ (mm)  •  現在 ${currentMillimeters.toFixed(1)} mm`, currentMillimeters.toFixed(1));
  if (input !== null) setStrokeLength(index, edge.start, edge.end, input);
}

svg.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  svg.setPointerCapture(event.pointerId);
  drawing = [localPoint(event)];
  draft.setAttribute("d", pathData(drawing));
});

svg.addEventListener("pointermove", event => {
  if (!drawing) return;
  drawing.push(localPoint(event));
  draft.setAttribute("d", pathData(drawing));
});

svg.addEventListener("pointerup", () => {
  if (!drawing) return;
  const shape = recognize(drawing);
  if (shape) addShape(shape);
  drawing = null;
  draft.setAttribute("d", "");
});

svg.addEventListener("pointercancel", () => {
  drawing = null;
  draft.setAttribute("d", "");
});
svg.addEventListener("dblclick", event => {
  event.preventDefault();
  editLengthAt(event);
});

undoButton.addEventListener("click", () => {
  if (!history.length) return;
  future.push(shapes);
  shapes = history.pop();
  render();
});
redoButton.addEventListener("click", () => {
  if (!future.length) return;
  history.push(shapes);
  shapes = future.pop();
  render();
});

window.addEventListener("keydown", event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
  event.preventDefault();
  if (event.shiftKey) redoButton.click();
  else undoButton.click();
});
