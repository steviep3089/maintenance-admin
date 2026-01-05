-- Create a function to notify admins when a defect is created
CREATE OR REPLACE FUNCTION notify_defect_created()
RETURNS TRIGGER AS $$
BEGIN
  -- Call the Supabase Edge Function to send notifications
  PERFORM
    net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/notify-defect',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.supabase_anon_key')
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
    );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to fire after defect insert
DROP TRIGGER IF EXISTS on_defect_created ON defects;
CREATE TRIGGER on_defect_created
  AFTER INSERT ON defects
  FOR EACH ROW
  EXECUTE FUNCTION notify_defect_created();
