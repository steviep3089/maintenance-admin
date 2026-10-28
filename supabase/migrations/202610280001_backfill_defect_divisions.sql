-- Defects raised from the mobile app before regions were captured have no division_id.
-- Assign them to Sitebatch (as the original backfill did) so region filtering keeps them visible.
update public.defects d
set division_id = s.id
from (
  select id
  from public.divisions
  where lower(name) = 'sitebatch'
  limit 1
) s
where d.division_id is null;
