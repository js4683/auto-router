import { passesContextFit } from "./guards.js";
import type {
  Catalog,
  EligibilityFailureCode,
  ModelEligibility,
  ModelEntry,
  RouterConfig,
  RoutingCapability,
  SelectionRequirements,
} from "./types.js";

export class SelectionConstraintError extends Error {
  readonly code: EligibilityFailureCode;

  constructor(code: EligibilityFailureCode, message: string) {
    super(message);
    this.name = "SelectionConstraintError";
    this.code = code;
  }
}

function missingCapability(model: ModelEntry, requirements: SelectionRequirements): RoutingCapability | undefined {
  const capabilities = model.capabilities ?? ["text"];
  return requirements.requiredCapabilities.find((capability) => !capabilities.includes(capability));
}

export function checkModelEligibility(
  model: ModelEntry,
  requirements: SelectionRequirements,
  config: RouterConfig,
): ModelEligibility {
  const context = passesContextFit(requirements.lifetimeTokens, model, config);
  if (!context.pass) return { pass: false, code: "context-overflow", reason: context.reason };

  const missing = missingCapability(model, requirements);
  if (missing) return { pass: false, code: "missing-capability", reason: `${model.id} lacks ${missing}` };

  if (!model.transports?.includes(requirements.transport)) {
    return {
      pass: false,
      code: "unsupported-transport",
      reason: `${model.id} does not support ${requirements.transport}`,
    };
  }

  return { pass: true, reason: `${model.id} satisfies context, capability, and transport requirements` };
}

export function filterEligibleModels(
  catalog: Catalog,
  requirements: SelectionRequirements,
  config: RouterConfig,
): ModelEntry[] {
  return catalog.models.filter((model) => checkModelEligibility(model, requirements, config).pass);
}
