/**
 * Manual, session-local credit estimates for the active provider.
 *
 * The operator supplies how much credit remains *now*. We snapshot the cost the
 * host has already recorded for that provider, then subtract later
 * provider-labelled model costs. Task/subagent spend is recorded separately:
 * its aggregate has no provider attribution, so it widens the estimate into a
 * conservative scenario range instead of being silently ignored. The range is a
 * scenario estimate, not a guaranteed bound on real billed credit. Nothing here
 * talks to a provider, reads credentials, or persists across sessions.
 */
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";

type ReminderLevel = "low" | "exhausted";

interface ProviderBalance {
	/** Remaining USD the operator entered at {@link CreditBalances.set}. */
	balance: number;
	lowThreshold: number;
	/** Provider-labelled cost already recorded when the balance was entered. */
	baselineCost: number;
	/** Task/subagent cost already recorded when the balance was entered. */
	baselineChildCost: number;
	/** Highest warning already emitted for this entry; re-entry clears it. */
	reminder?: ReminderLevel;
}

/**
 * Sum only costs the host attributed to one provider.
 *
 * Assistant turns and `model_usage` records carry both a provider and their own
 * provider-computed USD cost. Scanning every recorded entry includes off-branch
 * turns, which were still billed. Task tool results never enter this sum: their
 * aggregate child usage has no per-provider breakdown, so adding it by a final
 * resolved model could charge the wrong provider.
 */
function providerCost(entries: readonly SessionEntry[], provider: string): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "model_usage") {
			const cost = entry.usage.cost.total;
			if (entry.provider === provider && Number.isFinite(cost) && cost > 0) total += cost;
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const cost = entry.message.usage.cost.total;
		if (entry.message.provider === provider && Number.isFinite(cost) && cost > 0) total += cost;
	}
	return total;
}

function usageCost(usage: unknown): number {
	if (usage === null || typeof usage !== "object") return 0;
	if (!("cost" in usage)) return 0;
	const cost = usage.cost;
	if (cost === null || typeof cost !== "object") return 0;
	if (!("total" in cost)) return 0;
	const total = cost.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

/** Direct child cost carried by one `TaskToolDetails` object. */
function taskDetailsCost(details: object): number {
	const top = "usage" in details ? usageCost(details.usage) : 0;
	if (top > 0) return top;
	if (!("results" in details)) return 0;
	const results = details.results;
	if (!Array.isArray(results)) return 0;
	let total = 0;
	for (const result of results) {
		if (result !== null && typeof result === "object" && "usage" in result) {
			total += usageCost(result.usage);
		}
	}
	return total;
}

/**
 * Sum recorded task-result child cost, including nested `task` details the
 * parent session keeps under `extractedToolData.task`. These totals carry no
 * provider attribution, and child `model_usage` calls are not represented.
 */
function nestedTaskCost(details: unknown, seen: Set<object>, includeSelf: boolean): number {
	if (details === null || typeof details !== "object") return 0;
	if (seen.has(details)) return 0;
	seen.add(details);

	let total = includeSelf ? taskDetailsCost(details) : 0;
	if (!("results" in details)) return total;
	const results = details.results;
	if (!Array.isArray(results)) return total;
	for (const result of results) {
		if (result === null || typeof result !== "object") continue;
		if (!("extractedToolData" in result)) continue;
		const extracted = result.extractedToolData;
		if (extracted === null || typeof extracted !== "object") continue;
		if (!("task" in extracted)) continue;
		const nested = extracted.task;
		if (!Array.isArray(nested)) continue;
		for (const nestedDetails of nested) total += nestedTaskCost(nestedDetails, seen, true);
	}
	return total;
}

function recordedChildCost(entries: readonly SessionEntry[], reportedSubagentCost: unknown): number {
	let direct = 0;
	let nested = 0;
	const seen = new Set<object>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "task") {
			continue;
		}
		const details = entry.message.details;
		if (details === null || typeof details !== "object") continue;
		direct += taskDetailsCost(details);
		nested += nestedTaskCost(details, seen, false);
	}

	const reported =
		typeof reportedSubagentCost === "number" &&
		Number.isFinite(reportedSubagentCost) &&
		reportedSubagentCost > 0
			? reportedSubagentCost
			: 0;
	// The host total and the entry traversal overlap; take the larger total
	// rather than adding both and double-counting completed task results.
	return Math.max(reported, direct + nested);
}

/** At least cents, more precision for tiny positive amounts so they never display as $0.00. */
function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "$?";
	if (value === 0) return "$0.00";
	const absolute = Math.abs(value);
	const digits = absolute >= 1 ? 2 : Math.min(10, Math.max(6, 3 - Math.floor(Math.log10(absolute))));
	let text = value.toFixed(digits);
	if (Number(text) === 0) text = value.toExponential(2);
	if (text.includes("e")) return `$${text}`;
	const [whole = "0", fraction = ""] = text.split(".");
	return `$${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

const SCENARIO_BOUND = "Scenario estimates, not guaranteed bounds; a budget cannot be certified.";
const ESTIMATE_CAVEAT =
	"Estimate only, not an invoice; also excludes spend outside this session and unpriced usage.";

export class CreditBalances {
	#providers = new Map<string, ProviderBalance>();

	/**
	 * Record the operator's current remaining balance for the active provider.
	 * Provider-labelled and task/subagent costs already in the session are the
	 * baseline, so historical spend is not deducted again. Re-entry replaces the
	 * entry and resets reminder state.
	 */
	set(ctx: ExtensionContext, balance: number, lowThreshold?: number): void {
		const provider = ctx.model?.provider;
		if (typeof provider !== "string" || provider.length === 0) {
			throw new TypeError("A credit balance needs an active model provider.");
		}
		if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
			throw new RangeError("Balance must be a non-negative finite USD amount.");
		}
		const threshold = lowThreshold === undefined ? balance * 0.1 : lowThreshold;
		if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
			throw new RangeError("Low threshold must be a non-negative finite USD amount.");
		}

		const entries = ctx.sessionManager.getEntries();
		const stats = ctx.sessionManager.getUsageStatistics();
		this.#providers.set(provider, {
			balance,
			lowThreshold: threshold,
			baselineCost: providerCost(entries, provider),
			baselineChildCost: recordedChildCost(entries, stats.subagentCost),
		});
	}

	/** Clear every provider estimate, or just the named provider's. */
	clear(provider?: string): void {
		if (provider === undefined) this.#providers.clear();
		else this.#providers.delete(provider);
	}

	/**
	 * Describe the active provider's estimate as a conservative scenario range.
	 * The low scenario assumes every recorded task/subagent charge hit this
	 * provider; the high scenario excludes them. Reminders use the low scenario
	 * and are emitted only for the first possible low reading or newly possible
	 * exhaustion.
	 */
	describe(ctx: ExtensionContext): { text: string; reminder?: string } | undefined {
		const provider = ctx.model?.provider;
		if (typeof provider !== "string" || provider.length === 0) return undefined;
		const state = this.#providers.get(provider);
		if (!state) return undefined;

		const entries = ctx.sessionManager.getEntries();
		const stats = ctx.sessionManager.getUsageStatistics();
		const charged = Math.max(0, providerCost(entries, provider) - state.baselineCost);
		const childCharged = Math.max(0, recordedChildCost(entries, stats.subagentCost) - state.baselineChildCost);
		const upperRaw = state.balance - charged;
		const lowerRaw = upperRaw - childCharged;
		const lower = Math.max(0, lowerRaw);
		const upper = Math.max(0, upperRaw);
		const remaining = lower === upper ? formatUsd(lower) : `${formatUsd(lower)}-${formatUsd(upper)}`;

		const childNote =
			childCharged > 0
				? `Task/subagent charges are excluded from provider attribution: ${formatUsd(childCharged)} recorded since entry, so the low scenario assumes all of it hit ${provider} and the high scenario excludes it. Task/subagent spend not represented in session task results is also excluded.`
				: `Task/subagent charges are excluded from provider attribution; none were recorded since entry, but any not represented in session task results is also excluded.`;

		const possibleExhausted = lowerRaw <= 0;
		const possibleLow = !possibleExhausted && lowerRaw <= state.lowThreshold;
		let reminder: string | undefined;
		if (possibleExhausted && state.reminder !== "exhausted") {
			state.reminder = "exhausted";
			reminder =
				`Possible ${provider} credit exhaustion: estimated remaining ${remaining} USD (${SCENARIO_BOUND}). ` +
				`${formatUsd(charged)} charged since entry (provider-labelled). ${childNote} ${ESTIMATE_CAVEAT}`;
		} else if (possibleLow && state.reminder === undefined) {
			state.reminder = "low";
			reminder =
				`Possible ${provider} credit low: estimated remaining ${remaining} USD (${SCENARIO_BOUND}) ` +
				`with low threshold ${formatUsd(state.lowThreshold)}. ` +
				`${formatUsd(charged)} charged since entry (provider-labelled). ${childNote} ${ESTIMATE_CAVEAT}`;
		}

		return {
			text:
				`Estimated ${provider} credit: ${remaining} USD remaining of ${formatUsd(state.balance)} entered. ` +
				`${SCENARIO_BOUND} ${formatUsd(charged)} charged since entry (provider-labelled); ` +
				`low threshold ${formatUsd(state.lowThreshold)}. ${childNote} ${ESTIMATE_CAVEAT}`,
			...(reminder === undefined ? {} : { reminder }),
		};
	}
}
