-- Allow deleting auth users by nulling defect created_by references.
ALTER TABLE public.defects
  DROP CONSTRAINT IF EXISTS defects_created_by_fkey;

ALTER TABLE public.defects
  ADD CONSTRAINT defects_created_by_fkey
  FOREIGN KEY (created_by)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;
