/**
 * Read-only usage knowledge for the model context.
 *
 * This module deliberately owns no state and has no side effects beyond asking
 * the host for its cached, normalized provider-usage reports. It never reads
 * credentials, account identities, usage history, or raw provider payloads.
 */
import type { ContextUsage, ExtensionContext, UsageStatistics } from "@oh-my-pi/pi-coding-agent";
import type { UsageAmount, UsageLimit, UsageReport, UsageUnit } from "@oh-my-pi/pi-ai";

/** Host quota reports are cached for five minutes; older snapshots cannot claim current allowance. */
const REPORT_MAX_AGE_MS = 5 * 60_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_LABEL_LENGTH = 80;
const NEAR_LIMIT_FRACTION = 0.25;
const TIGHT_LIMIT_FRACTION = 0.1;

const amountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

interface RemainingAllowance {
	fraction?: number;
	amount?: number;
	limit?: number;
	overLimit: boolean;
	invalidLimit: boolean;
}

interface ContextKnowledge {
	line: string;
	remainingFraction?: number;
	headroomTokens?: number;
}

interface SessionKnowledge {
	line: string;
}

interface SnapshotFreshness {
	stale: boolean;
	description: string;
}

interface UsagePressure {
	source: "context" | "provider";
	fraction: number;
	label: string;
	resetsAt?: number;
	exhausted: boolean;
	headroomTokens?: number;
}

interface SnapshotKnowledge {
	line: string;
	candidates: UsagePressure[];
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
	return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
	return isFiniteNumber(value) && value > 0 && value <= MAX_TIMESTAMP_MS ? value : undefined;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Keep provider-authored text from introducing line breaks or unbounded payloads. */
function cleanText(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 3)}...` : cleaned;
}

function formatNumber(value: number): string {
	return amountFormat.format(value);
}

function formatPercentValue(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatPercent(fraction: number): string {
	if (fraction >= 1) return "100%";
	if (fraction <= 0) return "0%";
	const percent = fraction * 100;
	if (percent < 0.1) return "<0.1%";
	const rounded = Math.round(percent * 10) / 10;
	if (rounded >= 100) return "99.9%";
	return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function formatUsd(value: number): string {
	return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(6)}`;
}

function formatQuantity(value: number, unit: UsageUnit | undefined): { value: string; unit: string } {
	switch (unit) {
		case "percent":
			return { value: formatPercentValue(value), unit: "" };
		case "usd":
			return { value: `${value < 0 ? "-" : ""}$${formatNumber(Math.abs(value))}`, unit: "" };
		case "tokens":
			return { value: formatNumber(value), unit: "tokens" };
		case "requests":
			return { value: formatNumber(value), unit: "requests" };
		case "credits":
			return { value: formatNumber(value), unit: "credits" };
		case "minutes":
			return { value: formatNumber(value), unit: "minutes" };
		case "bytes":
			return { value: formatNumber(value), unit: "bytes" };
		default:
			return { value: formatNumber(value), unit: "units (unit type unknown)" };
	}
}

/**
 * Resolve remaining allowance from whichever fields the host populated.
 * Precedence follows the host usage UI: explicit remaining fraction, explicit
 * used fraction, remaining/limit, used/limit, then percent-unit used. Only
 * observed values are used; missing data stays missing.
 */
function resolveRemaining(amount: UsageAmount | undefined): RemainingAllowance {
	if (!amount) return { overLimit: false, invalidLimit: false };
	const rawLimit = amount.limit;
	const invalidLimit = rawLimit !== undefined && (!isFiniteNumber(rawLimit) || rawLimit <= 0);
	const limit = !invalidLimit && isFiniteNumber(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
	const remaining = nonNegativeNumber(amount.remaining);
	const used = nonNegativeNumber(amount.used);
	const remainingFraction = isFiniteNumber(amount.remainingFraction) ? amount.remainingFraction : undefined;
	const usedFraction = isFiniteNumber(amount.usedFraction) ? amount.usedFraction : undefined;

	let fraction: number | undefined;
	if (!invalidLimit) {
		if (remainingFraction !== undefined) fraction = clamp01(remainingFraction);
		else if (usedFraction !== undefined) fraction = clamp01(1 - usedFraction);
		else if (remaining !== undefined && limit !== undefined) fraction = clamp01(remaining / limit);
		else if (used !== undefined && limit !== undefined) fraction = clamp01(1 - used / limit);
		else if (amount.unit === "percent" && used !== undefined) fraction = clamp01(1 - used / 100);
		else if (amount.unit === "percent" && remaining !== undefined) fraction = clamp01(remaining / 100);
		else if (remaining === 0) fraction = 0;
	}

	const overLimit =
		!invalidLimit &&
		((usedFraction !== undefined && usedFraction > 1) ||
			(used !== undefined && limit !== undefined && used > limit));

	let remainingAmount = invalidLimit ? undefined : remaining;
	if (remainingAmount === undefined && fraction !== undefined && limit !== undefined) {
		remainingAmount = fraction * limit;
	}
	if (remainingAmount !== undefined && limit !== undefined) {
		remainingAmount = Math.min(remainingAmount, limit);
	}
	if (overLimit) {
		fraction = 0;
		if (limit !== undefined) remainingAmount = 0;
	}

	return { fraction, amount: remainingAmount, limit, overLimit, invalidLimit };
}

function describeRemaining(
	remaining: RemainingAllowance,
	unit: UsageUnit | undefined,
	status: unknown,
): string {
	if (remaining.invalidLimit) return "invalid reported limit; remaining unknown";
	if (remaining.fraction === undefined && remaining.amount === undefined) {
		switch (status) {
			case "exhausted":
				return "provider status exhausted; remaining amount unknown";
			case "warning":
				return "provider status warning; remaining amount unknown";
			case "unknown":
				return "provider status unknown; remaining amount unknown";
			default:
				return "remaining amount unknown";
		}
	}

	let percentText: string | undefined;
	let absoluteText: string | undefined;
	if (remaining.fraction !== undefined) percentText = `${formatPercent(remaining.fraction)} left`;
	if (remaining.amount !== undefined && unit !== "percent") {
		const remainingQuantity = formatQuantity(remaining.amount, unit);
		if (remaining.limit !== undefined) {
			const limitQuantity = formatQuantity(remaining.limit, unit);
			const unitSuffix = limitQuantity.unit ? ` ${limitQuantity.unit}` : "";
			absoluteText = `${remainingQuantity.value} of ${limitQuantity.value}${unitSuffix} left`;
		} else {
			const unitSuffix = remainingQuantity.unit ? ` ${remainingQuantity.unit}` : "";
			absoluteText = `${remainingQuantity.value}${unitSuffix} left`;
		}
	}

	let text: string;
	if (percentText && absoluteText) text = `${percentText} (${absoluteText})`;
	else if (percentText) text = `${percentText} (absolute amount not reported)`;
	else if (absoluteText) text = `${absoluteText} (fraction not reported)`;
	else text = "remaining amount unknown";
	if (remaining.overLimit) text += " — over limit";
	return text;
}

function limitTitle(limit: UsageLimit): string {
	const label = cleanText(limit.label, cleanText(limit.id, "limit"));
	const windowLabel = cleanText(
		limit.window?.label,
		cleanText(limit.scope?.windowId, limit.window ? cleanText(limit.window.id, "") : ""),
	);
	if (windowLabel && !label.toLowerCase().includes(windowLabel.toLowerCase())) {
		return `${label} (${windowLabel})`;
	}
	return label;
}

function describeReset(limit: UsageLimit, now: number): string {
	const resetsAt = timestampValue(limit.window?.resetsAt);
	if (resetsAt === undefined) return "reset time not reported";
	const iso = new Date(resetsAt).toISOString();
	const resetLabel = cleanText(limit.window?.resetLabel, "resets");
	if (resetsAt > now) return `${resetLabel} in ${formatDuration(resetsAt - now)} (${iso})`;
	if (resetsAt === now) return `resets now (${iso})`;
	return `reset ${formatDuration(now - resetsAt)} ago (${iso})`;
}

function describePastReset(resetsAt: number, now: number): string {
	const iso = new Date(resetsAt).toISOString();
	return resetsAt === now ? `window reset at ${iso} (now)` : `window reset ${formatDuration(now - resetsAt)} ago (${iso})`;
}

function describeRecordedReset(limit: UsageLimit, now: number): string {
	const resetsAt = timestampValue(limit.window?.resetsAt);
	if (resetsAt === undefined) return "recorded reset time not reported";
	const iso = new Date(resetsAt).toISOString();
	if (resetsAt > now) return `recorded reset at ${iso} (in ${formatDuration(resetsAt - now)})`;
	if (resetsAt === now) return `recorded reset at ${iso} (now)`;
	return `recorded reset at ${iso} (${formatDuration(now - resetsAt)} ago)`;
}

function assessFreshness(report: UsageReport, now: number): SnapshotFreshness {
	const fetchedAt = timestampValue(report.fetchedAt);
	if (fetchedAt === undefined) return { stale: true, description: "report time missing" };
	if (fetchedAt > now) return { stale: true, description: "report timestamp is in the future" };
	const ageMs = Math.max(0, now - fetchedAt);
	const ageText = ageMs < 5_000 ? "just now" : `${formatDuration(ageMs)} old`;
	if (ageMs > REPORT_MAX_AGE_MS) return { stale: true, description: `report ${ageText}, stale` };
	return { stale: false, description: `report ${ageText}` };
}

function limitMatchesModel(limit: UsageLimit, provider: string, modelId: string): boolean {
	const scope = limit.scope;
	if (!scope || typeof scope !== "object") return true;
	if (scope.shared === true) return true;
	const scopedModel = typeof scope.modelId === "string" ? scope.modelId.trim() : "";
	if (!scopedModel) return true;
	if (!modelId) return false;
	return scopedModel === modelId || scopedModel === `${provider}/${modelId}`;
}

function describeSnapshot(
	report: UsageReport,
	index: number,
	total: number,
	provider: string,
	modelId: string,
	now: number,
): SnapshotKnowledge {
	const freshness = assessFreshness(report, now);
	const allLimits = Array.isArray(report.limits) ? report.limits : [];
	const limits: UsageLimit[] = [];
	let omitted = 0;
	for (const limit of allLimits) {
		if (limitMatchesModel(limit, provider, modelId)) limits.push(limit);
		else omitted += 1;
	}
	const omittedSuffix =
		omitted > 0 ? ` | ${formatNumber(omitted)} other-model limit${omitted === 1 ? "" : "s"} omitted` : "";

	if (freshness.stale) {
		const parts = limits.map(limit => `${limitTitle(limit)} — ${describeRecordedReset(limit, now)}`);
		const body =
			parts.length > 0
				? parts.join(" | ")
				: allLimits.length === 0
					? "no limit windows reported"
					: "no limits for the current model";
		return {
			line: `- account snapshot ${formatNumber(index)} of ${formatNumber(total)} (${freshness.description}; current allowance unknown; not used for advice): ${body}${omittedSuffix}`,
			candidates: [],
		};
	}

	const candidates: UsagePressure[] = [];
	const parts: string[] = [];
	for (const limit of limits) {
		const resetsAt = timestampValue(limit.window?.resetsAt);
		if (resetsAt !== undefined && resetsAt <= now) {
			parts.push(`${limitTitle(limit)} — current allowance unknown: ${describePastReset(resetsAt, now)}`);
			continue;
		}

		const remaining = resolveRemaining(limit.amount);
		const dataKnown = remaining.fraction !== undefined || remaining.amount !== undefined;
		if (limit.status === "unknown") {
			const text = dataKnown
				? `recorded ${describeRemaining(remaining, limit.amount?.unit, limit.status)}; provider status unknown, current usability unknown, not used for advice`
				: `${describeRemaining(remaining, limit.amount?.unit, limit.status)}; not used for advice`;
			parts.push(`${limitTitle(limit)} — ${text}, ${describeReset(limit, now)}`);
			continue;
		}
		if (limit.status === "exhausted") {
			const text = dataKnown
				? `recorded ${describeRemaining(remaining, limit.amount?.unit, limit.status)}; provider status exhausted, not used as spendable headroom`
				: "provider status exhausted; remaining unknown";
			parts.push(`${limitTitle(limit)} — ${text}, ${describeReset(limit, now)}`);
			candidates.push({
				source: "provider",
				fraction: 0,
				label: limitTitle(limit),
				resetsAt,
				exhausted: true,
			});
			continue;
		}

		const amountText = describeRemaining(remaining, limit.amount?.unit, limit.status);
		const suffix = dataKnown && limit.status === "warning" ? "; provider status warning" : "";
		parts.push(`${limitTitle(limit)} — ${amountText}${suffix}, ${describeReset(limit, now)}`);

		if (remaining.fraction !== undefined) {
			candidates.push({
				source: "provider",
				fraction: remaining.fraction,
				label: limitTitle(limit),
				resetsAt,
				exhausted: remaining.fraction === 0,
			});
		}
	}

	let body: string;
	if (parts.length > 0) body = parts.join(" | ");
	else if (allLimits.length === 0) body = "no limit windows reported; current allowance unknown";
	else body = "no limits for the current model; current allowance unknown";

	return {
		line: `- account snapshot ${formatNumber(index)} of ${formatNumber(total)} (${freshness.description}): ${body}${omittedSuffix}`,
		candidates,
	};
}

function readContextKnowledge(ctx: ExtensionContext): ContextKnowledge {
	let usage: ContextUsage | undefined;
	try {
		usage = ctx.getContextUsage();
	} catch {
		return { line: "Context: unknown (host context usage unavailable)" };
	}
	if (!usage) return { line: "Context: unknown (host returned no context usage)" };

	const tokens = nonNegativeNumber(usage.tokens);
	const contextWindow = isFiniteNumber(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : undefined;
	const percent = nonNegativeNumber(usage.percent);

	if (tokens !== undefined && contextWindow !== undefined) {
		const usedPercent = (tokens / contextWindow) * 100;
		const headroomTokens = Math.max(0, contextWindow - tokens);
		const remainingFraction = clamp01(headroomTokens / contextWindow);
		const overWindow = usedPercent > 100;
		return {
			line: `Context: ${formatNumber(tokens)} / ${formatNumber(contextWindow)} tokens used (${formatPercentValue(usedPercent)}${overWindow ? ", over window" : ""}); ${formatNumber(headroomTokens)} tokens (${formatPercent(remainingFraction)}) headroom`,
			remainingFraction,
			headroomTokens,
		};
	}

	if (tokens !== undefined) {
		const percentText = percent !== undefined ? ` (${formatPercentValue(percent)})` : "";
		return {
			line: `Context: ${formatNumber(tokens)} tokens used${percentText}; context window and token headroom unknown`,
		};
	}

	if (percent !== undefined) {
		const remainingFraction = clamp01(1 - percent / 100);
		return {
			line: `Context: ${formatPercentValue(percent)} used (token counts not reported); ${formatPercent(remainingFraction)} headroom, token headroom unknown`,
			remainingFraction,
		};
	}

	return { line: "Context: unknown (host reported no token counts)" };
}

function readSessionKnowledge(ctx: ExtensionContext): SessionKnowledge {
	let raw: UsageStatistics | undefined;
	try {
		raw = ctx.sessionManager.getUsageStatistics();
	} catch {
		return { line: "Session: unknown (host statistics unavailable)" };
	}
	if (!raw) return { line: "Session: unknown (host returned no statistics)" };

	const input = nonNegativeNumber(raw.input);
	const output = nonNegativeNumber(raw.output);
	const cacheRead = nonNegativeNumber(raw.cacheRead);
	const cacheWrite = nonNegativeNumber(raw.cacheWrite);
	const totalTokens = nonNegativeNumber(raw.totalTokens);
	const premiumRequests = nonNegativeNumber(raw.premiumRequests);
	const cost = nonNegativeNumber(raw.cost);
	const subagentCost = nonNegativeNumber(raw.subagentCost);

	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined &&
		totalTokens === undefined &&
		cost === undefined
	) {
		return { line: "Session: unknown (no counters reported)" };
	}

	const parts: string[] = [];
	parts.push(totalTokens !== undefined ? `${formatNumber(totalTokens)} tokens total` : "total tokens unknown");
	parts.push(
		[
			`input ${input !== undefined ? formatNumber(input) : "unknown"}`,
			`output ${output !== undefined ? formatNumber(output) : "unknown"}`,
			`cache read ${cacheRead !== undefined ? formatNumber(cacheRead) : "unknown"}`,
			`cache write ${cacheWrite !== undefined ? formatNumber(cacheWrite) : "unknown"}`,
		].join("; "),
	);
	parts.push(
		cost !== undefined
			? `cost ${formatUsd(cost)}${subagentCost !== undefined && subagentCost > 0 ? ` (includes ${formatUsd(subagentCost)} subagent spend)` : ""}`
			: "cost unknown",
	);
	parts.push(
		premiumRequests !== undefined
			? `${formatNumber(premiumRequests)} premium request${premiumRequests === 1 ? "" : "s"}`
			: "premium requests unknown",
	);

	return { line: `Session: ${parts.join("; ")}` };
}

function pressureLabel(pressure: UsagePressure): string {
	return pressure.source === "context" ? "context" : `reported provider window "${pressure.label}"`;
}

function describePressureAdvice(pressure: UsagePressure, now: number, snapshotCount: number): string {
	const percent = formatPercent(pressure.fraction);
	if (pressure.source === "context") {
		if (pressure.fraction <= 0) {
			return "Context has no reported headroom; compact or start a fresh session before adding more, preserving user requirements and unresolved work first.";
		}
		if (pressure.fraction <= TIGHT_LIMIT_FRACTION) {
			const headroom =
				pressure.headroomTokens !== undefined ? ` (${formatNumber(pressure.headroomTokens)} tokens)` : "";
			return `Context headroom is ${percent}${headroom}; compact or start a fresh session before adding large content, preserving user requirements and unresolved work first.`;
		}
		return `Context headroom is ${percent}; keep additions small and consider compacting soon, preserving user requirements and unresolved work first.`;
	}

	const label = `reported provider window "${pressure.label}"`;
	const across = snapshotCount > 1 ? " across reported account snapshots (active account unknown)" : "";
	if (pressure.exhausted) {
		const subject =
			snapshotCount > 1
				? `A reported account snapshot has an exhausted provider window "${pressure.label}"`
				: `The ${label} is exhausted`;
		return `${subject}; stop non-essential provider calls until a reset is observed. Do not assume a reset restored quota.`;
	}
	if (pressure.resetsAt !== undefined) {
		const untilReset = pressure.resetsAt - now;
		if (untilReset > 0 && untilReset <= 15 * 60_000) {
			return `The tightest ${label} has ${percent} left and a reported reset in ${formatDuration(untilReset)}; prefer short work and re-check after the reset rather than assuming it succeeded.`;
		}
	}
	if (pressure.fraction <= TIGHT_LIMIT_FRACTION) {
		return `The tightest ${label} has ${percent} left${across}; prioritize required work, defer optional or large calls, and do not assume more quota than reported. Model/account switching is the operator's decision.`;
	}
	return `${label[0]!.toUpperCase()}${label.slice(1)} has ${percent} left${across}; budget remaining calls and prefer required work.`;
}

function buildAdvice(
	pressures: readonly UsagePressure[],
	contextKnown: boolean,
	providerKnown: boolean,
	snapshotCount: number,
	now: number,
): string {
	if (!contextKnown && !providerKnown) {
		return "Advice: No current provider-quota or context headroom is known; do not assume that missing, stale, or past-reset data restores allowance.";
	}

	const sorted = [...pressures].sort((left, right) => left.fraction - right.fraction);
	const context = sorted.find(pressure => pressure.source === "context");
	const provider = sorted.find(pressure => pressure.source === "provider");
	const selected = [context, provider]
		.filter((pressure): pressure is UsagePressure => pressure !== undefined)
		.sort((left, right) => left.fraction - right.fraction);
	const clauses: string[] = [];

	const tight = selected.filter(pressure => pressure.fraction <= NEAR_LIMIT_FRACTION);
	if (tight.length === 0 && selected.length > 0) {
		const tightest = selected[0]!;
		const qualifier =
			tightest.source === "provider" && snapshotCount > 1
				? " across reported account snapshots (active account unknown)"
				: "";
		clauses.push(
			`Known limits have headroom (tightest: ${pressureLabel(tightest)} at ${formatPercent(tightest.fraction)} left${qualifier}); no immediate usage pressure.`,
		);
	} else {
		for (const pressure of tight) clauses.push(describePressureAdvice(pressure, now, snapshotCount));
		for (const pressure of selected.filter(candidate => candidate.fraction > NEAR_LIMIT_FRACTION)) {
			const label = pressureLabel(pressure);
			const qualifier =
				pressure.source === "provider" && snapshotCount > 1 ? " in one reported account snapshot" : "";
			clauses.push(
				`${label[0]!.toUpperCase()}${label.slice(1)} still has ${formatPercent(pressure.fraction)} headroom${qualifier}.`,
			);
		}
	}

	if (!providerKnown && contextKnown) {
		clauses.push("Provider quota for the current model is unknown; do not assume provider headroom.");
	}
	if (!contextKnown && providerKnown) {
		clauses.push("Context headroom is unknown; do not assume context space.");
	}
	return `Advice: ${clauses.join(" ")}`;
}

function readModel(ctx: ExtensionContext): { label: string; provider: string; modelId: string } {
	const rawModel = ctx.model;
	const provider = typeof rawModel?.provider === "string" ? rawModel.provider.trim() : "";
	const modelId = typeof rawModel?.id === "string" ? rawModel.id.trim() : "";
	const providerText = cleanText(provider, "unknown provider");
	const modelText = cleanText(modelId, "unknown model");

	if (provider && modelId) return { label: `${providerText}/${modelText}`, provider, modelId };
	if (provider) return { label: `${providerText} (model id unknown)`, provider, modelId };
	if (modelId) return { label: `${modelText} (provider unknown)`, provider, modelId };
	return { label: "unknown (no active model)", provider, modelId };
}

async function readProviderQuota(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	now: number,
): Promise<{ lines: string[]; candidates: UsagePressure[]; snapshotCount: number }> {
	const providerLabel = cleanText(provider, "unknown provider");
	if (!provider || !modelId) {
		return {
			lines: ["Provider quota: unknown (no active model/provider; no provider read attempted)"],
			candidates: [],
			snapshotCount: 0,
		};
	}

	let rawReports: UsageReport[] | null = null;
	try {
		const registry = ctx.modelRegistry;
		const usage = registry?.authStorage?.usage;
		if (!usage || typeof usage.reports !== "function") {
			return {
				lines: [`Provider quota (${providerLabel}): unknown (host usage API unavailable)`],
				candidates: [],
				snapshotCount: 0,
			};
		}

		const options: {
			provider: string;
			baseUrlResolver?: (provider: string) => string | undefined;
		} = { provider };
		if (registry && typeof registry.getProviderBaseUrl === "function") {
			const getBaseUrl = registry.getProviderBaseUrl.bind(registry);
			options.baseUrlResolver = candidateProvider => {
				try {
					return getBaseUrl(candidateProvider);
				} catch {
					return undefined;
				}
			};
		}
		rawReports = await usage.reports(options);
	} catch {
		return {
			lines: [`Provider quota (${providerLabel}): unknown (read failed; error details withheld)`],
			candidates: [],
			snapshotCount: 0,
		};
	}

	if (rawReports === null) {
		return {
			lines: [`Provider quota (${providerLabel}): unknown (host returned no current report)`],
			candidates: [],
			snapshotCount: 0,
		};
	}
	if (!Array.isArray(rawReports)) {
		return {
			lines: [`Provider quota (${providerLabel}): unknown (host returned an invalid report)`],
			candidates: [],
			snapshotCount: 0,
		};
	}

	const reports = rawReports.filter(
		(report): report is UsageReport =>
			report !== null && typeof report === "object" && report.provider === provider,
	);
	if (reports.length === 0) {
		return {
			lines: [`Provider quota (${providerLabel}): unknown (no account snapshots reported)`],
			candidates: [],
			snapshotCount: 0,
		};
	}

	const sorted = [...reports].sort(
		(left, right) => (timestampValue(right.fetchedAt) ?? 0) - (timestampValue(left.fetchedAt) ?? 0),
	);
	const lines = [
		`Provider quota (${providerLabel}), ${formatNumber(sorted.length)} account snapshot${sorted.length === 1 ? "" : "s"}; active account unknown; values not summed:`,
	];
	const candidates: UsagePressure[] = [];
	for (let index = 0; index < sorted.length; index += 1) {
		const snapshot = describeSnapshot(sorted[index]!, index + 1, sorted.length, provider, modelId, now);
		lines.push(snapshot.line);
		candidates.push(...snapshot.candidates);
	}

	return { lines, candidates, snapshotCount: sorted.length };
}

/**
 * Build compact, factual usage knowledge for the current model context.
 *
 * Reads only public host surfaces: context usage, session usage statistics, and
 * cached provider quota reports. Provider quota is treated as a per-account
 * snapshot, not active-account truth; snapshots older than five minutes or
 * past their reset window are reported as unknown rather than as current
 * allowance. No state is persisted and no automatic model/account change is
 * suggested.
 */
export async function getUsageKnowledge(ctx: ExtensionContext, nowInput?: number): Promise<string> {
	const now =
		typeof nowInput === "number" && Number.isFinite(nowInput) && nowInput > 0 ? nowInput : Date.now();
	const model = readModel(ctx);
	const context = readContextKnowledge(ctx);
	const session = readSessionKnowledge(ctx);
	const quota = await readProviderQuota(ctx, model.provider, model.modelId, now);

	const contextKnown = context.remainingFraction !== undefined;
	const providerKnown = quota.candidates.length > 0;
	const contextPressure: UsagePressure[] =
		context.remainingFraction !== undefined
			? [
					{
						source: "context",
						fraction: context.remainingFraction,
						label: "context",
						exhausted: context.remainingFraction === 0,
						headroomTokens: context.headroomTokens,
					},
				]
			: [];
	const pressures = [...contextPressure, ...quota.candidates];

	const scope =
		"Scope: Provider quota rows are per-account snapshots from the host usage cache; the active account is unknown, so they are not necessarily this session's account, and values are never summed. Model-specific windows for other models are omitted; shared and account-wide windows are retained. Session token/cost counters are local to this session, not provider quota; cost includes subagent spend. Quota data over 5 minutes old or past a window reset is reported as unknown current allowance.";

	return [
		"Usage awareness (session-scoped, read-only)",
		`Model: ${model.label}`,
		session.line,
		context.line,
		...quota.lines,
		scope,
		buildAdvice(pressures, contextKnown, providerKnown, quota.snapshotCount, now),
	].join("\n");
}
