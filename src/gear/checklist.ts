import type { BotState, Enchantment, ItemStack } from "../protocol/types.js";
import type { GearRequirement } from "../config.js";

export interface GearItemStatus {
  item: string;
  ok: boolean;
  found: boolean;
  missingEnchants: Enchantment[];
  location: "inventory" | "armor" | "mainhand" | "offhand" | "missing";
  stack?: ItemStack;
}

export interface GearVerification {
  verified: boolean;
  items: GearItemStatus[];
  missingItems: string[];
  missingEnchantments: string[];
  optionalMissing: string[];
}

export interface EnchantNeed {
  item: string;
  enchant: Enchantment;
}

export function findItemStacks(bot: BotState, item: string): Array<{ stack: ItemStack; location: GearItemStatus["location"] }> {
  const result: Array<{ stack: ItemStack; location: GearItemStatus["location"] }> = [];
  for (const stack of bot.inventory) if (stack.item === item) result.push({ stack, location: "inventory" });
  for (const stack of [bot.armor.head, bot.armor.chest, bot.armor.legs, bot.armor.feet]) {
    if (stack?.item === item) result.push({ stack, location: "armor" });
  }
  if (bot.mainhand?.item === item) result.push({ stack: bot.mainhand, location: "mainhand" });
  if (bot.armor.offhand?.item === item) result.push({ stack: bot.armor.offhand, location: "offhand" });
  return result;
}

export function enchantLevel(stack: ItemStack, enchant: string): number {
  return stack.enchants?.find((entry) => entry.id === enchant)?.level ?? 0;
}

export function verifyGear(bot: BotState, checklist: GearRequirement[]): GearVerification {
  const items: GearItemStatus[] = [];
  const missingItems: string[] = [];
  const missingEnchantments: string[] = [];
  const optionalMissing: string[] = [];
  for (const requirement of checklist) {
    const candidates = findItemStacks(bot, requirement.item);
    const best = candidates
      .map((candidate) => ({
        ...candidate,
        missing: requirement.enchants.filter((enchant) => enchantLevel(candidate.stack, enchant.id) < enchant.level),
      }))
      .sort((a, b) => a.missing.length - b.missing.length)[0];
    if (!best) {
      const label = `${requirement.item}`;
      if (requirement.optional) optionalMissing.push(label);
      else missingItems.push(label);
      items.push({
        item: requirement.item,
        ok: false,
        found: false,
        missingEnchants: requirement.enchants,
        location: "missing",
      });
      continue;
    }
    const ok = best.missing.length === 0;
    if (!ok) {
      if (requirement.optional) optionalMissing.push(requirement.item);
      else {
        missingItems.push(requirement.item);
        for (const enchant of best.missing) missingEnchantments.push(`${requirement.item}: ${enchant.id} ${enchant.level}`);
      }
    }
    items.push({
      item: requirement.item,
      ok: ok || requirement.optional,
      found: true,
      missingEnchants: best.missing,
      location: best.location,
      stack: best.stack,
    });
  }
  const required = items.filter((status) => {
    const requirement = checklist.find((entry) => entry.item === status.item);
    return !requirement?.optional;
  });
  return {
    verified: required.every((status) => status.ok),
    items,
    missingItems,
    missingEnchantments,
    optionalMissing,
  };
}

/** Enchantments still missing from the required gear, one entry per book to apply. */
export function remainingEnchantNeeds(bot: BotState, checklist: GearRequirement[]): EnchantNeed[] {
  const needs: EnchantNeed[] = [];
  for (const requirement of checklist) {
    if (requirement.optional) continue;
    const candidates = findItemStacks(bot, requirement.item);
    if (candidates.length === 0) {
      for (const enchant of requirement.enchants) needs.push({ item: requirement.item, enchant });
      continue;
    }
    // Use the candidate that already has the most required enchantments.
    const best = candidates
      .map((candidate) => ({
        stack: candidate.stack,
        missing: requirement.enchants.filter((enchant) => enchantLevel(candidate.stack, enchant.id) < enchant.level),
      }))
      .sort((a, b) => a.missing.length - b.missing.length)[0]!;
    for (const enchant of best.missing) needs.push({ item: requirement.item, enchant });
  }
  return needs;
}

export function requiredBookCounts(checklist: GearRequirement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const requirement of checklist) {
    if (requirement.optional) continue;
    for (const enchant of requirement.enchants) {
      counts.set(enchant.id, (counts.get(enchant.id) ?? 0) + 1);
    }
  }
  return counts;
}

export function equipSlotFor(item: string): "head" | "chest" | "legs" | "feet" | "mainhand" {
  if (/helmet|cap|skull/.test(item)) return "head";
  if (/chestplate|tunic/.test(item)) return "chest";
  if (/leggings|pants/.test(item)) return "legs";
  if (/boots/.test(item)) return "feet";
  return "mainhand";
}

export function gearLabel(verification: GearVerification): string {
  const done = verification.items.filter((item) => item.ok).length;
  return `${done}/${verification.items.length} checkpoint items verified`;
}
