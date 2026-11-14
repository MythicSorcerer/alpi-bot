import type { Vec3 } from "../protocol/types.js";

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, factor: number): Vec3 {
  return { x: a.x * factor, y: a.y * factor, z: a.z * factor };
}

export function moveTowards(from: Vec3, to: Vec3, maxDistance: number): Vec3 {
  const d = distance(from, to);
  if (d <= maxDistance || d === 0) return { ...to };
  return add(from, scale(sub(to, from), maxDistance / d));
}

export function floorVec(v: Vec3): Vec3 {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

export function formatVec(v: Vec3): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function yawTo(from: Vec3, to: Vec3): number {
  return normalizeAngle((Math.atan2(to.z - from.z, to.x - from.x) * 180) / Math.PI - 90);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
