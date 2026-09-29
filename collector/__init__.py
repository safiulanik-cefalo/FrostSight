"""Source collector. Runs outside Databricks and writes files into the landing volume.

It never imports Spark. See docs/adr/0004-external-collector.md and docs/plan/02_M1_history_and_reference_data.md.
"""
