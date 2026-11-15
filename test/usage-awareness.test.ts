import { describe, expect, test } from "bun:test";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import usageAwareness from "../src/usage-awareness.ts";

const CUSTOM_TYPE = "alamode-usage-awareness";
const STATUS_KEY = "alamode-usage-awareness";

type ContextMessage = ContextEvent["messages"][number];
type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type KnowledgeReader = (ctx: ExtensionContext, now?: number) => Promise<string>;

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface FakeHost {
	api: ExtensionAPI;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, SessionHandler[]>;
	writes: { sendMessage: number; appendEntry: number };
}

function createHost(): FakeHost {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, SessionHandler[]>();
	const writes = { sendMessage: 0, appendEntry: 0 };
	const api = {
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
			commands.set(name, { ...options });
		},
		on(event: string, handler: SessionHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage() {
			writes.sendMessage++;
		},
		appendEntry() {
			writes.appendEntry++;
		},
	};
	return { api: api as unknown as ExtensionAPI, commands, handlers, writes };
}

interface FakeContext {
	ctx: ExtensionContext;
	commandCtx: ExtensionCommandContext;
	notices: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	usage: { cost: number; subagentCost: number };
}

function createContext(provider: string | null = "test-provider"): FakeContext {
	const notices: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const usage = { cost: 0, subagentCost: 0 };
	const ctx = {
		hasUI: true,
		model: provider === null ? undefined : { provider },
		sessionManager: {
			getUsageStatistics: () => usage,
		},
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notices.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
		},
	};
	return {
		ctx: ctx as unknown as ExtensionContext,
		commandCtx: ctx as unknown as ExtensionCommandContext,
		notices,
		statuses,
		usage,
	};
}

function statusOf(ctx: FakeContext): string | undefined {
	return ctx.statuses.filter(entry => entry.key === STATUS_KEY).at(-1)?.text;
}

interface FakeKnowledge {
	read: KnowledgeReader;
	calls: Array<{ ctx: ExtensionContext; now: number | undefined }>;
	set(next: string | KnowledgeReader): void;
}

function createKnowledge(initial: string | KnowledgeReader = "knowledge"): FakeKnowledge {
	const calls: Array<{ ctx: ExtensionContext; now: number | undefined }> = [];
	let impl: KnowledgeReader = typeof initial === "function" ? initial : async () => initial;
	return {
		read: (ctx, now) => {
			calls.push({ ctx, now });
			return impl(ctx, now);
		},
		calls,
		set(next) {
			impl = typeof next === "function" ? next : async () => next;
		},
	};
}

interface FakeCredits {
	text: string;
	reminder: string | undefined;
	readonly setCalls: Array<{ ctx: ExtensionContext; balance: number; lowThreshold: number | undefined }>;
	readonly clearCalls: Array<string | undefined>;
	readonly describeCalls: number;
	set(ctx: ExtensionContext, balance: number, lowThreshold?: number): void;
	clear(provider?: string): void;
	describe(ctx: ExtensionContext): { text: string; reminder?: string } | undefined;
}

function createCredits(initial = ""): FakeCredits {
	let text = initial;
	let reminder: string | undefined;
	let describeCalls = 0;
	const setCalls: FakeCredits["setCalls"] = [];
	const clearCalls: FakeCredits["clearCalls"] = [];
	return {
		get text() {
			return text;
		},
		set text(value: string) {
			text = value;
		},
		get reminder() {
			return reminder;
		},
		set reminder(value: string | undefined) {
			reminder = value;
		},
		setCalls,
		clearCalls,
		get describeCalls() {
			return describeCalls;
		},
		set(ctx, balance, lowThreshold) {
			setCalls.push({ ctx, balance, lowThreshold });
			if (!text) text = `Estimated remaining: ${balance}.`;
		},
		clear(provider?: string) {
			clearCalls.push(provider);
			text = "";
			reminder = undefined;
		},
		describe() {
			describeCalls++;
			if (!text) return undefined;
			return reminder === undefined ? { text } : { text, reminder };
		},
	};
}

async function runCommand(host: FakeHost, args: string, ctx: FakeContext): Promise<void> {
	const command = host.commands.get("usage-awareness");
	if (!command) throw new Error("usage-awareness command not registered");
	await command.handler(args, ctx.commandCtx);
}

async function emit(
	host: FakeHost,
	event: string,
	payload: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<unknown> {
	let result: unknown;
	for (const handler of host.handlers.get(event) ?? []) {
		result = await handler({ type: event, ...payload }, ctx);
	}
	return result;
}

function contextMessages(result: unknown): ContextEvent["messages"] | undefined {
	return (result as { messages?: ContextEvent["messages"] } | undefined)?.messages;
}

function ownMessages(messages: ContextEvent["messages"] | undefined): ContextMessage[] {
	return (messages ?? []).filter(
		message => message.role === "custom" && message.customType === CUSTOM_TYPE,
	);
}

function userMessage(text: string, timestamp = 1): ContextMessage {
	return { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp } as ContextMessage;
}

function injectedContent(message: ContextMessage | undefined): string | undefined {
	if (!message || message.role !== "custom" || typeof message.content !== "string") return undefined;
	return message.content;
}

describe("usage awareness", () => {
	test("defaults off and performs no usage reads", async () => {
		const host = createHost();
		const knowledge = createKnowledge();
		const credits = createCredits();
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, credits);

		expect(host.commands.has("usage-awareness")).toBe(true);
		expect(host.handlers.get("session_start")).toHaveLength(1);
		expect(host.handlers.get("session_switch")).toHaveLength(1);
		expect(host.handlers.get("session_branch")).toHaveLength(1);
		expect(host.handlers.get("agent_end")).toHaveLength(1);

		const messages = [userMessage("hello")];
		const result = await emit(host, "context", { messages }, ctx.ctx);
		expect(result).toBeUndefined();
		expect(knowledge.calls).toHaveLength(0);

		await runCommand(host, "status", ctx);
		expect(ctx.notices.at(-1)?.message).toContain("off");
		expect(knowledge.calls).toHaveLength(0);

		await runCommand(host, "off", ctx);
		expect(ctx.notices.at(-1)?.message).toContain("off");
		expect(knowledge.calls).toHaveLength(0);

		await runCommand(host, "nonsense", ctx);
		expect(ctx.notices.at(-1)?.message).toContain("Usage:");
		expect(knowledge.calls).toHaveLength(0);
		expect(ctx.statuses).toHaveLength(0);

		await emit(host, "agent_end", { messages: [], willContinue: false }, ctx.ctx);
		expect(knowledge.calls).toHaveLength(0);
		expect(credits.describeCalls).toBe(0);
	});

	test("enabled context injection replaces its own prior message without duplicating", async () => {
		const host = createHost();
		const knowledge = createKnowledge("first snapshot\nline two");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, createCredits());

		await runCommand(host, "on", ctx);
		expect(knowledge.calls).toHaveLength(1);
		expect(statusOf(ctx)).toBe("usage: first snapshot");
		expect(ctx.notices.at(-1)?.message).toContain("first snapshot");
		expect(ctx.notices.at(-1)?.message).toContain("line two");

		const developer = {
			role: "developer",
			content: [{ type: "text", text: "rules" }],
			timestamp: 2,
		} as ContextMessage;
		const foreign = {
			role: "custom",
			customType: "other-extension",
			content: "keep me",
			display: false,
			timestamp: 3,
		} as ContextMessage;
		const user = userMessage("do work", 4);
		const before = Date.now();
		const first = contextMessages(await emit(host, "context", { messages: [developer, foreign, user] }, ctx.ctx));
		const after = Date.now();

		expect(first).toHaveLength(4);
		expect(first?.[0]).toBe(developer);
		expect(first?.[1]).toBe(foreign);
		expect(first?.[2]).toBe(user);
		const own = ownMessages(first);
		expect(own).toHaveLength(1);
		expect(own[0]?.role).toBe("custom");
		expect(own[0] && "display" in own[0] ? own[0].display : undefined).toBe(false);
		expect(own[0]?.timestamp).toBeGreaterThanOrEqual(before);
		expect(own[0]?.timestamp).toBeLessThanOrEqual(after);
		expect(injectedContent(own[0])).toBe("first snapshot\nline two");

		knowledge.set("second snapshot");
		const secondUser = userMessage("continue", 5);
		const second = contextMessages(
			await emit(host, "context", { messages: [...(first ?? []), secondUser] }, ctx.ctx),
		);

		expect(second).toHaveLength(5);
		expect(second?.[0]).toBe(developer);
		expect(second?.[1]).toBe(foreign);
		expect(second?.[2]).toBe(user);
		expect(second?.[3]).toBe(secondUser);
		const refreshed = ownMessages(second);
		expect(refreshed).toHaveLength(1);
		expect(injectedContent(refreshed[0])).toBe("second snapshot");

		expect(host.writes.sendMessage).toBe(0);
		expect(host.writes.appendEntry).toBe(0);
	});

	test("status while on displays current knowledge", async () => {
		const host = createHost();
		const knowledge = createKnowledge("line one\nline two");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, createCredits());

		await runCommand(host, "on", ctx);
		expect(knowledge.calls).toHaveLength(1);
		ctx.notices.length = 0;

		await runCommand(host, "status", ctx);
		expect(knowledge.calls).toHaveLength(2);
		expect(ctx.notices).toHaveLength(1);
		expect(ctx.notices[0]?.message).toBe("line one\nline two");
		expect(statusOf(ctx)).toBe("usage: line one");
	});

	test("off suppresses injection and strips an earlier projection without reads", async () => {
		const host = createHost();
		const knowledge = createKnowledge("current");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, createCredits());

		await runCommand(host, "on", ctx);
		const before = contextMessages(await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx));
		expect(ownMessages(before)).toHaveLength(1);
		expect(knowledge.calls).toHaveLength(2);

		await runCommand(host, "off", ctx);
		expect(knowledge.calls).toHaveLength(2);
		expect(statusOf(ctx)).toBeUndefined();
		expect(ctx.notices.at(-1)?.message).toContain("off");

		const after = contextMessages(await emit(host, "context", { messages: before ?? [] }, ctx.ctx));
		expect(ownMessages(after)).toHaveLength(0);
		expect(knowledge.calls).toHaveLength(2);
	});

	test("bare command toggles, repeated on is idempotent, invalid input leaves state", async () => {
		const host = createHost();
		const knowledge = createKnowledge("steady");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, createCredits());

		await runCommand(host, "", ctx);
		expect(knowledge.calls).toHaveLength(1);
		expect(statusOf(ctx)).toBe("usage: steady");

		await runCommand(host, "on", ctx);
		expect(knowledge.calls).toHaveLength(2);
		let injected = ownMessages(
			contextMessages(await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx)),
		);
		expect(injected).toHaveLength(1);

		await runCommand(host, "nonsense", ctx);
		expect(ctx.notices.at(-1)?.message).toContain("Usage:");
		expect(knowledge.calls).toHaveLength(3);
		injected = ownMessages(
			contextMessages(await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx)),
		);
		expect(injected).toHaveLength(1);
		expect(knowledge.calls).toHaveLength(4);

		await runCommand(host, "", ctx);
		expect(knowledge.calls).toHaveLength(4);
		expect(statusOf(ctx)).toBeUndefined();

		await runCommand(host, "", ctx);
		expect(knowledge.calls).toHaveLength(5);
		expect(statusOf(ctx)).toBe("usage: steady");
	});

	test("session start, switch, and branch reset enable state", async () => {
		for (const event of ["session_start", "session_switch", "session_branch"]) {
			const host = createHost();
			const knowledge = createKnowledge("current");
			const credits = createCredits("Estimated remaining: $40.00.");
			const ctx = createContext();
			usageAwareness(host.api, knowledge.read, credits);

			await runCommand(host, "on", ctx);
			expect(knowledge.calls).toHaveLength(1);
			expect(credits.describeCalls).toBe(1);
			expect(statusOf(ctx)).toBe("usage: current");
			ctx.notices.length = 0;

			await emit(host, event, {}, ctx.ctx);
			expect(knowledge.calls).toHaveLength(1);
			expect(credits.describeCalls).toBe(1);
			expect(credits.clearCalls).toEqual([undefined]);
			expect(credits.text).toBe("");
			expect(statusOf(ctx)).toBeUndefined();
			expect(ctx.notices).toHaveLength(0);

			const result = await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
			expect(ownMessages(contextMessages(result))).toHaveLength(0);
			expect(knowledge.calls).toHaveLength(1);

			await runCommand(host, "status", ctx);
			expect(ctx.notices.at(-1)?.message).toContain("off");
			expect(knowledge.calls).toHaveLength(1);

			await runCommand(host, "on", ctx);
			expect(knowledge.calls).toHaveLength(2);
			expect(ctx.notices.at(-1)?.message).not.toContain("Estimated remaining");
		}
	});

	test("off or a session switch while an enable read is pending suppresses the late result", async () => {
		for (const interruption of ["off", "session_switch"]) {
			const host = createHost();
			const pending = Promise.withResolvers<string>();
			const knowledge = createKnowledge(() => pending.promise);
			const credits = createCredits("Estimated remaining: $40.00.");
			const ctx = createContext();
			usageAwareness(host.api, knowledge.read, credits);

			const enabling = runCommand(host, "on", ctx);
			await Promise.resolve();
			expect(knowledge.calls).toHaveLength(1);
			expect(statusOf(ctx)).toBe("usage awareness: on");

			if (interruption === "off") await runCommand(host, "off", ctx);
			else await emit(host, "session_switch", {}, ctx.ctx);
			expect(statusOf(ctx)).toBeUndefined();

			pending.resolve("LATE QUOTA");
			await enabling;
			expect(ctx.notices.some(notice => notice.message.includes("LATE QUOTA"))).toBe(false);
			expect(credits.describeCalls).toBe(0);
			expect(statusOf(ctx)).toBeUndefined();

			const result = await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
			expect(ownMessages(contextMessages(result))).toHaveLength(0);
			expect(knowledge.calls).toHaveLength(1);
		}
	});

	test("off or a session switch while a context read is pending suppresses late injection", async () => {
		for (const interruption of ["off", "session_switch"]) {
			const host = createHost();
			const knowledge = createKnowledge("ready");
			const credits = createCredits("Estimated remaining: $40.00.");
			const ctx = createContext();
			usageAwareness(host.api, knowledge.read, credits);

			await runCommand(host, "on", ctx);
			expect(credits.describeCalls).toBe(1);
			const pending = Promise.withResolvers<string>();
			knowledge.set(() => pending.promise);

			const projecting = emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
			expect(knowledge.calls).toHaveLength(2);

			if (interruption === "off") await runCommand(host, "off", ctx);
			else await emit(host, "session_switch", {}, ctx.ctx);
			pending.resolve("LATE QUOTA");
			const result = await projecting;

			expect(ownMessages(contextMessages(result))).toHaveLength(0);
			expect(credits.describeCalls).toBe(1);
			expect(statusOf(ctx)).toBeUndefined();
			expect(knowledge.calls).toHaveLength(2);
		}
	});

	test("unreadable knowledge stays unknown, does not leak errors, and recovers later", async () => {
		const host = createHost();
		const knowledge = createKnowledge(async () => {
			throw new Error("boom secret-account-123");
		});
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, createCredits());

		await runCommand(host, "on", ctx);
		expect(ctx.notices.at(-1)?.message).toContain("unavailable");
		expect(ctx.notices.at(-1)?.message).not.toContain("boom");
		expect(ctx.notices.at(-1)?.message).not.toContain("secret-account-123");
		expect(statusOf(ctx)).toBe("usage awareness: on");

		const failed = await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
		expect(ownMessages(contextMessages(failed))).toHaveLength(0);
		expect(knowledge.calls).toHaveLength(2);

		knowledge.set("recovered");
		const recovered = await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
		const injected = ownMessages(contextMessages(recovered));
		expect(injected).toHaveLength(1);
		expect(injectedContent(injected[0])).toBe("recovered");
		expect(statusOf(ctx)).toBe("usage: recovered");
	});

	test("enabled status, context, and balance input append the credit estimate", async () => {
		const host = createHost();
		const knowledge = createKnowledge("model info\ncontext info");
		const credits = createCredits("Estimated remaining: $40.00.");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, credits);

		await runCommand(host, "on", ctx);
		expect(knowledge.calls).toHaveLength(1);
		expect(credits.describeCalls).toBe(1);
		const onNotice = ctx.notices.at(-1)?.message ?? "";
		expect(onNotice).toContain("model info");
		expect(onNotice).toContain("context info");
		expect(onNotice).toContain("Estimated remaining: $40.00.");
		expect(statusOf(ctx)).toBe("usage: model info");

		ctx.notices.length = 0;
		await runCommand(host, "status", ctx);
		expect(knowledge.calls).toHaveLength(2);
		expect(credits.describeCalls).toBe(2);
		expect(ctx.notices).toHaveLength(1);
		expect(ctx.notices[0]?.message).toContain("model info");
		expect(ctx.notices[0]?.message).toContain("Estimated remaining: $40.00.");

		const projected = ownMessages(
			contextMessages(await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx)),
		);
		expect(projected).toHaveLength(1);
		const projectedText = injectedContent(projected[0]) ?? "";
		expect(projectedText).toContain("model info");
		expect(projectedText).toContain("context info");
		expect(projectedText).toContain("Estimated remaining: $40.00.");
		expect(credits.describeCalls).toBe(3);

		credits.reminder = "Estimated low balance: $2.00 left.";
		ctx.notices.length = 0;
		await runCommand(host, "balance 30", ctx);
		expect(credits.setCalls).toHaveLength(1);
		expect(credits.setCalls[0]?.balance).toBe(30);
		expect(ctx.notices.some(notice => notice.message.includes("starting balance $30.00"))).toBe(true);
		expect(
			ctx.notices.some(
				notice => notice.message === "Estimated low balance: $2.00 left." && notice.type === "warning",
			),
		).toBe(true);
	});

	test("balance input while off stays off and reads only the local estimate", async () => {
		const host = createHost();
		const knowledge = createKnowledge("provider quota");
		const credits = createCredits("Estimated remaining: $40.00.");
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, credits);

		await runCommand(host, "balance 50", ctx);
		expect(knowledge.calls).toHaveLength(0);
		expect(credits.setCalls).toHaveLength(1);
		expect(credits.setCalls[0]?.balance).toBe(50);
		expect(credits.setCalls[0]?.lowThreshold).toBeUndefined();
		expect(credits.describeCalls).toBe(0);
		expect(statusOf(ctx)).toBeUndefined();
		const notice = ctx.notices.at(-1)?.message ?? "";
		expect(notice).toContain("starting balance $50.00");
		expect(notice).toContain("threshold $5.00");
		expect(notice).toContain("Estimated remaining: $50.00");

		const projected = await emit(host, "context", { messages: [userMessage("hi")] }, ctx.ctx);
		expect(ownMessages(contextMessages(projected))).toHaveLength(0);
		expect(knowledge.calls).toHaveLength(0);
		expect(statusOf(ctx)).toBeUndefined();

		credits.reminder = "LOW BALANCE REMINDER";
		await runCommand(host, "balance 50 20", ctx);
		expect(credits.setCalls[1]?.lowThreshold).toBe(20);
		expect(ctx.notices.some(entry => entry.message.includes("LOW BALANCE REMINDER"))).toBe(false);
		expect(ctx.notices.at(-1)?.message).toContain("threshold $20.00");

		await runCommand(host, "balance 0", ctx);
		expect(credits.setCalls[2]?.balance).toBe(0);
		expect(ctx.notices.at(-1)?.message).toContain("starting balance $0.00");
		expect(ctx.notices.at(-1)?.message).toContain("threshold $0.00");

		await runCommand(host, "balance 0.000001 0.0000005", ctx);
		expect(credits.setCalls[3]?.balance).toBe(0.000001);
		expect(ctx.notices.at(-1)?.message).toContain("starting balance $0.000001");
		expect(ctx.notices.at(-1)?.message).toContain("threshold $0.0000005");
	});

	test("invalid balance input and a missing model notify without reads or throws", async () => {
		const host = createHost();
		const knowledge = createKnowledge("provider quota");
		const credits = createCredits();
		const ctx = createContext();
		usageAwareness(host.api, knowledge.read, credits);

		for (const args of [
			"balance",
			"balance -1",
			"balance NaN",
			"balance Infinity",
			"balance 1e3",
			"balance 0x10",
			"balance 1 2 3",
			"balance clear extra",
		]) {
			await runCommand(host, args, ctx);
			expect(ctx.notices.at(-1)?.message).toContain("Usage:");
		}
		expect(credits.setCalls).toHaveLength(0);
		expect(credits.clearCalls).toHaveLength(0);
		expect(credits.describeCalls).toBe(0);
		expect(knowledge.calls).toHaveLength(0);
		expect(ctx.statuses).toHaveLength(0);

		await runCommand(host, "balance clear", ctx);
		expect(credits.clearCalls).toEqual(["test-provider"]);
		expect(ctx.notices.at(-1)?.message).toContain("cleared");
		expect(knowledge.calls).toHaveLength(0);

		const noModel = createContext(null);
		for (const args of ["balance 10", "balance clear"]) {
			await runCommand(host, args, noModel);
			expect(noModel.notices.at(-1)?.message).toContain("no active model provider");
		}
		expect(credits.setCalls).toHaveLength(0);
		expect(credits.clearCalls).toEqual(["test-provider"]);
		expect(knowledge.calls).toHaveLength(0);
	});

	test("agent_end catches a final-response low reminder from the local ledger", async () => {
		const host = createHost();
		const knowledge = createKnowledge("provider quota");
		const ctx = createContext();
		let startingBalance = 100;
		let lowThreshold = 10;
		let warned = false;
		const credits = {
			set(_ctx: ExtensionContext, balance: number, threshold?: number) {
				startingBalance = balance;
				lowThreshold = threshold ?? balance * 0.1;
				warned = false;
			},
			clear() {
				startingBalance = 100;
				lowThreshold = 10;
				warned = false;
			},
			describe(_ctx: ExtensionContext) {
				const remaining = startingBalance - ctx.usage.cost;
				const reminder =
					remaining <= lowThreshold && !warned
						? `Low balance estimate: ${remaining.toFixed(2)} USD remaining (estimate).`
						: undefined;
				if (reminder) warned = true;
				return {
					text: `Estimated remaining: ${remaining.toFixed(2)} USD (estimate from recorded session costs).`,
					reminder,
				};
			},
		};
		usageAwareness(host.api, knowledge.read, credits);

		await runCommand(host, "balance 100 10", ctx);
		expect(knowledge.calls).toHaveLength(0);
		ctx.notices.length = 0;

		await runCommand(host, "on", ctx);
		expect(knowledge.calls).toHaveLength(1);
		expect(ctx.notices.some(entry => entry.type === "warning")).toBe(false);

		// The final assistant response consumes the ledger after the last model call,
		// so only the settle handler can notice the crossing.
		ctx.usage.cost = 95;
		ctx.notices.length = 0;
		await emit(host, "agent_end", { messages: [], willContinue: false }, ctx.ctx);
		expect(knowledge.calls).toHaveLength(1);
		expect(ctx.notices).toHaveLength(1);
		expect(ctx.notices[0]?.type).toBe("warning");
		expect(ctx.notices[0]?.message).toContain("Low balance estimate");
		expect(ctx.notices[0]?.message).toContain("5.00");

		await emit(host, "agent_end", { messages: [], willContinue: false }, ctx.ctx);
		expect(ctx.notices).toHaveLength(1);
	});
});
