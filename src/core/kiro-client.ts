/**
 * @fileoverview Kiro CLI subprocess wrapper.
 * Provides a client interface for spawning kiro-cli chat sessions.
 * @module core/kiro-client
 */
import { AGENT_CONFIG_PATH, DEFAULT_AGENT_NAME } from "../utils/paths";

/**
 * Per-invocation hook environment passed to kiro-cli. These env vars let the
 * scripts in `.kiro/hooks/` emit structured per-turn artifacts (spawn marker,
 * stop marker) into a known run directory without having to parse the hook's
 * JSON stdin payload, which varies across Kiro versions.
 */
export interface HookEnv {
	/** Absolute path to the run's results dir (e.g. `results/<scout>/pw-*`). */
	runDir?: string;
	/** 1-based iteration number the runner is about to execute. */
	iteration?: number;
	/** Scout name, if this is a scout-scoped run. Empty string otherwise. */
	scoutName?: string;
}

/** Optional overrides passed per `runChat` invocation. */
export interface RunChatOptions {
	/** Hook env vars made available to `.kiro/hooks/*.sh` scripts. */
	hookEnv?: HookEnv;
	/**
	 * Working directory for the spawned kiro-cli subprocess. When set, Kiro
	 * discovers a sibling `.kiro/` tree here (agents, steering, hooks, MCP
	 * config, SQLite session history) which is how scout isolation works —
	 * each scout runs with its own cwd and therefore its own `.kiro/`.
	 */
	cwd?: string;
	/**
	 * Timeout in milliseconds for the kiro-cli subprocess.
	 * If the process does not exit within this time, it is killed and the
	 * call resolves with exit code 124 (same convention as the `timeout` CLI).
	 * Defaults to no timeout (0 = unlimited).
	 */
	timeoutMs?: number;
}

/**
 * Client for interacting with kiro-cli subprocess.
 * Wraps the kiro-cli chat command with the Ralph Wiggum agent.
 */
export class KiroClient {
	/** The agent name to use for kiro-cli */
	private agentName: string;

	/**
	 * Creates a new KiroClient instance.
	 * @param agentName - Optional agent name override. If not provided, uses the default Ralph Wiggum agent.
	 * @throws {Error} If the agent config file doesn't exist when using the default agent
	 */
	constructor(agentName?: string | null) {
		this.agentName = agentName ?? this.getDefaultAgentName();
	}

	/**
	 * Gets the default agent name, verifying the config file exists.
	 * @returns The default agent name
	 * @throws {Error} If the agent config file doesn't exist
	 */
	private getDefaultAgentName(): string {
		const configFile = Bun.file(AGENT_CONFIG_PATH);
		if (!configFile.size) {
			throw new Error(
				`Agent config not found at ${AGENT_CONFIG_PATH}\nRun 'ralph init' first to initialize Ralph Wiggum in this project.`,
			);
		}
		return DEFAULT_AGENT_NAME;
	}

	/**
	 * Run a kiro-cli chat session.
	 * @param prompt - The prompt to send to kiro-cli
	 * @param options - Optional per-invocation overrides (hook env, cwd).
	 * @returns Exit code from kiro-cli
	 */
	async runChat(prompt: string, options?: RunChatOptions): Promise<number> {
		const env = buildHookEnv(options?.hookEnv);

		const timeoutMs = options?.timeoutMs ?? 0;

		// Pass prompt as positional argument [INPUT], not via stdin
		const proc = Bun.spawn(
			[
				"kiro-cli",
				"chat",
				"--agent",
				this.agentName,
				"--no-interactive",
				"--trust-all-tools",
				prompt, // Positional argument for the input question
			],
			{
				// When idle timeout is active, pipe stdout/stderr so we can detect
				// activity. Otherwise inherit directly for real-time display.
				stdout: timeoutMs > 0 ? "pipe" : "inherit",
				stderr: timeoutMs > 0 ? "pipe" : "inherit",
				env,
				...(options?.cwd ? { cwd: options.cwd } : {}),
			},
		);

		if (timeoutMs > 0) {
			// Kill only when there has been NO output for timeoutMs.
			// This avoids killing slow-but-active tasks (compilation, large file
			// processing) while still catching truly hung tool calls.
			let idleTimer: ReturnType<typeof setTimeout> | undefined;

			const resetTimer = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => proc.kill(), timeoutMs);
			};

			const forward = async (
				stream: ReadableStream<Uint8Array>,
				dest: NodeJS.WriteStream,
			) => {
				for await (const chunk of stream) {
					dest.write(chunk);
					resetTimer();
				}
			};

			resetTimer();
			await Promise.all([
				proc.stdout ? forward(proc.stdout, process.stdout) : Promise.resolve(),
				proc.stderr ? forward(proc.stderr, process.stderr) : Promise.resolve(),
				proc.exited,
			]);
			clearTimeout(idleTimer);
			return proc.exitCode ?? 124;
		}

		await proc.exited;
		return proc.exitCode ?? 1;
	}
}

/**
 * Build the child-process env by layering RALPH_* hook vars onto the parent
 * process env. Exported for testing.
 */
export function buildHookEnv(hookEnv?: HookEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (!hookEnv) return env;

	// Bracket access required: NodeJS.ProcessEnv is an index-signature type
	// under TS strict (`noPropertyAccessFromIndexSignature`). Biome's
	// `useLiteralKeys` is disabled in biome.json to avoid the rule conflict.
	if (hookEnv.runDir !== undefined) {
		env["RALPH_RUN_DIR"] = hookEnv.runDir;
	}
	if (hookEnv.iteration !== undefined) {
		env["RALPH_ITERATION"] = String(hookEnv.iteration);
	}
	if (hookEnv.scoutName !== undefined) {
		env["RALPH_SCOUT_NAME"] = hookEnv.scoutName;
	}
	return env;
}
