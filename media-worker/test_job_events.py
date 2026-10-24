import tempfile
import unittest
from pathlib import Path
from job_events import JobEvents

class JobEventsTest(unittest.TestCase):
    def test_existing_new_and_atomic_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'old'
            old.mkdir()
            (old / 'request.json').write_text('{}')
            events = JobEvents(root)
            try:
                self.assertEqual(events.wait(0), {old})
                self.assertEqual(events.wait(0), set())
                new = root / 'new'
                new.mkdir()
                (new / 'request.tmp').write_text('{}')
                (new / 'request.tmp').replace(new / 'request.json')
                self.assertEqual(events.wait(1), {new})
                (old / 'processing.json').write_text('{}')
                self.assertEqual(events.wait(0), set())
                (old / 'request.tmp').write_text('{"revision":2}')
                (old / 'request.tmp').replace(old / 'request.json')
                self.assertEqual(events.wait(1), {old})
            finally:
                events.close()

if __name__ == '__main__':
    unittest.main()
