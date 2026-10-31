-- NOTE: the Authorization header below was REDACTED. This historical migration originally embedded a LIVE
-- service_role JWT (now retired/exposed; it remains in Git history). It is superseded by the HMAC-signed
-- notify_defect_created() in supabase/sql/notifications/. Do NOT run this file; it is kept only as migration history.

-- Enable pg_net extension for HTTP requests
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create a function to notify admins when a defect is created
CREATE OR REPLACE FUNCTION notify_defect_created()
RETURNS TRIGGER AS $$
DECLARE
  request_id bigint;
BEGIN
  -- Call the Supabase Edge Function asynchronously
  SELECT net.http_post(
    url := 'https://zebksrihswwwlejdiboq.supabase.co/functions/v1/notify-defect',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'REDACTED'
    ),
    body := jsonb_build_object(
      'id', NEW.id,
      'asset', NEW.asset,
      'title', NEW.title,
      'description', NEW.description,
      'priority', NEW.priority,
      'category', NEW.category,
      'status', NEW.status,
      'submitted_by', NEW.submitted_by,
      'created_at', NEW.created_at
    )
  ) INTO request_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to fire after defect insert
DROP TRIGGER IF EXISTS on_defect_created ON defects;
CREATE TRIGGER on_defect_created
  AFTER INSERT ON defects
  FOR EACH ROW
  EXECUTE FUNCTION notify_defect_created();
