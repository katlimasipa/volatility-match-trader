# Add Frequency Strategy

## User-facing changes
- Add a new selectable Frequency strategy without changing Matches, Entry Match, or X2X behavior.
- Provide rolling digit-frequency analysis, absence/repetition streaks, and recent-sequence follow-up statistics, all based only on the selected market's ticks.
- Add settings for a 50–500 tick history window, minimum confidence, sequence sample minimum, automatic/manual target, and signal-only/automated execution.
- Show the selected market, digit frequencies and streaks, supported sequence patterns, current target/confidence, and signal outcomes.
- Reuse existing trade execution and risk controls for automated mode; signal-only mode never buys.

## Technical approach
- Add tested, pure strategy functions in `src/lib/frequency-strategy.ts` and keep orchestration/UI in the trading screen.
- Count sequence evidence chronologically; require the configured sample minimum. A missing qualified sequence or insufficient data cannot become an auto-trade signal.
- Define confidence as a transparent evidence score combining frequency support, streak context, and qualified sequence support; do not claim predictive profitability.
- Validate numeric rules with focused unit tests, then run the project test suite and inspect the preview build log.