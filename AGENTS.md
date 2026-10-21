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
- Strategy logic lives in `src/lib/matches.ts` as pure functions with tests; UI only calls it.
- Deriv Auth 2.0 + tokens live in `src/lib/deriv-auth.ts` and `src/lib/deriv-config.ts` (`VITE_DERIV_CLIENT_ID`, `VITE_DERIV_REDIRECT_URI`).
- Live buys and balance sync live in `src/lib/deriv-trading.ts` (OTP Auth 2.0 socket or classic authorize). The bot must place real DIGITMATCH contracts when connected — do not fake balances.
- Public tick feed stays on the public WebSocket; money movement uses the authorized trading session.
- On iOS installed PWA, prefer API token auth (Safari and the app do not share storage after OAuth).
