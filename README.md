# agentOS starter

A minimal server and client that run the Pi coding agent inside an agentOS VM.

## Install

```sh
bun install
```

## Run

Export an Anthropic, OpenRouter, OpenAI, or Gemini API key, then start the server and client in separate terminals:

```sh
export ANTHROPIC_API_KEY="..."
bun run server
```

```sh
bun run client
```

If multiple provider keys are set, choose one with `AGENTOS_PROVIDER=anthropic`, `openrouter`, `openai`, or `google`.

The client creates the named VM, starts a `pi` session, sends a prompt, prints Pi's response, and closes the session.

## End-to-end test

With one of the supported API keys set:

```sh
bun run test:e2e
```

The test starts the real registry server, waits for port 6420, runs the client against it, and requires the response marker `AGENTOS_ROUND_TRIP_OK`.

See the [agentOS documentation](https://agentos-sdk.dev/docs/) for sessions, software, permissions, persistence, and deployment.
