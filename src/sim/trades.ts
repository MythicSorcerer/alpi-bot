import type { Enchantment, TradeOffer, Vec3, Villager } from "../protocol/types.js";
import { Rng, stringSeed } from "./rng.js";

export interface SimVillager extends Villager {
  trades: TradeOffer[];
  rerolls: number;
  restockAt: number;
  growAt?: number;
}

const ENCHANT_POOL: Enchantment[] = [
  { id: "minecraft:protection", level: 4 },
  { id: "minecraft:unbreaking", level: 3 },
  { id: "minecraft:mending", level: 1 },
  { id: "minecraft:feather_falling", level: 4 },
  { id: "minecraft:efficiency", level: 5 },
  { id: "minecraft:sharpness", level: 5 },
  { id: "minecraft:fortune", level: 3 },
  { id: "minecraft:depth_strider", level: 3 },
];

export const VILLAGER_LEVEL_XP = [0, 10, 30, 70, 150];

export function villagerLevel(xp: number): number {
  let level = 1;
  for (let i = 1; i < VILLAGER_LEVEL_XP.length; i += 1) {
    if (xp >= VILLAGER_LEVEL_XP[i]!) level = i + 1;
  }
  return level;
}

function offer(
  index: number,
  input: { item: string; count: number },
  output: { item: string; count: number; enchants?: Enchantment[] },
  maxUses: number,
  rewardXp: number,
): TradeOffer {
  return {
    index,
    inputs: [{ item: input.item, count: input.count }],
    output: { item: output.item, count: output.count, ...(output.enchants ? { enchants: output.enchants } : {}) },
    maxUses,
    uses: 0,
    rewardXp,
    minLevel: 1,
  };
}

function librarianEnchantOffers(id: string, rerolls: number): TradeOffer[] {
  const rng = new Rng((stringSeed(id) ^ Math.imul(rerolls + 1, 2654435761)) >>> 0);
  const selected = rng.shuffle(ENCHANT_POOL).slice(0, 3);
  return selected.map((enchant, offset) =>
    offer(
      offset + 1,
      { item: "minecraft:emerald", count: 6 },
      { item: "minecraft:enchanted_book", count: 1, enchants: [enchant] },
      4,
      5,
    ),
  );
}

function baseOffers(profession: string, id: string, rerolls: number): TradeOffer[] {
  switch (profession) {
    case "farmer":
      return [
        offer(0, { item: "minecraft:wheat", count: 20 }, { item: "minecraft:emerald", count: 1 }, 16, 2),
        offer(1, { item: "minecraft:emerald", count: 1 }, { item: "minecraft:bread", count: 6 }, 16, 1),
      ];
    case "fletcher":
      return [
        offer(0, { item: "minecraft:stick", count: 32 }, { item: "minecraft:emerald", count: 1 }, 12, 3),
        offer(1, { item: "minecraft:emerald", count: 1 }, { item: "minecraft:arrow", count: 8 }, 12, 1),
      ];
    case "armorer":
      return [
        offer(0, { item: "minecraft:emerald", count: 12 }, { item: "minecraft:diamond_helmet", count: 1 }, 3, 5),
        offer(1, { item: "minecraft:emerald", count: 20 }, { item: "minecraft:diamond_chestplate", count: 1 }, 3, 5),
        offer(2, { item: "minecraft:emerald", count: 16 }, { item: "minecraft:diamond_leggings", count: 1 }, 3, 5),
        offer(3, { item: "minecraft:emerald", count: 10 }, { item: "minecraft:diamond_boots", count: 1 }, 3, 5),
      ];
    case "toolsmith":
      return [
        offer(0, { item: "minecraft:emerald", count: 20 }, { item: "minecraft:diamond_pickaxe", count: 1 }, 3, 5),
        offer(1, { item: "minecraft:emerald", count: 18 }, { item: "minecraft:diamond_axe", count: 1 }, 3, 5),
      ];
    case "weaponsmith":
      return [offer(0, { item: "minecraft:emerald", count: 18 }, { item: "minecraft:diamond_sword", count: 1 }, 3, 5)];
    case "librarian":
      return [
        offer(0, { item: "minecraft:emerald", count: 1 }, { item: "minecraft:book", count: 3 }, 16, 2),
        ...librarianEnchantOffers(id, rerolls),
      ];
    default:
      return [];
  }
}

export function makeVillager(
  id: string,
  profession: string,
  position: Vec3,
  restockAt: number,
  rerolls = 0,
  baby = false,
): SimVillager {
  return {
    id,
    profession,
    level: 1,
    xp: 0,
    position,
    tradesKnown: false,
    trades: baseOffers(profession, id, rerolls),
    sleeping: false,
    baby,
    workstation: null,
    restockAt,
    rerolls,
  };
}

export function rerollVillager(villager: SimVillager): void {
  villager.rerolls += 1;
  const base = baseOffers(villager.profession, villager.id, villager.rerolls);
  villager.trades = base;
}

export function restockVillager(villager: SimVillager, restockAt: number): void {
  villager.restockAt = restockAt;
  villager.trades = villager.trades.map((trade) => ({ ...trade, uses: 0 }));
}

export function grantVillagerXp(villager: SimVillager, xp: number): boolean {
  const before = villager.level;
  villager.xp = (villager.xp ?? 0) + xp;
  villager.level = villagerLevel(villager.xp);
  if (villager.level > before) {
    // Re-unlock any level-gated offers.
    villager.trades = villager.trades.map((trade) => ({
      ...trade,
      minLevel: Math.min(trade.minLevel, villager.level),
    }));
    return true;
  }
  return false;
}

export function knownVillager(villager: SimVillager): Villager {
  return {
    ...villager,
    tradesKnown: true,
    trades: villager.trades,
  };
}
