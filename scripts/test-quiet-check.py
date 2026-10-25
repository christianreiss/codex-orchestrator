#!/usr/bin/env python3
"""Regression checks for SQL sampling; no database or production access."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("quiet_check", Path(__file__).with_name("quiet-check.py"))
quiet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quiet)


class PreparedAccounting(unittest.TestCase):
    def test_binary_only_execution_and_new_instances_are_visible_without_literals(self):
        key = ("pointer", "1", "thread")
        before = {key: ("UPDATE control_plane_owner SET sequence=?", 8, 100)}
        after = {key: ("UPDATE control_plane_owner SET sequence=?", 11, 400),
                 ("new", "1", "other-thread"): ("SELECT 'private-value' FROM hosts", 2, 50)}
        rows = quiet.prepared_deltas(before, after, {"control_plane_owner", "hosts"})
        self.assertEqual(sum(row["count"] for row in rows), 5)
        self.assertEqual(rows[0]["tables"], ["control_plane_owner"])
        self.assertNotIn("private-value", str(rows))

    def test_disabled_instrumentation_cannot_claim_zero_sql(self):
        consumers = ["global_instrumentation\tYES", "thread_instrumentation\tYES", "statements_digest\tYES"]
        with patch.object(quiet, "sql", side_effect=[consumers, ["NO"]]):
            with self.assertRaises(RuntimeError):
                quiet.ensure_sql_observation()

    def test_noop_is_empty_and_reset_is_rejected(self):
        key = ("pointer", "1", "thread")
        value = {key: ("SELECT 1", 2, 100)}
        self.assertEqual(quiet.prepared_deltas(value, value, set()), [])
        with self.assertRaises(RuntimeError):
            quiet.prepared_deltas(value, {key: ("SELECT 1", 1, 100)}, set())


if __name__ == "__main__":
    unittest.main()
