alter table defects
  add column if not exists drive_file_id text,
  add column if not exists drive_file_url text;
