# Meta Skill Benchmark Evidence

Date: 2026-04-13

## Goal

Evaluate whether external meta-skills are reliable enough to improve `Find Skills`, and record evidence before and after integrating a web fallback.

Compared methods:

1. `skills_find`: raw `npx -y skills find <query>`
2. `aether_live`: real `Find Skills` path via `POST /skill/search`
3. `multi_search_engine`: web-search style discovery based on the installed `multi-search-engine` skill

The installed meta-skill under evaluation is [.agents/skills/multi-search-engine/SKILL.md](/home/st_97142/Aether/.worktrees/skill-refresh/.agents/skills/multi-search-engine/SKILL.md).

## Test Method

### Query set

Eight representative queries were used:

1. `找个自动操作浏览器的skill`
2. `找一下论文润色的skill`
3. `科研绘图`
4. `translate technical docs`
5. `translate an academic manuscript`
6. `把学术写作改得更自然一些`
7. `make html slides for a talk`
8. `auto-updater`

### Scoring

Per query, `top5` was scored as:

- `2`: ideal hit present
- `1`: acceptable hit present
- `0`: miss

This benchmark is intentionally retrieval-oriented. It does not try to score explanation quality or install safety.

### Artifacts

- Baseline JSON: [meta-skill-bench.json](/tmp/meta-skill-bench.json)
- After-fallback JSON: [meta-skill-bench-after.json](/tmp/meta-skill-bench-after.json)

## Baseline Result

Before adding web fallback into `Find Skills`, the aggregate score was:

| Method | Total / 16 | Avg / 2 | Perfect | Partial | Miss |
| --- | ---: | ---: | ---: | ---: | ---: |
| `aether_live` | 12 | 1.50 | 5 | 2 | 1 |
| `skills_find` | 4 | 0.50 | 1 | 2 | 5 |
| `multi_search_engine` | 2 | 0.25 | 1 | 0 | 7 |

### Key baseline observations

1. `aether_live` was already the strongest path.
2. Raw `skills find` was weak for Chinese and semantic queries.
3. `multi_search_engine` was too noisy to be a primary skill-discovery source.
4. The main weak area for `aether_live` was translation.
5. `slides_en` had one timeout during the baseline run and was later rechecked separately.

### Representative baseline cases

#### Browser automation

- Query: `找个自动操作浏览器的skill`
- `skills_find`: `[]`
- `aether_live`: `agent-browser-automation`, `browser-automation`, `playwright-cli`
- `multi_search_engine`: `agent-browser`, `find-skills`, `ui-ux-pro-max`

Result:

- Raw `skills find` missed completely.
- `aether_live` correctly surfaced `playwright-cli`.
- `multi_search_engine` produced broad marketplace noise.

#### Paper polish

- Query: `找一下论文润色的skill`
- `skills_find`: `[]`
- `aether_live`: `paper-polish`, `paper-polish-workflow`, `manuscript`
- `multi_search_engine`: `find-skills`, `copywriting`, `pdf`

Result:

- `aether_live` clearly outperformed both alternatives.

#### Scientific visualization

- Query: `科研绘图`
- `skills_find`: `[]`
- `aether_live`: `scientific-visualization`, `plotly`, `figure-generation`
- `multi_search_engine`: `interface-design`, `brainstorming`, `find-skills`

Result:

- `aether_live` found direct-task skills.
- `multi_search_engine` again drifted toward general web noise.

#### Translation

- Query: `translate technical docs`
- `skills_find`: `en-explainer`, `engineering-terminology`, `translator`, `translation`
- `aether_live`: `rtl-document-translation`, `sync-translations`, `translation`, `article-translator`, `doc-i18n`
- `multi_search_engine`: `[]`

- Query: `translate an academic manuscript`
- `skills_find`: `scientific-manuscript-review`, `manuscript-review`, `q-methods`, `academic-translate`
- `aether_live`: `academic-translate`, `manuscript-review`, `scientific-manuscript-review`, `translate-polisher`
- `multi_search_engine`: `[]`

Result:

- This category was limited more by external source quality than by reranking.
- `aether_live` was better than raw `skills_find`, but still not ideal.

## Product Change

Based on the baseline evidence, `multi-search-engine` was **not** integrated as a replacement source.

Instead, a minimal web fallback was added to `Find Skills`:

1. Keep `npx skills find` as the primary external source.
2. Only when CLI recall is empty or weak, issue a `site:skills.sh <query>` web search.
3. Parse `skills.sh` links into external candidates.
4. Send those candidates through the existing Aether rerank/judge path.

Implementation landed in:

- [packages/opencode/src/skill/catalog.ts](/home/st_97142/Aether/.worktrees/skill-refresh/packages/opencode/src/skill/catalog.ts)
- [packages/opencode/src/skill/search.test.ts](/home/st_97142/Aether/.worktrees/skill-refresh/packages/opencode/src/skill/search.test.ts)
- [packages/opencode/test/server/skill-routes.test.ts](/home/st_97142/Aether/.worktrees/skill-refresh/packages/opencode/test/server/skill-routes.test.ts)

## After Integration

After adding the web fallback into `Find Skills`, the aggregate score was:

| Method | Total / 16 | Avg / 2 | Perfect | Partial | Miss |
| --- | ---: | ---: | ---: | ---: | ---: |
| `aether_live` | 14 | 1.75 | 6 | 2 | 0 |
| `skills_find` | 5 | 0.62 | 1 | 3 | 4 |
| `multi_search_engine` | 0 | 0.00 | 0 | 0 | 8 |

Important note:

- The `after` run used the actual product integration path, not a standalone multi-engine aggregator benchmark.
- `multi_search_engine` remained poor as a direct discovery method; the value came from using web search only as a fallback source inside `aether_live`.

### Key after-integration cases

#### HTML slides

- Query: `make html slides for a talk`
- `skills_find`: `pptx`, `marp`, `slidev`, `web-presentation`
- `aether_live`: `html-slides`, `claw-presentation-creator`, `giving-presentations`, `scientific-slides`, `web-presentation`

Result:

- This was the clearest product win from web fallback.
- Before fallback, this query had a timeout/miss path in the baseline.
- After fallback, `html-slides` became the top direct hit.

#### Translation docs

- Query: `translate technical docs`
- `aether_live`: `rtl-document-translation`, `sync-translations`, `translation`, `article-translator`, `doc-i18n`

Result:

- Still not ideal, but clearly usable.
- Fallback did not fully solve source-quality limits for translation, but it did keep the result set on-task.

#### Paper polish

- Query: `找一下论文润色的skill`
- `aether_live`: `paper-polish`, `paper-polish-workflow`, `manuscript`, `manuscript-review`, `scientific-manuscript-review`

Result:

- Existing strong behavior remained intact after the integration.

## Verification Commands

The relevant verification commands for the implementation were:

```bash
cd packages/opencode
bun typecheck
bun test src/skill/catalog.test.ts src/skill/search.test.ts src/skill/benchmark.test.ts test/server/skill-routes.test.ts
```

Additional targeted route verification used during implementation:

```bash
cd packages/opencode
bun test test/server/skill-routes.test.ts --test-name-pattern 'semantic search falls back to web skill discovery when cli recall is empty|semantic chinese paper polish search uses planned english discovery queries|semantic browser intent queries resolve to playwright automation|semantic translation prefers direct external hits over installed academic fallback'
```

## Final Conclusion

The evidence supports three conclusions:

1. `multi-search-engine` is **not** reliable enough to replace `skills find` as the main discovery engine.
2. `aether_live` is already the strongest path because it combines query planning, local/external merging, and reranking.
3. The right use of meta-search is as a **secondary web fallback**, not as the primary source of skill discovery.

That fallback improves real user outcomes, especially on cases where `skills find` returns weak or empty recall, while preserving the stronger parts of the existing `Find Skills` pipeline.
