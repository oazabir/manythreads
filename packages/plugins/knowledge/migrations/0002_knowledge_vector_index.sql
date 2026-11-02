-- knowledge 0002: the vector index for passages that have an embedding (PLAN P8-07). Forward-only: never edit once applied.
--
-- `embedding` is filled only when a workspace has an `embed` alias (docs/plans/support-email-journey.md D5: lexical search first, embeddings never
-- required), so most deployments hold no vectors at all. The index is therefore partial: it covers only rows that have a vector, costs nothing while
-- the column is empty, and is ready the day a passage gets one. Cosine distance matches how the 768-dimension vectors are compared.

CREATE INDEX knowledge_chunks_embedding ON app.knowledge_chunks USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
