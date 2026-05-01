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
 * Threshold for consecutive tool-validation errors before force-killing
 * kiro-cli. When the LLM context is near capacity, kiro-cli can enter a
 * loop of generating malformed tool calls (e.g. missing required fields).
 * These produce stderr output, so the idle timeout never fires. This
 * hard limit breaks the loop.
 */
const MAX_CONSECUTIVE_VALIDATION_ERRORS = 10;

/** Regex matching kiro-cli tool-validation error messages. */
const TOOL_VALIDATION_RE =
	/Tool '.*' validation failed|Tool validation failed/i;

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
				// Create a new process group so we can kill kiro-cli AND all
				// its child processes (tool subprocesses) in one signal.
				...(timeoutMs > 0 ? { detached: true } : {}),
			},
		);

		if (timeoutMs > 0) {
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			let consecutiveErrors = 0;
			let killed = false;

			const killProcess = () => {
				if (killed) return;
				killed = true;
				// Kill the entire process group (kiro-cli + child tool
				// processes).  The negative PID targets the group created
				// by `detached: true` above.  SIGKILL cannot be caught.
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					// Process already exited — ignore
				}
			};

			const resetTimer = () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(killProcess, timeoutMs);
			};

			// Drain stdout, forwarding to the terminal and resetting the idle
			// timer on each chunk.  Called in the background — never blocks the
			// return path.
			const drainStdout = async () => {
				if (!proc.stdout) return;
				try {
					for await (const chunk of proc.stdout) {
						process.stdout.write(chunk);
						resetTimer();
					}
				} catch {
					// Stream closed after kill — expected
				}
			};

			// Drain stderr, forwarding to the terminal.  Also watch for
			// tool-validation error storms: when kiro-cli's LLM is near its
			// context limit it can generate malformed tool calls in a tight
			// loop.  These produce stderr output (so the idle timer keeps
			// resetting) but make no forward progress.
			const drainStderr = async () => {
				if (!proc.stderr) return;
				try {
					for await (const chunk of proc.stderr) {
						const text = new TextDecoder().decode(chunk);
						process.stderr.write(chunk);

						if (TOOL_VALIDATION_RE.test(text)) {
							consecutiveErrors++;
							if (consecutiveErrors >= MAX_CONSECUTIVE_VALIDATION_ERRORS) {
								killProcess();
								return;
							}
						} else {
							consecutiveErrors = 0;
						}

						resetTimer();
					}
				} catch {
					// Stream closed after kill — expected
				}
			};

			resetTimer();

			// Race: process exits naturally vs idle timeout fires.
			// Stream draining runs in the background and does NOT block
			// the return — this prevents the hang where `proc.exited`
			// resolves but `forward()` is still blocked on `for await`
			// because a child process holds the pipe open.
			const drainPromise = Promise.all([drainStdout(), drainStderr()]);
			await Promise.race([
				proc.exited,
				new Promise<void>((resolve) => {
					const check = setInterval(() => {
						if (killed) {
							clearInterval(check);
							resolve();
						}
					}, 100);
				}),
			]);

			// Give streams a brief moment to flush remaining output after
			// natural exit, then force-kill if still draining.
			if (!killed) {
				await Promise.race([
					drainPromise,
					new Promise((r) => setTimeout(r, 2000)),
				]);
			}

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
