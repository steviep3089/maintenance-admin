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
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplYmtzcmloc3d3d2xlamRpYm9xIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI4NjYwMCwiZXhwIjoyMDgwODYyNjAwfQ.N6iD3KJze3q_ooxHVyc-ld22aNZdra6lntNZTJ6a2oo'
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
