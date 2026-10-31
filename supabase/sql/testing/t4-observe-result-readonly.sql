-- TESTING ONLY. READ-ONLY. Run after inserting the test defect (pg_net keeps responses only for a few hours).
-- Shows only allowlisted fields of the function's JSON reply (success, message, sent, total); no headers, no secrets.
select r.id, r.status_code,
       (r.content::jsonb ->> 'success') as success,
       (r.content::jsonb ->> 'message') as message,
       (r.content::jsonb ->> 'sent')    as sent,
       (r.content::jsonb ->> 'total')   as eligible_recipients,
       r.created
from net._http_response r
where r.created > now() - interval '30 minutes'
  and r.content ~ '^\s*\{'
order by r.id desc
limit 5;
