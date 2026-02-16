export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

export function parseTime(str: string): number {
  const parts = str.split(':');
  if (parts.length === 2) {
    const [mins, secsPart] = parts;
    const [secs, ms] = (secsPart ?? '0').split('.');
    return Number(mins) * 60 + Number(secs) + Number(ms ?? 0) / 100;
  }
  return Number(str) || 0;
}

export function snapToGrid(time: number, interval: number): number {
  if (interval <= 0) return time;
  return Math.round(time / interval) * interval;
}

export function timeToPixels(time: number, zoom: number, pixelsPerSecond = 50): number {
  return time * pixelsPerSecond * zoom;
}

export function pixelsToTime(pixels: number, zoom: number, pixelsPerSecond = 50): number {
  return pixels / (pixelsPerSecond * zoom);
}
