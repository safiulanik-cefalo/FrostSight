---
paths:
  - "tools/mock_dashboards/**"
  - "src/frostsight/serving.py"
  - "src/jobs/**"
  - "resources/**"
  - "**/*.lvdash.json"
  - "docs/plan/07_M6_product.md"
---

# Gold and dashboards

- Every live dashboard dataset is a select on one gold table: no joins, aggregation, ranking, window functions
  or distance maths in dashboard SQL (ADR-0009). The gold job builds one plot-ready table per widget group after
  every fetch; `src/frostsight/serving.py` is the reference implementation.
- Only values relative to the viewer's clock stay in the query, as one expression on that table: minutes ago,
  data age, whether an incident is still active, freshness delay and status.
- A new widget needs data the serving tables do not have: add a column or a table to `serving.py`, not a join
  to the dataset. `tests/unit/test_serving.py` fails otherwise; do not loosen it to make a query pass.
- The mock dashboard (`frostsight.mock`) and the dataset SQL in 07_M6 T6.4 before ADR-0009 compute at read time.
  They are not a pattern for live dashboards; if one conflicts with this rule, say so and follow the rule.
- Check a dashboard change against this rule, not only by "every dataset returns rows".
