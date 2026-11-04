# InsiderOps Arkitekturregler

- **SDK'er**: Brug KUN officielle SDK'er (`@anthropic-ai/sdk` og `@google/genai`). Ingen LangChain/CrewAI.
- **Type-sikkerhed**: Al kommunikation mellem agenter og UI skal være strengt typet i `src/types/insider.ts`.
- **Tiered Multi-Model Arkitektur**:
  - **Claude Haiku (`CLAUDE_GATEKEEPER_MODEL`, standard `claude-haiku-5-5`)**: Gatekeeper (lag 1) med structured outputs og prompt caching (`src/lib/claude-gatekeeper.ts`). `GATEKEEPER_PROVIDER=gemini` skifter tilbage til Gemini.
  - **Gemini Flash (`GEMINI_FAST_MODEL`)**: Nordisk MAR 19-ekstraktion (og gatekeeper, når `GATEKEEPER_PROVIDER=gemini`). Auto-resolver til nyeste tilgængelige Flash-model.
  - **Claude Sonnet (`CLAUDE_SPECIALIST_MODEL`)**: Bruges til de 3 parallelle specialist-agenter (*The Profiler*, *The Catalyst Hunter*, *The Forensic Skeptic*) via `Promise.all`.
  - **Claude Opus (`CLAUDE_JUDGE_MODEL`)**: Bruges til *The Judge (Chief Investment Officer)* med adaptive thinking (`thinking: { type: 'adaptive', display: 'summarized' }`) og structured outputs.
- **Dynamisk Model-Resolver**: Auto-query af tilgængelige modeller via `models.list()` med in-memory cache forhindrer model 404-fejl på tværs af forskellige API-nøgler og tiers.
