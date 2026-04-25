import os
import re
from pathlib import Path
try:
    from dotenv import load_dotenv
except Exception:
    def load_dotenv(*args, **kwargs):
        return False
from mock import data as mock_data

try:
    from qdrant_client import QdrantClient
    from qdrant_client.http.models import PointStruct, Document
except Exception:
    QdrantClient = None
    PointStruct = None
    Document = None

# Load .env from parent directory (project root)
_env_path = Path(__file__).resolve().parent.parent / '.env'
load_dotenv(_env_path)

QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")

client = None
if QdrantClient and QDRANT_URL and QDRANT_API_KEY:
    client = QdrantClient(
        url=QDRANT_URL,
        api_key=QDRANT_API_KEY,
        cloud_inference=True,
    )

# INSERT DATA (INGESTION)
def insert_data(data):
    if not client:
        print("WARN: Qdrant cloud client unavailable. Skipping remote ingestion.")
        return

    points = []

    for i, item in enumerate(data):
        points.append(
            PointStruct(
                id=i,
                payload=item,
                vector={
                    "text_vector": Document(
                        text=item["text"],
                        model="sentence-transformers/all-minilm-l6-v2"
                    )
                }
            )
        )

    client.upsert(
        collection_name="voxflow",
        points=points
    )


# RETRIEVE DATA
def retrieve_context(query: str):
    if client and Document:
        try:
            results = client.query_points(
                collection_name="voxflow",
                query=Document(
                    text=query,
                    model="sentence-transformers/all-minilm-l6-v2"
                ),
                using="text_vector",
                limit=3
            )
            return [p.payload for p in results.points]
        except Exception as e:
            print(f"WARN: Qdrant Cloud fetch failed: {e}")
            print("INFO: Falling back to local mock data gracefully.")

    # Local fallback: retrieve from mock data in this folder.
    normalized_query = query.lower()
    query_tokens = set(re.findall(r"\w+", normalized_query))
    singular_tokens = {t[:-1] if t.endswith("s") else t for t in query_tokens}
    all_tokens = query_tokens | singular_tokens

    wants_blockers = any(t in all_tokens for t in {"blocker", "blocked", "blocking"})
    wants_decisions = any(t in all_tokens for t in {"decision", "decide", "decided"})
    wants_deadlines = any(t in all_tokens for t in {"deadline", "due", "schedule"})

    if not query_tokens:
        return mock_data[:3]

    scored = []
    for item in mock_data:
        text_tokens = set(re.findall(r"\w+", item.get("text", "").lower()))
        overlap = len(all_tokens & text_tokens)
        item_type = item.get("type", "").lower()
        type_boost = 1 if item_type in all_tokens else 0
        if wants_blockers and item_type == "blocker":
            type_boost += 5
        if wants_decisions and item_type == "decision":
            type_boost += 5
        if wants_deadlines and item_type == "deadline":
            type_boost += 5
        score = overlap + type_boost
        if score > 0:
            scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:3]]