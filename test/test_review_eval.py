import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import review_eval


class ReviewEval(unittest.TestCase):
    def test_split_time_kalender(self):
        tr = [dict(date='2024-01-10', R=1.0), dict(date='2024-01-20', R=-1.0), dict(date='2024-12-20', R=0.5)]
        self.assertEqual(review_eval.split_time(tr, '2024-01-01', '2024-12-31', 2), [0.0, 0.5])
        self.assertEqual(review_eval.split_time(tr, '2024-01-01', '2024-12-31', 3)[1], None)  # Drittel ohne Trade

    def test_parts_nach_trades(self):
        tr = [dict(R=r) for r in [1, 1, -1, -1, 0, 0]]
        self.assertEqual(review_eval.parts(tr, 3), [1.0, -1.0, 0.0])


if __name__ == '__main__':
    unittest.main()
