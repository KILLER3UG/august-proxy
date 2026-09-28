# Idea

August is a **local-first AI gateway and agentic workbench**.

One process on the user's machine that (a) speaks the OpenAI and Anthropic wire
formats so any client can be pointed at it, and (b) runs a real agent loop —
multi-round tool calls, sub-agents, sandboxed execution, durable memory — over
the user's own providers and files. The desktop app is the product; the proxy
APIs are the same engine exposed to other clients.

Two constraints define the design:

- **Local-first.** Keys, memory, sessions and skills stay on the user's disk.
  Nothing is invented about an upstream: a provider base URL is used exactly as
  pasted, and a quota or price is only shown when something actually stated it.
- **The harness must hold up on weak models.** Degradation is a first-class
  path — a model that misuses tools gets steered, downgraded to a smaller tool
  surface, and the turn still ends with an honest reason for what happened.

For the current shape of the product, read `README.md`. For the engineering
contract, read `AGENTS.md`.
