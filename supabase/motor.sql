-- Motor del simulador ↔ Supabase (correr después de schema.sql; se puede volver a correr)
-- El motor (desafio-simulador/plataforma) lee el simulador, publica expedientes en la cola,
-- toma las firmas de la app y manda las órdenes a los proveedores del simulador.

alter table jueces add column if not exists juez_sim_id text unique;     -- id del juez en datos/juzgados.json

alter table expedientes add column if not exists exp_sim_id text unique;  -- EXP-… o RE-… del motor
alter table expedientes add column if not exists reincidente boolean not null default false;

alter table ordenes add column if not exists proveedor text;
alter table ordenes add column if not exists orden_sim_id text;           -- orden_id vigente en el proveedor
alter table ordenes add column if not exists vence_min int;
alter table ordenes add column if not exists estado_proveedor text;       -- recibida / aplicada / fallida / vencida / levantada / no_aplicable
alter table ordenes add column if not exists intentos int not null default 0;
alter table ordenes add column if not exists aplicada_min numeric;
alter table ordenes add column if not exists firmada_por text;

alter table reclamos add column if not exists rec_sim_id text unique;
alter table reclamos add column if not exists verificacion jsonb;
alter table reclamos add column if not exists decidido_por uuid references jueces(id);
alter table reclamos add column if not exists decidido_at timestamptz;

-- El juez ve el estado de las órdenes de su jurisdicción en cada proveedor
drop policy if exists ordenes_lectura on ordenes;
create policy ordenes_lectura on ordenes for select using (
  exists (select 1 from expedientes e join turnos t on t.jurisdiccion = e.jurisdiccion
          where e.id = ordenes.expediente_id and t.juez_id = auth.uid()));

-- El juez de turno ve y resuelve los reclamos
drop policy if exists reclamos_juez_lee on reclamos;
create policy reclamos_juez_lee on reclamos for select using (
  exists (select 1 from turnos t where t.juez_id = auth.uid() and now() between t.desde and t.hasta));
drop policy if exists reclamos_juez_decide on reclamos;
create policy reclamos_juez_decide on reclamos for update using (
  estado = 'pendiente' and
  exists (select 1 from turnos t where t.juez_id = auth.uid() and now() between t.desde and t.hasta))
  with check (decidido_por = auth.uid() and estado in ('aceptado', 'rechazado'));

-- Realtime: se agregan solo si todavía no están (así el script se puede volver a correr)
do $$
declare t text;
begin
  foreach t in array array['ordenes', 'reclamos'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
