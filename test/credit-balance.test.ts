import { describe, expect, test } from "bun:test";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";

import { CreditBalances } from "../src/credit-balance.ts";

let nextId = 0;

function usage(cost: number) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(provider: string, cost: number, model = "model-a", offBranch = false): SessionEntry {
	return {
		type: "message",
		id: `entry-${++nextId}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			api: "test-api",
			provider,
			model,
			usage: usage(cost),
			stopReason: "stop",
			timestamp: 1,
		},
		...(offBranch ? { activeLeafId: "another-leaf" } : {}),
	} as unknown as SessionEntry;
}

function modelUsage(provider: string, cost: number, offBranch = false): SessionEntry {
	return {
		type: "model_usage",
		id: `entry-${++nextId}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		purpose: "title",
		api: "test-api",
		provider,
		model: "model-a",
		usage: usage(cost),
		stopReason: "stop",
		...(offBranch ? { activeLeafId: "another-leaf" } : {}),
	} as unknown as SessionEntry;
}

function taskResult(provider: string, cost: number, nestedCost = 0): SessionEntry {
	const childUsage = usage(cost);
	return {
		type: "message",
		id: `entry-${++nextId}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "task-1",
			toolName: "task",
			content: [],
			isError: false,
			details: {
				projectAgentsDir: null,
				totalDurationMs: 1,
				usage: childUsage,
				results: [
					{
						index: 0,
						id: "child",
						agent: "task",
						agentSource: "unknown",
						task: "child work",
						exitCode: 0,
						output: "",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: 1,
						usage: childUsage,
						resolvedModel: `${provider}/model-a`,
						resolvedModelIdentity: `${provider}/model-a`,
						...(nestedCost > 0
							? {
									extractedToolData: {
										task: [
											{
												projectAgentsDir: null,
												totalDurationMs: 1,
												usage: usage(nestedCost),
												results: [],
											},
										],
									},
								}
							: {}),
					},
				],
			},
			timestamp: 1,
		},
	} as unknown as SessionEntry;
}

function createContext(provider: string | undefined, entries: SessionEntry[] = [], subagentCost = 0) {
	const stats = { subagentCost };
	const ctx = {
		model:
			provider === undefined
				? undefined
				: ({ provider, id: "test-model" } as unknown as ExtensionContext["model"]),
		sessionManager: {
			getEntries: () => entries,
			getUsageStatistics: () => ({ subagentCost: stats.subagentCost }),
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		entries,
		setProvider(name: string | undefined): void {
			ctx.model =
				name === undefined
					? undefined
					: ({ provider: name, id: "test-model" } as unknown as ExtensionContext["model"]);
		},
		setSubagentCost(value: number): void {
			stats.subagentCost = value;
		},
	};
}

describe("credit balances", () => {
	test("baseline excludes spend recorded before the balance entry", () => {
		const { ctx } = createContext(
			"openai",
			[assistant("openai", 4), modelUsage("openai", 1), assistant("anthropic", 8), taskResult("openai", 4)],
			4,
		);
		const balances = new CreditBalances();

		balances.set(ctx, 20);
		const described = balances.describe(ctx);

		expect(described?.text).toContain("$20.00 USD remaining of $20.00 entered");
		expect(described?.text).toContain("$0.00 charged since entry");
		expect(described?.text).toContain("low threshold $2.00");
		expect(described?.text).toContain("none were recorded since entry");
		expect(described?.reminder).toBeUndefined();
	});

	test("later matching-provider spend is deducted, including model changes and model_usage", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10);

		entries.push(assistant("openai", 2.5, "model-a"), assistant("openai", 1, "model-b"), modelUsage("openai", 0.5));
		const described = balances.describe(ctx);

		expect(described?.text).toContain("$6.00 USD remaining of $10.00 entered");
		expect(described?.text).toContain("$4.00 charged since entry");
	});

	test("other providers' spend is excluded", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10);

		entries.push(assistant("anthropic", 9), assistant("openai", 1));
		const described = balances.describe(ctx);

		expect(described?.text).toContain("$9.00 USD remaining");
		expect(described?.text).toContain("$1.00 charged since entry");
	});

	test("off-branch provider usage counts while unpriced usage adds nothing", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 5);

		entries.push(
			assistant("openai", 0.25, "model-b", true),
			modelUsage("openai", 0.5, true),
			assistant("openai", 0),
			modelUsage("anthropic", 2, true),
		);
		const described = balances.describe(ctx);

		expect(described?.text).toContain("$4.25 USD remaining");
		expect(described?.text).toContain("$0.75 charged since entry");
		expect(described?.reminder).toBeUndefined();
	});

	test("provider switches keep independent baselines", () => {
		const { ctx, entries, setProvider } = createContext("openai", [
			assistant("openai", 1),
			assistant("anthropic", 2),
		]);
		const balances = new CreditBalances();
		balances.set(ctx, 10);
		entries.push(assistant("openai", 2));

		setProvider("anthropic");
		balances.set(ctx, 5);
		entries.push(assistant("anthropic", 1));
		const anthropic = balances.describe(ctx);
		expect(anthropic?.text).toContain("$4.00 USD remaining of $5.00 entered");
		expect(anthropic?.text).toContain("$1.00 charged since entry");

		setProvider("openai");
		const openai = balances.describe(ctx);
		expect(openai?.text).toContain("$8.00 USD remaining of $10.00 entered");
		expect(openai?.text).toContain("$2.00 charged since entry");
	});

	test("low and exhausted reminders cross once, and repeat readings stay quiet", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10, 2);

		entries.push(assistant("openai", 8));
		const low = balances.describe(ctx);
		expect(low?.text).toContain("$2.00 USD remaining");
		expect(low?.reminder).toContain("Possible");
		expect(low?.reminder).toContain("credit low");
		expect(low?.reminder).toContain("threshold $2.00");
		expect(low?.reminder).toContain("Estimate only");

		expect(balances.describe(ctx)?.reminder).toBeUndefined();
		entries.push(assistant("openai", 1));
		expect(balances.describe(ctx)?.reminder).toBeUndefined();

		entries.push(assistant("openai", 1.5));
		const exhausted = balances.describe(ctx);
		expect(exhausted?.text).toContain("$0.00 USD remaining");
		expect(exhausted?.reminder).toContain("Possible");
		expect(exhausted?.reminder).toContain("credit exhaustion");
		expect(exhausted?.reminder).toContain("Estimate only");
		expect(balances.describe(ctx)?.reminder).toBeUndefined();
	});

	test("re-entry resets the baseline and reminder state", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10);
		entries.push(assistant("openai", 9));
		expect(balances.describe(ctx)?.reminder).toContain("credit low");

		balances.set(ctx, 2);
		const reset = balances.describe(ctx);
		expect(reset?.text).toContain("$2.00 USD remaining of $2.00 entered");
		expect(reset?.text).toContain("$0.00 charged since entry");
		expect(reset?.reminder).toBeUndefined();

		entries.push(assistant("openai", 1.9));
		expect(balances.describe(ctx)?.reminder).toContain("credit low");
	});

	test("clear resets one provider or the whole session", () => {
		const { ctx, setProvider } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10);
		setProvider("anthropic");
		balances.set(ctx, 5);

		balances.clear("openai");
		setProvider("openai");
		expect(balances.describe(ctx)).toBeUndefined();
		setProvider("anthropic");
		expect(balances.describe(ctx)).toBeDefined();

		balances.clear();
		expect(balances.describe(ctx)).toBeUndefined();
	});

	test("task child spend widens the range without provider attribution", () => {
		const { ctx, entries } = createContext("openai", [assistant("openai", 1)]);
		const balances = new CreditBalances();
		balances.set(ctx, 10);

		entries.push(taskResult("openai", 4));
		const described = balances.describe(ctx);
		expect(described?.text).toContain("$6.00-$10.00 USD remaining");
		expect(described?.text).toContain("$0.00 charged since entry");
		expect(described?.text).toContain("Task/subagent charges are excluded");
		expect(described?.text).toContain("low scenario assumes all of it hit openai");
		expect(described?.text).toContain("high scenario excludes it");

		entries.push(modelUsage("openai", 0.25));
		const withDirectUsage = balances.describe(ctx);
		expect(withDirectUsage?.text).toContain("$5.75-$9.75 USD remaining");
		expect(withDirectUsage?.text).toContain("$0.25 charged since entry");
	});

	test("nested task details widen the range too", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10);

		entries.push(taskResult("openai", 1, 2));
		const described = balances.describe(ctx);

		expect(described?.text).toContain("$7.00-$10.00 USD remaining");
		expect(described?.text).toContain("Task/subagent charges are excluded");
		expect(described?.reminder).toBeUndefined();
	});

	test("host subagentCost participates in the baseline and later delta", () => {
		const { ctx, setSubagentCost } = createContext("openai", [], 4);
		const balances = new CreditBalances();
		balances.set(ctx, 10);

		const baseline = balances.describe(ctx);
		expect(baseline?.text).toContain("$10.00 USD remaining");
		expect(baseline?.text).toContain("none were recorded since entry");

		setSubagentCost(6);
		const described = balances.describe(ctx);
		expect(described?.text).toContain("$8.00-$10.00 USD remaining");
		expect(described?.text).toContain("$2.00 recorded since entry");
	});

	test("range reminders use the low scenario and stay one-shot", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 10, 2);

		entries.push(taskResult("openai", 4));
		expect(balances.describe(ctx)?.reminder).toBeUndefined();

		entries.push(taskResult("openai", 5.5));
		const low = balances.describe(ctx);
		expect(low?.text).toContain("$0.50-$10.00 USD remaining");
		expect(low?.reminder).toContain("Possible");
		expect(low?.reminder).toContain("credit low");
		expect(low?.reminder).toContain("low scenario assumes all of it hit openai");
		expect(balances.describe(ctx)?.reminder).toBeUndefined();

		entries.push(taskResult("openai", 0.5));
		const exhausted = balances.describe(ctx);
		expect(exhausted?.text).toContain("$0.00-$10.00 USD remaining");
		expect(exhausted?.reminder).toContain("Possible");
		expect(exhausted?.reminder).toContain("credit exhaustion");
		expect(balances.describe(ctx)?.reminder).toBeUndefined();
	});

	test("tiny positive balances keep precision instead of displaying $0.00", () => {
		const { ctx, entries } = createContext("openai");
		const balances = new CreditBalances();
		balances.set(ctx, 1);

		entries.push(assistant("openai", 0.999999));
		const described = balances.describe(ctx);
		expect(described?.text).toContain("$0.000001 USD remaining");
		expect(described?.text).not.toContain("$0.00 USD remaining");
	});

	test("set rejects missing providers and invalid amounts", () => {
		const { ctx, setProvider } = createContext(undefined);
		const balances = new CreditBalances();
		expect(() => balances.set(ctx, 1)).toThrow(TypeError);

		setProvider("openai");
		expect(() => balances.set(ctx, -0.01)).toThrow(RangeError);
		expect(() => balances.set(ctx, Number.NaN)).toThrow(RangeError);
		expect(() => balances.set(ctx, Number.POSITIVE_INFINITY)).toThrow(RangeError);
		expect(() => balances.set(ctx, 1, -0.01)).toThrow(RangeError);
		expect(() => balances.set(ctx, 1, Number.NaN)).toThrow(RangeError);
		expect(() => balances.set(ctx, 1, Number.POSITIVE_INFINITY)).toThrow(RangeError);

		expect(balances.describe(ctx)).toBeUndefined();
		setProvider(undefined);
		expect(balances.describe(ctx)).toBeUndefined();
	});
});
