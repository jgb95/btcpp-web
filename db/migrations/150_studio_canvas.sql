ALTER TABLE studio_documents DROP CONSTRAINT studio_documents_template_check;
ALTER TABLE studio_documents ADD CONSTRAINT studio_documents_template_check
    CHECK (template IN ('banner', 'overlay', 'reel', 'canvas'));
