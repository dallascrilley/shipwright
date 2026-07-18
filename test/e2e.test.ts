import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const marker = "AGENTOS_ROUND_TRIP_OK";

function capture(child: ChildProcess, echo = false): () => string {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
    if (echo) process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
    if (echo) process.stderr.write(chunk);
  });
  return () => output.slice(-8_000);
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`agentOS server did not listen on port ${port}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("process timed out")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("server and client return a real Pi response", { timeout: 300_000 }, async () => {
  assert.ok(
    process.env.ANTHROPIC_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY,
    "an Anthropic, OpenRouter, OpenAI, or Gemini API key is required for the E2E test",
  );

  const server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOutput = capture(server, true);

  try {
    await waitForPort(6420, 30_000);

    const client = spawn(process.execPath, ["--import", "tsx", "client.ts"], {
      cwd: projectRoot,
      env: { ...process.env, AGENTOS_VM_NAME: `agentos-e2e-${Date.now()}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const clientOutput = capture(client, true);
    let exitCode: number | null;

    try {
      exitCode = await waitForExit(client, 240_000);
    } catch (error) {
      client.kill("SIGTERM");
      throw new Error(`client timed out:\n${clientOutput()}\nserver:\n${serverOutput()}`, {
        cause: error,
      });
    }

    assert.equal(exitCode, 0, `client failed:\n${clientOutput()}\nserver:\n${serverOutput()}`);
    assert.match(clientOutput(), new RegExp(marker), `missing response marker:\n${clientOutput()}`);
  } finally {
    server.kill("SIGTERM");
    try {
      await waitForExit(server, 30_000);
    } catch {
      server.kill("SIGKILL");
    }
  }
});
