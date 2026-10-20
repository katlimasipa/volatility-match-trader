<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project rules
- Strategy logic lives in src/lib/matches.ts as pure functions with tests; UI only calls it. Why: rules must stay testable.
- Deriv app ID and auth hooks live in src/lib/deriv-config.ts (VITE_DERIV_APP_ID). Why: single place to wire Deriv Auth later.
- Trades are simulated until Deriv auth is connected. Why: no real orders without an account token.
