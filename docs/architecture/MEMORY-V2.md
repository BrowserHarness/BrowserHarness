# BrowserHarness Memory v2: audit and architecture map

Phase 1 of the Memory v2 brief. Audited on 2026-10-06 against `main` at 9616c74 (PR #35 Spaces merged). Every row below was checked in the code; file paths are under `apps/extension/src/`.

## 1. What already exists

| Area | Where | Storage key | Scope before Memory v2 |
|---|---|---|---|
| Spaces (list, active, pin for background runs) | `runtime/spaces.ts` | `browserharness.spaces` | n/a |
| About me facts (explicit `/remember`, learned from patterns, learned by model `EXTRACT_FACTS`) | `runtime/about-me.ts` | `browserharness.aboutMe[@space]` | Per Space (key suffix) |
| Newer fact replaces older (`factTopic`: name, home, work, favourite X, currency…) | `runtime/about-me.ts` `addFacts` | same | Per Space. **Old fact is deleted, not kept as history** |
| Sensitive-data filter for facts | `about-me.ts` `SENSITIVE`, `instructions.ts` `SECRET_VALUE`, `skills.ts` `SECRET` | | Three separate regexes |
| Standing instructions (one free-text block) | `runtime/instructions.ts` | `browserharness.instructions[@space]` | Per Space only. **No "all Spaces" option** |
| Past conversations (task + answer + url) | `runtime/history.ts` | `browserharness.taskHistory[@space]` | Per Space |
| Recall of past conversations ("what did I find last week") | `runtime/recall.ts` `recallFor`, `/recall` | reads history | Per Space (via history) |
| Saved chats, follow-up context | `runtime/chats.ts` `chatContextPrompt` | `browserharness.chats[@space]` | Per Space |
| Task episodes (structured record of every agent run: sites, tools, targets, helper delegations with sources) | `runtime/task-memory.ts` | `browserharness.taskEpisodes.v1` | **Shared by all Spaces** |
| Episode embeddings + hybrid (word + meaning, RRF) search | `runtime/semantic-memory.ts` | `browserharness.taskEpisodeVectors.v1` | **Shared, searched across all Spaces** |
| Agent's `memory` tool (search/list/get/delete episodes, procedures, active working memory) | `background/service-worker.ts` `runTool("memory")` | | **Shared** |
| Skills (saved, recorded, imported SKILL.md, auto-learned) | `runtime/skills.ts`, `runtime/skill-learning.ts` | `browserharness.skills` | **Shared by all Spaces** |
| Auto Skill creation, Undo, lessons, improve/confirm | `skill-learning.ts` `planLearning` / `applyLearningPlan` | | Shared |
| Skill hint for similar requests | `skill-learning.ts` `matchSkill` | | **Matched across all Spaces** |
| Site Skills / procedural memory (site form + API recipes, revisions, promotion gates) | `runtime/site-skill-store.ts`, `runtime/procedural-memory.ts` | `browserharness.siteSkillLibrary.v2`, `browserharness.proceduralVectors.v1` | Shared (site knowledge, not about the person) |
| Recordings | `runtime/workflows.ts` | `browserharness.workflows` | Shared |
| Working memory (current goal, step, owned tabs, recent actions) | `runtime/working-memory.ts` | `chrome.storage.session` `browserharness.workingMemory.v1` | Per task session, temporary |
| Parallel helpers and Task DAG with verifier verdicts (`supported`/`contradicted`/`insufficient`) | `runtime/subagent-*.ts`, `runtime/task-dag.ts` | | Helper sources/tools kept in episode `delegations`; **DAG verdicts are not kept in episodes** |
| Scheduled tasks | `runtime/schedules.ts`, `runner.ts`, `runtime/scheduled-run.ts` | `browserharness.schedules` | Store `space_id`; runner `pinSpace()` |
| Chat-app (phone) tasks | `runner.ts` `runRemote` → `runUnattendedTask` | | **Used whatever Space was active at each read/write** |
| Settings UI for memory | `ui/MemoryView.tsx` (About you, Your wishes), `ui/settings/LearningPage.tsx`, `PrivacyPage.tsx`, `SpacesPage.tsx`, `ui/SkillsView.tsx`, `ui/HistoryView.tsx` | | |
| Tests | `about-me`, `recall`, `instructions`, `spaces`, `chats`, `task-memory`, `semantic-memory`, `procedural-memory`, `skills`, `skill-learning`, `working-memory` tests; smokes `spaces`, `memory`, `learning`, `self-learning`, `helpers` | | |

Storage is `chrome.storage.local` with `unlimitedStorage`; no database, no cloud. There is no schema-version framework beyond per-record `schema_version: 1` on episodes and `.v1/.v2` key names.

## 2. Gaps found (against the brief)

Leaks across Spaces (fixed in Phase 2, see section 3):
1. Task episodes, including helper findings and their sources, were saved without a Space and recalled into every task in every Space (`recallMemory` in `agent-task.ts`). The meaning search made this worse: a similar task in another Space ranked high.
2. Skills (including auto-learned ones) were offered and hinted in every Space.
3. The agent's `memory` and `skills` tools answered from all Spaces.
4. Space was resolved lazily at each read/write. A task whose person switched Space mid-run wrote its history, learned facts and Skills into the new Space. Phone tasks had no fixed Space at all.
5. Deleting a Space left its episodes behind; the shared 500-episode cap let one busy Space push out another's episodes.

Not yet done (later phases):
6. No "All Spaces" level: About me and instructions are per-Space only, so "My name is Neo" must be told to each Space (done in Phase 3, see 3b).
7. Supersession deleted the older fact; no `validFrom/validUntil/supersededBy`, no decisions (done in Phase 4, see 3c).
8. No Context Compiler: prompts are assembled by string concatenation in `App.tsx` and `scheduled-run.ts` (`instructionsPrompt + aboutMePrompt + recallPrompt + skillHint + chatContextPrompt`), with no authority ranking, token budget or diagnostics (Phase 5).
9. No candidate/dedupe/sensitivity pipeline shared by all writers; three separate secret regexes (Phase 6).
10. Page content: facts are only learned from the person's own typed message, never from pages (good), but nothing formally marks page-derived episode text as untrusted (Phase 6/8).
11. DAG verifier verdicts and worker ids are not carried into episodes; working memory has no Space (Phase 8).
12. Site Skills, procedural memory and recordings are still shared (deliberate for now, see 3.4).
13. Space backup/restore covers chats, notes, instructions and history only, not that Space's Skills and episodes (Phase 9).

## 3. Phase 2: hard Space scope (PR #38)

### 3.1 One wall, checked in one place
`runtime/memory-scope.ts` holds the scope model (`global | space | task | agent | skill`) and the single check, `visibleInSpace(record, spaceId)` / `withinSpace(records, spaceId)`. Records carry `space_id` and optionally `visibility: "all"`. A record with no `space_id` belongs to the first Space (Personal), matching how the first Space keeps the old storage keys.

### 3.2 Filter first, then search
`task-memory.ts` now loads all episodes once and applies `withinSpace` before any scoring. `searchTaskMemoryHybrid` builds both the word list and the meaning-search pool from that Space's episodes only, so embeddings can never reach across. The vector index itself is keyed by episode id and needs no change.

### 3.3 The Space is fixed when work starts, and travels with it
- Chat tasks (`ui/App.tsx`): the chat's Space is captured at the start of `runTask` and passed explicitly to About me, instructions, history, recall, Skills, `runAgentTask`, learning and history writes.
- `runAgentTask` takes a required `spaceId`. Parent recall, helper (worker) recall, the episode write, and every `BROWSER_TOOL` message (parent and helpers) carry it, so the agent's `memory` and `skills` tools answer from that Space.
- Scheduled tasks: unchanged pinning, plus `runUnattendedTask` resolves the Space once and passes it everywhere.
- Phone/chat-app messages record the Space in use when the message is accepted (`runtime/remote-queue.ts`, `space_id` on the queued request); the runner pins that Space. Requests queued before this change fall back to the Space in use when the runner starts.
- Calls with no task behind them (settings screens, coding agents through the Bridge) use the Space in use now.

### 3.4 Skills
`UserSkill` gains `space_id` and `visibility`. New Skills (saved, imported, auto-learned) belong to the Space they were made in. Skills saved before this change have neither field and are read as `visibility: "all"`, so nothing existing disappears. `/command` names stay unique across all Spaces. Deleting is limited to Skills the Space can see; auto-Skill pruning only touches the learning Space's own unused Skills. Site Skills and recordings stay shared: they describe how a website works rather than the person, and moving them needs the Phase 7 promotion/copy design.

### 3.5 Schema and migration
No stored data is rewritten. New fields are optional and read-time defaults handle old records: episodes without `space_id` → Personal; Skills without `space_id`/`visibility` → every Space. Deleting a Space now also removes its own episodes and Skills (`SPACE_TAGGED_KEYS` in `spaces.ts`), never shared ones. The episode cap (500) is now per Space.

### 3.6 Tests
`runtime/memory-scope.test.ts` (17 tests) and `runtime/remote-tasks.test.ts` (queued in Space A, switched to B, run stays in A): same-words and perfect-embedding matches never cross Spaces; get/delete limited to the asking Space; old episodes count as Personal; helper findings keep the parent's Space and sources; per-Space episode cap; Skill isolation, hint isolation, old Skills shared, no cross-Space delete, unique slugs, Space kept on update, per-Space pruning; notes, instructions and history written with an explicit Space while another is active; recall searches the current Space only; deleting a Space removes only its records. Breaking `visibleInSpace` makes 10 of them fail.

## 3b. Phase 3: facts and wishes for every Space (Phase 3 PR)
- New stores beside each Space's own: `browserharness.aboutMe.global` (facts) and `browserharness.instructions.global` (wishes). Nothing existing is moved: facts and wishes saved before Phase 3 stay in their Space (Personal for the old keys), so nothing is silently promoted.
- Level for a new fact (`about-me.ts` `factScopeIn`): this Space by default (the narrowest). Every Space only for who the person is (name, what to call them, where they live, language) or when they say so ("across all Spaces…", "generally…"). "For this project/Space…" always keeps it in the Space.
- A fact for every Space on the same topic also replaces the older one in the Space where it was said (so "I live in Mumbai" is not hidden by an older Personal "I live in Pune"). In the prompt, a Space's own fact wins over the every-Space fact on the same topic (`aboutMeFor`).
- Wishes: `scopedInstructionsPrompt` sends both, labelled "In every Space" and "In this Space (these win where the two disagree)"; with only one kind it reads exactly as before.
- One entry point for chat, scheduled and phone runs: `runtime/user-memory.ts` `userMemoryPrompt(spaceId)`.
- UI: About you shows "In this Space" and "In every Space" lists with an Every Space / Only this Space button on each fact, an "every Space" tick when adding, and two wish cards. Privacy has "Forget for every Space". `/remember` says "(in every Space)" when it saved there. `/forget <words>` only touches this Space; `/forget everywhere <words>` (or "across all Spaces") removes facts used in every Space. A plain `/forget` that only matches an every-Space fact deletes nothing and says how to remove it.
- Tests: `runtime/all-spaces-memory.test.ts` (15): scenarios 1 and 2 from the brief, level rules, Space-wins-on-topic, home change, move both ways, forget, secrets refused, Space deletion keeps every-Space facts, old data unchanged and unpromoted. Smokes: spaces (said-for-all-Spaces fact reaches Work), memory (wishes for every Space saved apart and sent).

## 3c. Phase 4: facts that change, and decisions (Phase 4 PR)

### Phase 3 status
Phase 3 merged as PR #39 with the `/forget` rule above: `/forget <words>` only touches this Space; `/forget everywhere <words>` or `/forget across all Spaces <words>` touches the every-Space facts; a plain `/forget` that matches only an every-Space fact deletes nothing and explains how.

### Temporal fact model
`AboutMeFact` (`runtime/about-me.ts`) is extended, not duplicated. New optional fields:
- `status`: `current | superseded | historical` (missing = current).
- `valid_from`, `valid_until`, `supersedes`, `superseded_by` (ids).
- `explicit_scope`: the fact was kept to this Space on purpose ("In this Space I am based in Delhi", "For this project…", added on the About you screen without the every-Space tick, or moved there with "Only this Space").
- `provenance`: `{ by: "you" | "learned", space_id, at, chat_id? }`. `by` is "you" for `/remember` and the About you screen, "learned" when picked up from the person's own message. `space_id` is the Space it was said in (also for every-Space facts). `chat_id` only when there was a chat. Facts saved before Phase 4 get no provenance: nothing is made up.

Both the current facts and the replaced ones live in the same array under the same key. Up to 60 current facts and the newest 100 replaced ones are kept per level.

### Supersession rules (`addFacts`)
- **A. Same level replaces same level.** Every-Space "I live in Pune", then every-Space "I live in Mumbai": Mumbai is current; Pune becomes `superseded`, `valid_until` = Mumbai's time, `superseded_by` = Mumbai's id; Mumbai `supersedes` Pune.
- **B. A Space fact overrides an every-Space fact only in that Space.** Every-Space USD plus Work INR: Work sees INR, other Spaces see USD, and USD is not superseded.
- **C. A new every-Space fact supersedes older narrower ones that were not kept apart on purpose.** In the Space where it was said: any topic. In other Spaces: only who the person is (name, nickname, home, language), because those were only ever kept per Space by accident (before Phase 3). A fact with `explicit_scope` is never superseded by an every-Space fact.
- Saying an old fact again makes it current again (a new record that supersedes the one in between).
- Editing a fact's wording on the About you screen is a correction, not a change in life: the same record keeps its id, `valid_from`, links, `explicit_scope` and provenance; `source` becomes "you"; `topic` is recomputed from the new words (and dropped when they no longer map to a known topic). If the corrected fact now shares a topic with another current fact at its level, that one is kept as replaced, so there is never more than one current fact per topic per level.
- Moving a fact between this Space and every Space ("Every Space" / "Only this Space") moves the same record. Its id, text, topic, `created_at`, `valid_from`, links and provenance are unchanged, and no replaced copy is left behind, so a move is never recorded as a change in life. `explicit_scope` is set when it moves into a Space and removed when it moves to every Space. Its older versions stay where they were and still point at it. `factLineage(id)` walks the line across both levels.
  - If the destination has a current fact on the same topic, the moved fact wins there and the other is kept as replaced as of the move. Moving to every Space also applies rule C.
  - If the destination already has exactly the same words, the destination record stays, and links to the moved record are pointed at it, so none are left dangling.
- `/forget` and Delete remove matching facts outright, current and replaced, at that one level.

### Decision model
`runtime/decisions.ts`, one store `browserharness.decisions.v1`, tagged with `space_id` and `visibility` and checked by the same `visibleInSpace` wall as episodes and Skills:

`{ id, type: "decision", subject, value, rationale?, scope: space | global, status: current | superseded | reversed | historical, created_at, valid_from, valid_until?, supersedes?, superseded_by?, space_id, visibility, provenance }`

- A new decision on the same subject at the same level supersedes the current one (subject compared ignoring case and "the/our/my"). Repeating the same value changes nothing. "Take back" marks it `reversed`.
- Decisions belong to the Space they were made in. A decision for every Space (`visibility: "all"`) is made only when said ("/decide everywhere …", "across all Spaces …", or the tick on the About you screen), and survives deleting the Space it was made in. A Space's own decision wins over an every-Space decision on the same subject there.
- Deleting a Space removes its own decisions (`SPACE_TAGGED_KEYS.decisions`).
- Ways in: `/decide <what>: <choice> [because …]` in the chat, and the "Your decisions" card on About you (add, take back, delete, earlier decisions).
- Decisions are kept apart from wishes (standing instructions): wishes say how to work; decisions record a choice and its history.

### Effective values and retrieval (`runtime/user-memory.ts`)
- `currentState(spaceId)`: current facts (this Space's own, then every-Space ones not overridden on the same topic) and current decisions (same precedence). Order of authority: this Space's current value, then the every-Space value, then history.
- `userMemoryPrompt(spaceId, request)` sends wishes, current facts and current decisions. Replaced facts and decisions are added only when the request asks about the past ("before", "previously", "used to", "what did we", "replaced"…), only the ones matching the question's words or topic (e.g. "live" for home), at most 5 each, under blocks labelled "NO LONGER TRUE" / "EARLIER DECISIONS". They are never presented as current.
- `earlierState(question, spaceId)`, `loadEarlierFacts`, `earlierDecisions(spaceId, subject?)` give the history directly.
- The About you screen shows "What used to be true" and "Earlier decisions" lists, each item deletable.

### Migration
None. Old facts have no `status` and read as current; nothing is rewritten on load. Old facts only change when a newer fact supersedes them (they are then marked, not deleted).

### Tests
`runtime/temporal-memory.test.ts` (16): Pune→Mumbai (prompt has Mumbai only, Pune kept with links and provenance), "where did I live before Mumbai?", previous currency, English→Hindi for every Space, Work INR over every-Space USD (USD not superseded), explicit "In this Space I am based in Delhi" survives two every-Space moves, old accidental local homes superseded in every Space, other topics in other Spaces untouched, About you choice for this Space kept, an old fact said again, `/forget` takes history too and only in its Space, pre-Phase-4 data loads unchanged, Forgejo→GitHub with history questions, decisions isolated per Space (including take-back/delete from another Space and Space deletion), every-Space decisions only when said, reversal/repeat/secret refusal. Memory smoke adds: only today's home goes with an ordinary request, the old home comes back for "Where did I live before Mumbai?", `/decide` replaces and the prompt carries only the decision in force, and About you shows both history lists.

### Remaining gaps
- Facts only supersede by known topic (`factTopic`: name, nickname, home, work, favourite X, currency, budget, timezone, language). Other changing facts ("I drive a Swift" → "I drive a Creta") pile up side by side until the Phase 6 candidate pipeline compares them.
- Decisions are only made on purpose (`/decide`, the card). They are not picked up from conversation yet.
- The agent's `memory` tool does not yet read facts or decisions; history reaches it only through the prompt.
- Space backup/restore covers About me (with history) but not that Space's decisions.
- History questions are matched by words; a question in other words may not find the old fact. The Context Compiler should do this selection properly.

## 4. Recorded follow-ups
1. Skills saved before Memory v2 have no scope and are read as `visibility: "all"`. Keep this for compatibility now; once the real All Spaces layer exists, give legacy/global Skills an explicit scope instead of relying on missing fields.
2. Episodes are capped per Space, but the episode vector index (`browserharness.taskEpisodeVectors.v1`, 500 entries) is still one global pool. Isolation holds (filtering runs before meaning ranking), but busy Spaces can churn each other's vectors. Address with the Context Compiler / memory-provider work.
3. Done in Phase 4: same-topic replacement now keeps the older fact as superseded history.
4. Decisions live in one store (`browserharness.decisions.v1`) with one overall cap of 300. One busy Space must eventually not be able to push out another Space's decision history: cap per Space (as episodes are) or keep current decisions outside the cap. This is the same kind of issue as follow-up 2.
5. Memory is stored in `chrome.storage.local` behind plain functions. To make it provider-ready (an external or synced memory store later), the Context Compiler should read through one interface (`currentState`, `earlierState`, episodes, Skills) rather than the stores directly.

## 5. Recommended next phases
- Phase 5: Context Compiler replacing the string concatenation (`userMemoryPrompt` + recall + Skill hint + chat context), with authority order (this Space > every Space > history), per-model token budget, selection of what is useful for the request, and a diagnostics record of what was sent and why.
- Then: shared candidate/dedupe/sensitivity pipeline (Phase 6), Skill scope promotion (Phase 7), task/agent records (Phase 8), backup of tagged records (Phase 9).
