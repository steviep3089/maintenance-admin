-- Add machine identifiers to plant assets for cross-portal lookup workflows.

alter table public.plant_assets
  add column if not exists serial_number text,
  add column if not exists machine_reg text;

create index if not exists idx_plant_assets_serial_number
  on public.plant_assets (serial_number);

create index if not exists idx_plant_assets_machine_reg
  on public.plant_assets (machine_reg);
