/**
 * Per-role model choice - main process only.
 *
 * OmniRoute (behind Hermes) exposes a few named "combos" (an ordered list of models with fallback). The user picks one
 * combo for each of three slots in the settings: the assistant (planning / general answers), code, and research. The
 * request may only carry one of these fixed names (or nothing = the Hermes default); the main process never forwards
 * a free-form model string from the page. The local auth proxy adds the provider selector Hermes needs to honour it.
 */
export const ROUTED_MODELS = ["vyron-assistant", "vyron-code", "vyron-research"] as const;

export type RoutedModel = (typeof ROUTED_MODELS)[number];
export type ModelSlot = "assistant" | "code" | "research" | "tools";

/** One optional combo per slot; a missing slot means "the Hermes default". */
export interface ModelChoice {
  readonly assistant?: RoutedModel;
  readonly code?: RoutedModel;
  readonly research?: RoutedModel;
  /** Used for every role when the task runs with tools: the model has to follow the JSON tool protocol. */
  readonly tools?: RoutedModel;
}

export function isRoutedModel(value: unknown): value is RoutedModel {
  return typeof value === "string" && (ROUTED_MODELS as readonly string[]).indexOf(value) >= 0;
}

/** Strict parse: exactly an object whose keys are slot names and whose values are allowlisted combos; anything else = null. */
export function parseModelChoice(value: unknown): ModelChoice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const slots = ["assistant", "code", "research", "tools"];
  const choice: { assistant?: RoutedModel; code?: RoutedModel; research?: RoutedModel; tools?: RoutedModel } = {};
  for (const key of Object.keys(value)) {
    if (slots.indexOf(key) < 0) return null;
    const entry = (value as Record<string, unknown>)[key];
    if (!isRoutedModel(entry)) return null;
    choice[key as ModelSlot] = entry;
  }
  return choice;
}

/** The slot a Ruflo role belongs to (no role = the plain assistant). */
export function slotForRole(role: string | null): ModelSlot {
  switch (role) {
    case "coder":
    case "reviewer":
    case "tester":
    case "system-architect":
    case "security-auditor":
      return "code";
    case "researcher":
      return "research";
    default:
      return "assistant";
  }
}

export function modelForRole(choice: ModelChoice | undefined, role: string | null): RoutedModel | undefined {
  return choice ? choice[slotForRole(role)] : undefined;
}

/**
 * A task that runs with tools must be answered by a model that follows the JSON tool protocol. Measured: the ChatGPT-first
 * assistant combo refuses ("no tool bridge") in most first replies, the code combo follows it. So with tools every role uses
 * the `tools` slot; without a `tools` choice the per-role choice stays as it is.
 */
export function withToolsRouting(choice: ModelChoice | null, tools: boolean): ModelChoice | undefined {
  if (!choice) return undefined;
  if (!tools || choice.tools === undefined) return choice;
  return { assistant: choice.tools, code: choice.tools, research: choice.tools, tools: choice.tools };
}
