CREATE TABLE studio_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conference_id uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
    template text NOT NULL CHECK (template IN ('banner', 'overlay', 'reel')),
    document jsonb NOT NULL CHECK (octet_length(document::text) <= 33554432),
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX studio_documents_event ON studio_documents(conference_id, updated_at DESC);
