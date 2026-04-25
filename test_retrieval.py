import sys
sys.path.insert(0, 'qdrant')
from qdrant_service import retrieve_context

results = retrieve_context('what are the current projects')
print(f'Results: {len(results)}')
for r in results:
    print(f'  - [{r.get("type")}] {r.get("text")[:80]}')
