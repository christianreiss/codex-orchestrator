/** Scalloped envelopes around existing graph coordinates; never relocates nodes. */
export interface CloudPoint { x: number; y: number }
export function cloudPath(nodes: CloudPoint[], padding = 38): string {
  if (!nodes.length) return '';
  const points = nodes.flatMap(p => Array.from({ length: 16 }, (_, i) => ({
    x: p.x + Math.cos(i * Math.PI / 8) * padding,
    y: p.y + Math.sin(i * Math.PI / 8) * padding,
  }))).sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: CloudPoint, a: CloudPoint, b: CloudPoint) => (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const half = (input: CloudPoint[]) => {
    const result: CloudPoint[] = [];
    for (const p of input) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  const hull = [...half(points), ...half([...points].reverse())];
  const n = (v: number) => v.toFixed(2);
  let path = `M ${n(hull[0].x)} ${n(hull[0].y)}`;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i+1)%hull.length];
    const dx = b.x-a.x, dy = b.y-a.y, length = Math.hypot(dx,dy);
    const steps = Math.max(1, Math.ceil(length / 32));
    for (let j=0; j<steps; j++) {
      const t = (j+.5)/steps, end = (j+1)/steps;
      const bump = Math.min(12, length / steps * .55);
      path += ` Q ${n(a.x+dx*t+dy/length*bump)} ${n(a.y+dy*t-dx/length*bump)} ${n(a.x+dx*end)} ${n(a.y+dy*end)}`;
    }
  }
  return path + ' Z';
}
