# AGENTS.md — work efficiently on this repo

Token budget matters. This file lists the patterns that keep an agent
session from spiralling into thousands of tokens of file dumps and
guess-and-check refactors.

---

## 1. Discover before you read

```
✗ Read whole file just to see if a symbol exists
✓ Glob a likely path, OR Grep for the symbol name
```

Concrete examples:
- "Where's the dayWindow helper?" → `Grep dayWindow` (3 hits, 100 tokens)
  is better than reading every file in `apps/web/src/lib/`.
- "How big is Timeline?" → `wc -l apps/web/src/components/Timeline/*.tsx`
  is better than `Read Timeline.tsx`.

---

## 2. Read with `offset`/`limit` once you know roughly where the code is

A 300-line file you've never seen needs maybe two ranges, not the full
read:
1. First 50 lines for imports + module-level constants.
2. The function range you care about (`Grep -n` to find the line first).

The Read tool's default 2000-line cap is a maximum, not a target.

---

## 3. Edit vs Write

- **Edit** for changes < 30 lines. Single Edit call, surgical.
- **Write** for new files and full rewrites. Don't Edit your way through
  a rewrite when one Write is cleaner.

---

## 4. Typecheck = the cheapest test

Before commit, **always**:

```bash
cd apps/api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Both run in <5s and catch most regressions. No need to run vitest /
Playwright for refactors that don't touch behaviour.

---

## 5. The sandbox is not the user's Mac

- File tools (`Read`, `Edit`, `Write`) take macOS paths like
  `/Users/stasbazylevych/...`.
- Bash takes the mounted Linux path
  `/sessions/<session>/mnt/qwen3-coder/netronic-booking/...`.
- `git push`, `gh` CLI, `render` CLI, `netlify` CLI all need the user's
  credentials — they only work from THEIR Mac terminal. Don't try to push
  from the sandbox.

The sandbox CAN run typecheck, run vitest (if rollup/esbuild native
binaries are happy), inspect files, and write git commits. It CANNOT
push, deploy, or hit Render/Netlify/Neon APIs with the user's auth.

---

## 6. Don't read .lock files, .yaml-build artifacts, node_modules

If you `Glob '**/*.ts'` without filtering, you'll get back hundreds of
node_modules entries. Always exclude:

```
Glob 'apps/**/src/**/*.{ts,tsx}'      # source only
Glob 'apps/**/tests/**/*.ts'           # tests
```

For shell:
```bash
find apps -path '*/node_modules' -prune -o -type f -name '*.ts' -print
```

---

## 7. Don't re-explore on every turn

Once you've read a file in this session, **trust your context**. The
re-read tax (input tokens) is real. If you have to read again, use
`offset`/`limit` to grab only what changed.

---

## 8. Tasks are nearly free; use them

`TaskCreate` / `TaskUpdate` give the user a live progress view at
negligible token cost. Use them for any work involving more than 2
edits. Don't use them for tiny one-shots.

---

## 9. Trust but verify

When you finish a change, the verification is **typecheck**, not a
visual scan of your own diff. The TypeScript compiler will catch
9/10 things you'd miss.

For the cap-check, the verification is the **race test** in
`apps/api/tests/race.test.ts`, not "I think it looks right".

---

## 10. Common pitfalls (don't repeat these)

- **Don't replace `maxConcurrentDuring` with `COUNT(*)`.** That was a
  shipped prod bug ("8 of 5"). See ARCHITECTURE.md §7.
- **Don't add a `cd ../..` in `apps/web/netlify.toml`'s build command.**
  Netlify runs builds with cwd=repo-root, not packagePath.
- **Don't pass a pino instance as `logger:` to Fastify 5.** Use
  `loggerInstance:`. The error reads `logger options only accepts a
  configuration object`.
- **Don't omit `--prod=false` from the Render install.** The build needs
  devDependencies.
- **Don't copy-paste Tailwind class strings.** Add a `ui/` variant.
- **Don't add a long block comment narrating code.** JSDoc the function,
  delete the prose.
- **Don't reach for an external dep (cva, headless-ui, react-aria) without
  reason.** This app is small; weight matters.

---

## 11. When in doubt, ask one focused question

`AskUserQuestion` with 2–3 options is faster than a 4-paragraph
explanation followed by "is that what you want?". Reach for it whenever
a decision could go two reasonable ways.

---

## 12. Where to point the user

When ending a session, link to:
- `README.md §1` for setup.
- `README.md §9` for deploy.
- `CLAUDE.md` (this file's parent) for project context if they come back later.
- `.claude/ARCHITECTURE.md` for any "how should I add X" question.
