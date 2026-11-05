Parser fixtures are trimmed excerpts of official Tmoney intercity responses captured in `.omo/evidence/provider/` on 2026-10-20. Layout and field ordering are preserved; unrelated navigation, style, detail markup, duplicate mobile rows, and most seat rows are omitted.

- `dispatch.html`: two departures from `intercity-dispatch.html`, plus one duplicate mobile row.
- `seats.html`: the first three of 28 seats from `intercity-seats.html`.
- `dispatch-empty.html`: provider's empty result for 서울남부 to 대전복합, 2026-10-20 after 23:59, preserving its empty-result row.

These fixed historical values test parsing only. They are not assertions about current prices, schedules, or availability.
