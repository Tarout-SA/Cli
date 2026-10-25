/**
 * The AI services catalog as the CLI and the MCP tools read it
 * (`aiGateway.getServiceCatalog`): every model of every kind with its
 * residency, customer price and limits, plus which service families are open
 * in which region for the caller.
 *
 * The CLI never hard-codes a model id. Commands that call a model take
 * `--model` or pick the first callable model of the kind in the requested
 * region (`pickModel`), so the catalog alone decides what runs.
 */
import { CliError, InvalidArgumentError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** Local runs in Saudi Arabia; Global runs outside it. */
export const AI_REGIONS = ["local", "global"] as const;
export type AiRegion = (typeof AI_REGIONS)[number];

export const AI_MODEL_KINDS = [
	"chat",
	"embedding",
	"rerank",
	"moderation",
	"transcription",
	"speech",
	"image",
	"video",
] as const;
export type AiModelKind = (typeof AI_MODEL_KINDS)[number];

/** One unit price in USD, markup included; null = not priced (not callable). */
export type AiUnitPricing =
	| {
			unit: "tokens";
			inputPer1M: number | null;
			outputPer1M: number | null;
			cachedInputPer1M?: number | null;
	  }
	| { unit: "input_tokens"; inputPer1M: number | null }
	| { unit: "searches"; per1K: number | null }
	| { unit: "audio_minutes"; perMinute: number | null }
	| { unit: "characters"; per1M: number | null }
	| { unit: "images"; perImage: Record<string, number | null> }
	| { unit: "video_seconds"; perSecond: Record<string, number | null> };

/** `usage`: the supplier-reported cost times the markup, never above `ceiling`. */
export type AiCustomerPricing = AiUnitPricing | { unit: "usage"; ceiling: AiUnitPricing };

export type AiModelLimits =
	| { kind: "chat"; contextWindow: number; maxOutputTokens?: number }
	| {
			kind: "embedding";
			dimensions: number | null;
			maxInputTokens: number | null;
			supportsDimensions: boolean;
	  }
	| { kind: "rerank"; maxDocuments: number | null; maxTokensPerDocument: number | null }
	| { kind: "moderation"; categories: string[]; maxInputTokens: number | null }
	| {
			kind: "transcription";
			maxFileBytes: number;
			inputFormats: string[];
			responseFormats: string[];
	  }
	| { kind: "speech"; maxInputChars: number; voices: string[]; outputFormats: string[] }
	| { kind: "image"; sizes: string[]; maxImages: number; outputFormat: string }
	| { kind: "video"; resolutions: string[]; durationsSeconds: number[] };

export interface AiCatalogModel {
	id: string;
	alias: string | null;
	name: string;
	lab: string | null;
	description: string;
	kind: AiModelKind;
	residency: AiRegion;
	route: string;
	providerStatus: "available" | "unavailable";
	unavailableReason?: string;
	pricing: AiCustomerPricing;
	limits: AiModelLimits;
	capabilities: Record<string, boolean>;
	highlight?: string;
}

export interface AiServiceCatalogFamily {
	family: string;
	enabled: { local: boolean; global: boolean };
}

export interface AiServiceCatalog {
	families: AiServiceCatalogFamily[];
	models: AiCatalogModel[];
}

/** The billing family that serves each model kind. */
const FAMILY_BY_KIND: Record<AiModelKind, string> = {
	chat: "chat",
	embedding: "embeddings",
	rerank: "rerank",
	moderation: "moderation",
	transcription: "transcription",
	speech: "speech",
	image: "images",
	video: "video",
};

const KIND_LABELS: Record<AiModelKind, string> = {
	chat: "Chat",
	embedding: "Embeddings",
	rerank: "Rerank",
	moderation: "Moderation",
	transcription: "Speech to text",
	speech: "Text to speech",
	image: "Image generation",
	video: "Video generation",
};

/** Customer names of the service families, for status and wallet lines. */
export const AI_FAMILY_LABELS: Record<string, string> = {
	chat: "Chat",
	ocr: "OCR",
	embeddings: "Embeddings",
	rerank: "Rerank",
	moderation: "Moderation",
	transcription: "Speech to text",
	speech: "Text to speech",
	images: "Images",
	video: "Video",
	file_search: "File search",
};

export function familyForKind(kind: AiModelKind): string {
	return FAMILY_BY_KIND[kind];
}

export function kindLabel(kind: AiModelKind): string {
	return KIND_LABELS[kind];
}

export function regionLabel(region: string | null | undefined): "Local" | "Global" {
	return region === "local" ? "Local" : "Global";
}

/** `local` or `global` (case and spaces ignored), else INVALID_ARGUMENTS. */
export function parseAiRegion(value: unknown, flag = "--region"): AiRegion {
	const region = String(value ?? "local").trim().toLowerCase();
	if ((AI_REGIONS as readonly string[]).includes(region)) return region as AiRegion;
	throw new InvalidArgumentError(
		`Unknown ${flag} "${value}". Use local (in Saudi Arabia) or global (outside Saudi Arabia).`,
	);
}

export function parseAiKind(value: unknown): AiModelKind {
	const kind = String(value ?? "").trim().toLowerCase();
	if ((AI_MODEL_KINDS as readonly string[]).includes(kind)) return kind as AiModelKind;
	throw new InvalidArgumentError(
		`Unknown --kind "${value}". Use one of: ${AI_MODEL_KINDS.join(", ")}.`,
	);
}

export async function fetchServiceCatalog(client: TrpcClient): Promise<AiServiceCatalog> {
	const catalog = (await client.aiGateway.getServiceCatalog.query()) as
		| Partial<AiServiceCatalog>
		| null
		| undefined;
	return {
		families: Array.isArray(catalog?.families) ? catalog.families : [],
		models: Array.isArray(catalog?.models) ? catalog.models : [],
	};
}

function unitPriced(unit: AiUnitPricing): boolean {
	switch (unit.unit) {
		case "tokens":
			return unit.inputPer1M != null && unit.outputPer1M != null;
		case "input_tokens":
			return unit.inputPer1M != null;
		case "searches":
			return unit.per1K != null;
		case "audio_minutes":
			return unit.perMinute != null;
		case "characters":
			return unit.per1M != null;
		case "images": {
			const prices = Object.values(unit.perImage ?? {});
			return prices.length > 0 && prices.every((price) => price != null);
		}
		case "video_seconds": {
			const prices = Object.values(unit.perSecond ?? {});
			return prices.length > 0 && prices.every((price) => price != null);
		}
		default:
			return false;
	}
}

/** Every amount of the price is set; an unpriced model cannot be called. */
export function isPriced(pricing: AiCustomerPricing | null | undefined): boolean {
	if (!pricing) return false;
	return unitPriced(pricing.unit === "usage" ? pricing.ceiling : pricing);
}

export function isFamilyOpen(
	catalog: AiServiceCatalog,
	family: string,
	region: AiRegion,
): boolean {
	return catalog.families.find((item) => item.family === family)?.enabled?.[region] === true;
}

/** Available, priced, and its family open in its region for this caller. */
export function isCallableModel(model: AiCatalogModel, catalog: AiServiceCatalog): boolean {
	return (
		model.providerStatus === "available" &&
		isPriced(model.pricing) &&
		isFamilyOpen(catalog, familyForKind(model.kind), model.residency)
	);
}

export function findCatalogModel(
	catalog: AiServiceCatalog,
	idOrAlias: string,
): AiCatalogModel | null {
	return (
		catalog.models.find((model) => model.id === idOrAlias || model.alias === idOrAlias) ??
		null
	);
}

export interface PickedModel {
	/** The id to send as `model`. */
	id: string;
	/** Its catalog entry (limits, residency), or null when the catalog does not list it. */
	model: AiCatalogModel | null;
}

/**
 * The model a command calls: `explicit` as given (the server checks it), or
 * the first callable model of `kind` in `region`. The catalog entry comes
 * back too, so callers can read limits such as the voices of a speech model.
 */
export async function pickModel(
	client: TrpcClient,
	kind: AiModelKind,
	region: AiRegion,
	explicit?: string | null,
): Promise<PickedModel> {
	const requested = explicit?.trim();
	if (requested) {
		const catalog = await fetchServiceCatalog(client).catch(() => null);
		return { id: requested, model: catalog ? findCatalogModel(catalog, requested) : null };
	}
	const catalog = await fetchServiceCatalog(client);
	const callable = catalog.models.filter(
		(model) => model.kind === kind && isCallableModel(model, catalog),
	);
	const match = callable.find((model) => model.residency === region);
	if (match) return { id: match.id, model: match };

	const other: AiRegion = region === "local" ? "global" : "local";
	const label = kindLabel(kind);
	const hint = callable.some((model) => model.residency === other)
		? ` Try --region ${other} (${other === "local" ? "in" : "outside"} Saudi Arabia).`
		: " See `tarout ai status` for what is open on this account.";
	throw new CliError(
		`${label} is not available in the ${regionLabel(region)} region right now.${hint}`,
		undefined,
		undefined,
		{ kind, region },
	);
}

/** USD with two decimals, or as many as a small price needs (up to 8). */
export function formatUsd(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "-";
	if (value === 0 || value >= 0.01) return `$${value.toFixed(2)}`;
	const decimals = Math.min(8, Math.ceil(-Math.log10(value)) + 2);
	return `$${value.toFixed(decimals).replace(/0+$/, "")}`;
}

function rangeOf(prices: Record<string, number | null>): string | null {
	const values = Object.values(prices ?? {});
	if (values.length === 0 || values.some((price) => price == null)) return null;
	const numbers = values as number[];
	const low = Math.min(...numbers);
	return low === Math.max(...numbers) ? formatUsd(low) : `from ${formatUsd(low)}`;
}

function formatUnitPricing(unit: AiUnitPricing): string {
	switch (unit.unit) {
		case "tokens":
			return unit.inputPer1M == null || unit.outputPer1M == null
				? "-"
				: `${formatUsd(unit.inputPer1M)} in / ${formatUsd(unit.outputPer1M)} out per 1M tokens`;
		case "input_tokens":
			return unit.inputPer1M == null ? "-" : `${formatUsd(unit.inputPer1M)} per 1M tokens`;
		case "searches":
			return unit.per1K == null ? "-" : `${formatUsd(unit.per1K)} per 1K searches`;
		case "audio_minutes":
			return unit.perMinute == null ? "-" : `${formatUsd(unit.perMinute)} per audio minute`;
		case "characters":
			return unit.per1M == null ? "-" : `${formatUsd(unit.per1M)} per 1M characters`;
		case "images": {
			const range = rangeOf(unit.perImage);
			return range ? `${range} per image` : "-";
		}
		case "video_seconds": {
			const range = rangeOf(unit.perSecond);
			return range ? `${range} per video second` : "-";
		}
		default:
			return "-";
	}
}

/** The customer price of a model in one line, units included; "-" when unpriced. */
export function formatPricing(pricing: AiCustomerPricing | null | undefined): string {
	if (!pricing) return "-";
	if (pricing.unit === "usage") {
		const ceiling = formatUnitPricing(pricing.ceiling);
		return ceiling === "-" ? "-" : `up to ${ceiling}`;
	}
	return formatUnitPricing(pricing);
}
