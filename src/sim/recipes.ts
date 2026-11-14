import type { ItemStack } from "../protocol/types.js";
import { ns } from "../util/items.js";

export interface RecipeIngredient {
  item: string;
  count: number;
}

export interface Recipe {
  output: { item: string; count: number };
  inputs: RecipeIngredient[];
}

/** Direct recipes only; multi-step crafting is left to the task layer. */
export const RECIPES: Record<string, Recipe> = {
  "minecraft:oak_planks": { output: { item: "minecraft:oak_planks", count: 4 }, inputs: [{ item: "minecraft:oak_log", count: 1 }] },
  "minecraft:stick": { output: { item: "minecraft:stick", count: 4 }, inputs: [{ item: "minecraft:oak_planks", count: 2 }] },
  "minecraft:crafting_table": {
    output: { item: "minecraft:crafting_table", count: 1 },
    inputs: [{ item: "minecraft:oak_planks", count: 4 }],
  },
  "minecraft:bread": { output: { item: "minecraft:bread", count: 1 }, inputs: [{ item: "minecraft:wheat", count: 3 }] },
  "minecraft:paper": { output: { item: "minecraft:paper", count: 3 }, inputs: [{ item: "minecraft:sugar_cane", count: 1 }] },
  "minecraft:book": {
    output: { item: "minecraft:book", count: 1 },
    inputs: [
      { item: "minecraft:paper", count: 3 },
      { item: "minecraft:leather", count: 1 },
    ],
  },
  "minecraft:bed": {
    output: { item: "minecraft:red_bed", count: 1 },
    inputs: [
      { item: "minecraft:oak_planks", count: 3 },
      { item: "minecraft:white_wool", count: 3 },
    ],
  },
  "minecraft:torch": {
    output: { item: "minecraft:torch", count: 4 },
    inputs: [
      { item: "minecraft:stick", count: 1 },
      { item: "minecraft:coal", count: 1 },
    ],
  },
};

export function recipeFor(item: string): Recipe | undefined {
  return RECIPES[ns(item)];
}

export function craftBatches(recipe: Recipe, requested: number): number {
  return Math.max(1, Math.ceil(requested / recipe.output.count));
}

export function recipeOutputStack(recipe: Recipe, batches: number): ItemStack {
  return { item: recipe.output.item, count: recipe.output.count * batches };
}
