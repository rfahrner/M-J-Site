# Delete from Accounting

Right-click any load row on any Accounting location tab and choose **Delete from Accounting**. The existing identifier Copy actions share that menu. Confirmation names the load and states that it stays on its source board.

The checked save sets `loads_accounting.hidden=true`, `status='deleted'`, and `deleted_at`. Pending rate edits finish first. The sheet and its driver totals omit hidden records. The Accounting record, source links, amounts, and routes are retained; the source board is untouched. Existing nightly transfers skip loads that already have their linked Accounting record, so the removal is not undone by a later sweep.

`zz_keep_removed_accounting_deleted` runs after the existing money/cancellation triggers. It preserves the removed record's status and financial values when a board push or cancellation later addresses it, while allowing source foreign-key cleanup. It does not change ordinary records. Board-deleted records that were not removed through Accounting retain their existing struck-through display and Restore action.

Future archival copies the removal marker into `analytics_financial_history.accounting_removed`. The financial history view reports those records as deleted too, preventing removed revenue from returning after live-record purging. Existing archived rows default to their previous active status.

No existing rows are removed when the migration is installed. The user action changes one Accounting row. For recovery, inspect the retained record and explicitly clear `hidden`, `deleted_at`, and choose the appropriate status; preserve its original money and billing flags. Do not re-push the source load to undo removal.

Validation: `scripts/accounting-row-delete.test.mjs` exercises the real deletion handler, RLS, existing money/cancellation triggers, retained source/route records, automatic-transfer eligibility, and future archival. `sandbox/accounting-row-delete.spec.mjs` exercises real browser right-clicks on all five tabs, cancellation, a denied save, pending edits, refresh and reload using synthetic data.
