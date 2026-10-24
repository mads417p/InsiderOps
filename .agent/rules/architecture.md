# InsiderOps Arkitekturregler

- Brug KUN officielle SDK'er (`@anthropic-ai/sdk` og `@google/genai`). Ingen LangChain/CrewAI.
- Al kommunikation mellem agenter og UI skal være strengt typet i `src/types/insider.ts`.
- Gemini (`gemini-2.5-flash`) bruges som billig, hurtig Gatekeeper/Parser.
- Claude (`claude-3-7-sonnet-latest`) bruges til "The Council" (3 parallelle specialist-agenter via `Promise.all` efterfulgt af 1 Dommer-agent).
