// Opt-in, local PII rules adapted from Presidio's pattern recognizers, ported
// from codemap-search `src/redact/pii/mod.rs`. See NOTICE for attribution.
import type { Detection } from "../detection.js";
import { CATALOG_JSON, PII_ENTITY_NAMES } from "./data/catalog.js";
import { IBAN_FORMATS_JSON } from "./data/iban-formats.js";
import { VALIDATION_DATA_JSON } from "./data/validation-data.js";
import {
    type CompiledPiiRule,
    compilePiiRule,
    type PiiRuleDefinition,
} from "./patterns.js";
import { translateRustRegex } from "./regex.js";
import {
    createCandidateValidator,
    type ValidationData,
} from "./validators/index.js";

export interface PiiDetector {
    /**
     * Detect enabled entities in `text`. With `canUseLabels` false, patterns
     * that depend on a nearby label are skipped (context-free mode).
     */
    detect(text: string, canUseLabels: boolean): Detection[];
}

const supportedEntitySet: ReadonlySet<string> = new Set(PII_ENTITY_NAMES);

/** Entity names accepted in `piiEntities`; names are exact and case-sensitive. */
export function listSupportedPiiEntities(): readonly string[] {
    return PII_ENTITY_NAMES;
}

export function isSupportedPiiEntity(name: string): boolean {
    return supportedEntitySet.has(name);
}

/** `pii.` plus the entity name lowercased with `_` replaced by `-`. */
export function piiRuleId(entity: string): string {
    return `pii.${entity.toLowerCase().replaceAll("_", "-")}`;
}

function loadValidationData(): ValidationData {
    const formats = JSON.parse(IBAN_FORMATS_JSON) as Record<string, string>;
    return {
        // The source compiles `\A(?:format)` with default flags; sticky matching anchors it.
        ibanFormats: new Map(
            Object.entries(formats).map(([country, pattern]) => [
                country,
                new RegExp(translateRustRegex(pattern, false), "uy"),
            ]),
        ),
        asia: JSON.parse(VALIDATION_DATA_JSON),
    };
}

/** Compile the catalog rules for `entities`, in catalog order. */
export function compilePiiRules(
    entities: readonly string[],
): CompiledPiiRule[] {
    const enabled = new Set(entities);
    const validator = createCandidateValidator(loadValidationData());
    return (JSON.parse(CATALOG_JSON) as PiiRuleDefinition[])
        .filter((definition) => enabled.has(definition.entity))
        .map((definition) => compilePiiRule(definition, validator));
}

/** Returns undefined for an empty list so the default path never loads the catalog. */
export function createPiiDetector(
    entities: readonly string[],
): PiiDetector | undefined {
    if (entities.length === 0) return undefined;
    const rules = compilePiiRules(entities);
    return Object.freeze({
        detect: (text: string, canUseLabels: boolean) =>
            rules.flatMap((rule) =>
                rule.detect(text, canUseLabels).map(
                    ([start, end]): Detection => ({
                        start,
                        end,
                        ruleId: rule.id,
                        kind: "pii",
                    }),
                ),
            ),
    });
}
