import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { CreditBalances } from "./credit-balance";
import { getUsageKnowledge } from "./usage-knowledge";

const COMMAND_NAME = "usage-awareness";
const CUSTOM_TYPE = "alamode-usage-awareness";
const STATUS_KEY = "alamode-usage-awareness";
const STATUS_ON = "usage awareness: on";
const STATUS_LIMIT = 120;
const USAGE =
	"Usage: /usage-awareness [on|off|status] | /usage-awareness balance <USD> [low-USD] | /usage-awareness balance clear";
const CREDIT_FALLBACK_NOTE =
	"Scenario estimate only; a budget cannot be certified. Task/subagent charges are excluded from provider attribution, so actual remaining may be lower.";
const DECIMAL_USD = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

type ContextMessage = ContextEvent["messages"][number];
type OwnMessage = Extract<ContextMessage, { role: "custom" }>;
type KnowledgeReader = typeof getUsageKnowledge;

interface CreditDescription {
	text: string;
	reminder?: string;
}

interface CreditBalanceSource {
	set(ctx: ExtensionContext, balance: number, lowThreshold?: number): void;
	clear(provider?: string): void;
	describe(ctx: ExtensionContext): CreditDescription | undefined;
}

function isOwnMessage(message: ContextMessage): message is OwnMessage {
	return message.role === "custom" && message.customType === CUSTOM_TYPE;
}

/** Footer text is one line; prefer the context line when the knowledge provides one. */
function compactStatus(knowledge: string): string {
	const lines = knowledge
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
	const first =
		lines.find(line => line.startsWith("Context:")) ??
		lines.find(line => !line.startsWith("Usage awareness")) ??
		"";
	if (!first) return STATUS_ON;
	const prefix = "usage: ";
	const available = STATUS_LIMIT - prefix.length;
	return first.length <= available ? `${prefix}${first}` : `${prefix}${first.slice(0, available - 3)}...`;
}

function parseUsd(value: string): number | undefined {
	if (!DECIMAL_USD.test(value)) return undefined;
	const amount = Number(value);
	return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/** Match CreditBalances precision: tiny non-zero balances must not render as $0.00. */
function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "$?";
	if (value === 0) return "$0.00";
	if (value >= 1) return `$${value.toFixed(2)}`;
	const digits = Math.min(10, Math.max(2, 3 - Math.floor(Math.log10(value))));
	const fixed = value.toFixed(digits);
	if (Number(fixed) === 0) return `$${value.toExponential(2)}`;
	const fraction = fixed.split(".")[1] ?? "";
	return `$${fixed.split(".")[0]}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

export default function usageAwareness(
	pi: ExtensionAPI,
	readKnowledge: KnowledgeReader = getUsageKnowledge,
	credits: CreditBalanceSource = new CreditBalances(),
): void {
	let enabled = false;
	/** Bumped whenever an async read's result may no longer apply. */
	let transition = 0;
	/** Newest user-facing read wins; an older notification must not overwrite it. */
	let uiRequest = 0;
	let statusShown = false;

	function showStatus(ctx: ExtensionContext, text: string): void {
		statusShown = true;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (!statusShown) return;
		statusShown = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	async function load(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			const knowledge = await readKnowledge(ctx);
			if (typeof knowledge !== "string") return undefined;
			const trimmed = knowledge.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			// Error text can carry provider or credential detail; never surface it here.
			return undefined;
		}
	}

	/** Local session estimate only; callers must have established that awareness is enabled. */
	function describeCredits(ctx: ExtensionContext): CreditDescription | undefined {
		try {
			const description = credits.describe(ctx);
			if (description?.reminder) ctx.ui.notify(description.reminder, "warning");
			return description;
		} catch {
			return undefined;
		}
	}

	async function display(ctx: ExtensionContext): Promise<void> {
		const request = ++uiRequest;
		const startedAt = transition;
		const knowledge = await load(ctx);
		if (!enabled || transition !== startedAt || uiRequest !== request) return;

		const credit = describeCredits(ctx)?.text?.trim();
		const text = knowledge ? (credit ? `${knowledge}\n\n${credit}` : knowledge) : credit;
		if (!text) {
			ctx.ui.notify("Usage awareness is on, but current usage knowledge is unavailable.", "warning");
			return;
		}
		showStatus(ctx, compactStatus(text));
		if (knowledge) {
			ctx.ui.notify(text, "info");
		} else {
			ctx.ui.notify(
				`Usage awareness is on, but current usage and quota knowledge is unavailable.\n\n${text}`,
				"warning",
			);
		}
	}

	function disable(ctx: ExtensionContext, announce: boolean): void {
		enabled = false;
		transition++;
		uiRequest++;
		clearStatus(ctx);
		if (announce) ctx.ui.notify("Usage awareness off.", "info");
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		if (!enabled) {
			enabled = true;
			showStatus(ctx, STATUS_ON);
		}
		await display(ctx);
	}

	function reset(ctx: ExtensionContext): void {
		enabled = false;
		transition++;
		uiRequest++;
		clearStatus(ctx);
		try {
			credits.clear();
		} catch {
			// Session transitions must still complete when a credit estimate cannot be cleared.
		}
	}

	function setBalance(tokens: string[], ctx: ExtensionContext): void {
		const provider = ctx.model?.provider;
		if (!provider) {
			ctx.ui.notify("Usage awareness: no active model provider; credit balance unchanged.", "warning");
			return;
		}

		if (tokens.length === 1 && tokens[0]?.toLowerCase() === "clear") {
			try {
				credits.clear(provider);
				ctx.ui.notify(`Usage awareness: cleared the session credit estimate for ${provider}.`, "info");
			} catch {
				ctx.ui.notify("Usage awareness: could not clear the credit estimate.", "warning");
			}
			return;
		}

		if (tokens.length < 1 || tokens.length > 2) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const starting = parseUsd(tokens[0] ?? "");
		const lowThreshold = tokens.length === 2 ? parseUsd(tokens[1] ?? "") : undefined;
		if (starting === undefined || (tokens.length === 2 && lowThreshold === undefined)) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}

		const threshold = lowThreshold ?? starting * 0.1;
		try {
			credits.set(ctx, starting, lowThreshold);
		} catch {
			ctx.ui.notify("Usage awareness: could not record the credit balance estimate.", "warning");
			return;
		}

		let described: CreditDescription | undefined;
		if (enabled) {
			described = describeCredits(ctx);
		}
		const describedText = described?.text?.trim();
		const estimate =
			describedText ||
			`Estimated remaining: ${formatUsd(starting)} (baseline captured now; no later recorded cost applied yet).`;
		const scope = describedText ? "" : ` ${CREDIT_FALLBACK_NOTE}`;
		ctx.ui.notify(
			`Usage awareness: starting balance ${formatUsd(starting)}, low-balance threshold ${formatUsd(threshold)} for ${provider}. ${estimate}${scope}`,
			"info",
		);
	}

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Include current context, token, cost, and provider quota knowledge in model calls, with optional credit estimates: /usage-awareness [on|off|status|balance]",
		getArgumentCompletions: prefix => {
			const value = prefix.trim().toLowerCase();
			return ["on", "off", "status", "balance"]
				.filter(option => option.startsWith(value))
				.map(option => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
			const head = tokens[0]?.toLowerCase() ?? "";

			if (tokens.length === 0) {
				if (enabled) disable(ctx, true);
				else await enable(ctx);
				return;
			}
			if (tokens.length === 1 && head === "on") {
				await enable(ctx);
				return;
			}
			if (tokens.length === 1 && head === "off") {
				disable(ctx, true);
				return;
			}
			if (tokens.length === 1 && head === "status") {
				if (!enabled) {
					ctx.ui.notify("Usage awareness is off.", "info");
					return;
				}
				await display(ctx);
				return;
			}
			if (head === "balance") {
				setBalance(tokens.slice(1), ctx);
				return;
			}
			ctx.ui.notify(USAGE, "warning");
		},
	});

	pi.on("context", async (event, ctx) => {
		const hadOwn = event.messages.some(isOwnMessage);
		const messages = hadOwn ? event.messages.filter(message => !isOwnMessage(message)) : event.messages;

		// The off state must not read usage data at all.
		if (!enabled) return hadOwn ? { messages } : undefined;

		const startedAt = transition;
		const knowledge = await load(ctx);
		if (!enabled || transition !== startedAt) return hadOwn ? { messages } : undefined;

		const credit = describeCredits(ctx)?.text?.trim();
		const text = knowledge ? (credit ? `${knowledge}\n\n${credit}` : knowledge) : credit;
		if (!text) return hadOwn ? { messages } : undefined;
		showStatus(ctx, compactStatus(text));

		// Ephemeral per-call projection only; never written to session history.
		return {
			messages: [
				...messages,
				{
					role: "custom",
					customType: CUSTOM_TYPE,
					content: knowledge
						? text
						: `Usage awareness: current usage and quota knowledge is unavailable.\n\n${text}`,
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	const resetSession = (_event: unknown, ctx: ExtensionContext): void => reset(ctx);
	pi.on("session_start", resetSession);
	pi.on("session_switch", resetSession);
	pi.on("session_branch", resetSession);

	// The context hook cannot see a threshold crossed by the final assistant response:
	// there may be no next model call. Inspect the local ledger at settle, without
	// provider quota reads. CreditBalances deduplicates a reminder it already emitted.
	pi.on("agent_end", (_event, ctx) => {
		if (!enabled) return;
		describeCredits(ctx);
	});
}
