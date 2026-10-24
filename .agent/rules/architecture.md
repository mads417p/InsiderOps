# InsiderOps Arkitekturregler

- **SDK'er**: Brug KUN officielle SDK'er (`@anthropic-ai/sdk` og `@google/genai`). Ingen LangChain/CrewAI.
- **Type-sikkerhed**: Al kommunikation mellem agenter og UI skal være strengt typet i `src/types/insider.ts`.
- **Tiered Multi-Model Arkitektur**:
  - **Gemini Flash (`GEMINI_FAST_MODEL`)**: Bruges som lynhurtig, billig Gatekeeper/Parser og til nordisk MAR 19 ekstraktion. Auto-resolver til nyeste tilgængelige Flash-model.
  - **Claude Sonnet (`CLAUDE_SPECIALIST_MODEL`)**: Bruges til de 3 parallelle specialist-agenter (*The Profiler*, *The Catalyst Hunter*, *The Forensic Skeptic*) via `Promise.all`.
  - **Claude Opus (`CLAUDE_JUDGE_MODEL`)**: Bruges til *The Judge (Chief Investment Officer)* med **Extended Thinking** (`thinking: { type: 'enabled', budget_tokens: 2048 }`) for dyb strategisk syntese.
- **Dynamisk Model-Resolver**: Auto-query af tilgængelige modeller via `models.list()` med in-memory cache forhindrer model 404-fejl på tværs af forskellige API-nøgler og tiers.
