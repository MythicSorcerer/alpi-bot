import type { ItemStack } from "../protocol/types.js";

export const AIR = "minecraft:air";

export function ns(path: string): string {
  return path.includes(":") ? path : `minecraft:${path}`;
}

export function itemName(path: string): string {
  return ns(path).split(":")[1] ?? path;
}

export function countItem(inventory: ItemStack[], item: string): number {
  const wanted = ns(item);
  return inventory.filter((stack) => stack.item === wanted).reduce((sum, stack) => sum + stack.count, 0);
}

export function findItem(inventory: ItemStack[], item: string): ItemStack | undefined {
  const wanted = ns(item);
  return inventory.find((stack) => stack.item === wanted);
}

export function inventorySlotsUsed(inventory: ItemStack[]): number {
  return inventory.length;
}

export function totalItems(inventory: ItemStack[]): number {
  return inventory.reduce((sum, stack) => sum + stack.count, 0);
}

/**
 * Apply a delta to a simple inventory model. Gear stacks stay as separate
 * stacks because their enchantment NBT makes them distinct.
 */
export function addToInventory(inventory: ItemStack[], stack: ItemStack, maxSlots = 36): ItemStack[] {
  const next = inventory.map((s) => ({ ...s }));
  const unique = stack.enchants !== undefined || stack.customName !== undefined || (stack.durability !== undefined);
  let remaining = stack.count;
  if (!unique) {
    for (const existing of next) {
      if (existing.item !== stack.item || existing.enchants !== undefined) continue;
      const room = 64 - existing.count;
      if (room <= 0) continue;
      const moved = Math.min(room, remaining);
      existing.count += moved;
      remaining -= moved;
      if (remaining === 0) break;
    }
  }
  while (remaining > 0) {
    if (next.length >= maxSlots) throw new Error("inventory full");
    const moved = unique ? 1 : Math.min(64, remaining);
    next.push({ ...stack, count: moved, slot: next.length });
    remaining -= moved;
  }
  return next;
}

export function removeFromInventory(inventory: ItemStack[], item: string, count: number): ItemStack[] {
  const wanted = ns(item);
  let remaining = count;
  const next: ItemStack[] = [];
  for (const stack of inventory) {
    if (stack.item !== wanted || remaining === 0) {
      next.push({ ...stack });
      continue;
    }
    const removed = Math.min(stack.count, remaining);
    remaining -= removed;
    if (stack.count - removed > 0) next.push({ ...stack, count: stack.count - removed });
  }
  if (remaining > 0) throw new Error(`missing ${remaining}x ${wanted}`);
  return next.map((s, index) => ({ ...s, slot: index }));
}

/** Compute the delta between two inventory snapshots for evidence/result data. */
function countChunks(stack: ItemStack, count: number): ItemStack[] {
  const chunks: ItemStack[] = [];
  let remaining = count;
  while (remaining > 0) {
    const take = Math.min(64, remaining);
    chunks.push({ ...stack, count: take });
    remaining -= take;
  }
  return chunks;
}

export function inventoryDelta(before: ItemStack[], after: ItemStack[]): { added: ItemStack[]; removed: ItemStack[] } {
  const key = (s: ItemStack) => `${s.item}|${JSON.stringify(s.enchants ?? [])}|${s.customName ?? ""}`;
  const tally = (inventory: ItemStack[]) => {
    const map = new Map<string, { stack: ItemStack; count: number }>();
    for (const stack of inventory) {
      const k = key(stack);
      const entry = map.get(k);
      if (entry) entry.count += stack.count;
      else map.set(k, { stack, count: stack.count });
    }
    return map;
  };
  const beforeMap = tally(before);
  const afterMap = tally(after);
  const added: ItemStack[] = [];
  const removed: ItemStack[] = [];
  for (const [k, entry] of afterMap) {
    const previous = beforeMap.get(k)?.count ?? 0;
    if (entry.count > previous) added.push(...countChunks(entry.stack, entry.count - previous));
  }
  for (const [k, entry] of beforeMap) {
    const next = afterMap.get(k)?.count ?? 0;
    if (entry.count > next) removed.push(...countChunks(entry.stack, entry.count - next));
  }
  return { added, removed };
}

export function describeItems(inventory: ItemStack[]): string {
  return inventory
    .filter((s) => s.count > 0)
    .map((s) => `${s.count}x ${s.item}${s.enchants?.length ? ` [${s.enchants.map((e) => `${e.id}=${e.level}`).join(",")}]` : ""}`)
    .join(", ");
}
