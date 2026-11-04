# CLAUDE.md — InsiderOps

@AGENTS.md

Projektregler: se `.agent/rules/architecture.md` og README.md. Kør altid `npx tsc --noEmit` efter kodeændringer.

## Synk-protokol (fælles hukommelse)

MCP: https://viden.kirkegaard-consulting.dk/mcp — vault-projekt-id: `insiderops`

Brug ALTID viden-MCP'en som fælles hukommelse. Ikke "husk at synke" – følg dette konkret:

**START (før noget andet):** `get_vault_summary`, derefter `get_note("loebende-synk-med-vaulten")` og følg dens trigger-tabel hele samtalen. Hvis arbejdet hører til et projekt/kunde: `get_context`. Søg `tag:skill-kim` for at genkende fremgangsmåder, der er set før.

**UNDERVEJS – skriv i det øjeblik det sker, aldrig "til sidst":**
- nyt ord/forkortelse/produkt → `define(type: term)` med aliases
- problem der tog >2 forsøg → `create_note(type: knowledge)`, symptom først
- en note var forkert/manglede noget → `record_learning` på DEN note
- idé eller halv tanke → `capture_thought`
- fremgangsmåde der kan beskrives som trin, eller ses 2. gang → `capture_thought` tagget `skill-kim`; 3. gang → `promote_thought(skill)`
- brugt en skill og noget manglede → `update_skill`
- beslutning/leverance i projekt eller kunde → `log_activity`
- to noter hænger sammen → `add_link`

Efter hver afsluttet delopgave og senest hver ~10 tool-kald: stop og tjek listen. Skriv én linje i chatten om hvad der blev synket.

**SLUT:** sidste handling er ALDRIG et svar – det er en synk-runde efter listen ovenfor, derefter `log_activity`.

Kun tool-kald tæller som synk. En opsummering i chatten er ikke synk.
